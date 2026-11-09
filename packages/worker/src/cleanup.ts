import { canonicalJson, objectRefSchema, showIdPattern, type ObjectRef } from "@castloop/domain";
import { assertSourceOwnership } from "./objects";
import { IdentityConflict, readShowControl } from "./storage";
import type { EpisodeRecord } from "./show";

interface Asset {
  record_version: 1; episode_id: string | null; kind: "show_toml" | "episode_toml" | "audio" | "cover" | "maintenance";
  operation_id: string; ref: ObjectRef; stored_at: number; state: "present" | "delete_claimed" | "deleted" | "missing"; claim_operation_id: string | null;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validRequest(showId: string, operationId: string, refs: ObjectRef[]): void {
  if (!showIdPattern.test(showId) || !uuid.test(operationId) || !Array.isArray(refs) || refs.length > 100 || !refs.length) throw new IdentityConflict("Invalid cleanup request");
  const keys = new Set<string>();
  for (const ref of refs) {
    if (!objectRefSchema.safeParse(ref).success || keys.has(ref.key)) throw new IdentityConflict("Invalid or duplicate cleanup object");
    keys.add(ref.key);
  }
}

/** Atomically retire only old, attributable sources that no live work needs. */
export function claimCleanup(storage: DurableObjectStorage, showId: string, operationId: string, refs: ObjectRef[], olderThanDays: number, now = Date.now()) {
  validRequest(showId, operationId, refs);
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays <= 0 || !Number.isSafeInteger(now) || now < 0) throw new IdentityConflict("Invalid cleanup age");
  const cutoff = now - olderThanDays * 86400000;
  if (!Number.isSafeInteger(cutoff)) throw new IdentityConflict("Invalid cleanup cutoff");
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const control = readShowControl(storage, showId);
    const protectedKeys = new Set<string>();
    const withdrawingEpisodes = new Set<string>();
    const protect = (ref: unknown) => { const parsed = objectRefSchema.safeParse(ref); if (!parsed.success) throw new IdentityConflict("Protected source reference is inconsistent"); protectedKeys.add(parsed.data.key); };
    if (control && !control.deleted) {
      if (!control.metadata) throw new IdentityConflict("Selected show source is missing");
      protect(control.metadata);
      if (control.cover) protect(control.cover.ref);
      for (const row of sql.exec<{ episode_id: string; record_json: string }>("SELECT episode_id, record_json FROM episodes").toArray()) {
        const episode = JSON.parse(row.record_json) as EpisodeRecord;
        if (episode.episode_id !== row.episode_id || typeof episode.deleted !== "boolean") throw new IdentityConflict("Episode source selection is inconsistent");
        if (!episode.deleted) { protect(episode.metadata); if (episode.audio) protect(episode.audio.ref); }
        else {
          const outcome = sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", episode.episode_id).toArray()[0];
          if (outcome?.state !== "applied") withdrawingEpisodes.add(episode.episode_id);
        }
      }
    }
    for (const row of sql.exec<{ record_json: string }>("SELECT record_json FROM delivery_refs").toArray()) {
      const value = JSON.parse(row.record_json) as { sources?: unknown };
      if (!Array.isArray(value.sources)) throw new IdentityConflict("Delivery sources are inconsistent");
      for (const ref of value.sources) protect(ref);
    }
    for (const row of sql.exec<{ object_key: string }>("SELECT DISTINCT object_key FROM source_pins").toArray()) protectedKeys.add(row.object_key);
    const withdrawal = control?.deleted ? sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0] : undefined;
    const incompleteWithdrawal = !!control?.deleted && withdrawal?.state !== "applied";
    const claimed: ObjectRef[] = [];
    const skipped: { key: string; reason: string }[] = [];
    for (const ref of refs) {
      const row = sql.exec<{ state: string; claim_operation_id: string | null; record_json: string }>("SELECT state, claim_operation_id, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
      if (!row) { skipped.push({ key: ref.key, reason: "unregistered" }); continue; }
      let asset: Asset;
      try {
        asset = JSON.parse(row.record_json) as Asset;
        if (asset.record_version !== 1 || asset.state !== row.state || asset.claim_operation_id !== row.claim_operation_id || canonicalJson(asset.ref) !== canonicalJson(ref) || !Number.isSafeInteger(asset.stored_at) || asset.stored_at < 0) throw new Error();
        if (asset.kind === "episode_toml" || asset.kind === "audio") {
          if (!asset.episode_id) throw new Error();
          assertSourceOwnership(ref.key, { kind: asset.kind, showId, episodeId: asset.episode_id, operationId: asset.operation_id });
        } else {
          if (asset.episode_id !== null || !["show_toml", "cover", "maintenance"].includes(asset.kind)) throw new Error();
          assertSourceOwnership(ref.key, { kind: asset.kind, showId, operationId: asset.operation_id });
        }
      } catch { skipped.push({ key: ref.key, reason: "identity_or_ownership_uncertain" }); continue; }
      if (row.state === "delete_claimed" && row.claim_operation_id === operationId) { claimed.push(ref); continue; }
      if (row.state !== "present") { skipped.push({ key: ref.key, reason: "already_retired_or_missing" }); continue; }
      if (asset.stored_at >= cutoff) { skipped.push({ key: ref.key, reason: "too_recent" }); continue; }
      if (incompleteWithdrawal || (asset.episode_id !== null && withdrawingEpisodes.has(asset.episode_id)) || protectedKeys.has(ref.key)) { skipped.push({ key: ref.key, reason: "protected" }); continue; }
      asset.state = "delete_claimed";
      asset.claim_operation_id = operationId;
      sql.exec("UPDATE source_assets SET state = 'delete_claimed', claim_operation_id = ?, record_json = ? WHERE object_key = ?", operationId, JSON.stringify(asset), ref.key);
      claimed.push(ref);
    }
    return { claimed, skipped };
  });
}

/** Complete only claims whose object is observed absent; uncertain claims persist. */
export async function completeCleanup(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, operationId: string, refs: ObjectRef[]) {
  validRequest(showId, operationId, refs);
  const absent = new Set<string>();
  for (const ref of refs) {
    const row = storage.sql.exec<{ state: string; claim_operation_id: string | null; record_json: string }>("SELECT state, claim_operation_id, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
    if (!row || !["delete_claimed", "deleted"].includes(row.state) || row.claim_operation_id !== operationId) continue;
    const asset = JSON.parse(row.record_json) as Asset;
    if (asset.state !== row.state || asset.claim_operation_id !== operationId || canonicalJson(asset.ref) !== canonicalJson(ref)) continue;
    if (row.state === "deleted" || !(await bucket.head(ref.key))) absent.add(ref.key);
  }
  return storage.transactionSync(() => {
    const completed: string[] = [];
    for (const ref of refs) {
      if (!absent.has(ref.key)) continue;
      const row = storage.sql.exec<{ state: string; claim_operation_id: string | null; record_json: string }>("SELECT state, claim_operation_id, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
      if (!row || !["delete_claimed", "deleted"].includes(row.state) || row.claim_operation_id !== operationId) continue;
      const asset = JSON.parse(row.record_json) as Asset;
      if (asset.state !== row.state || asset.claim_operation_id !== operationId || canonicalJson(asset.ref) !== canonicalJson(ref)) continue;
      asset.state = "deleted";
      storage.sql.exec("UPDATE source_assets SET state = 'deleted', record_json = ? WHERE object_key = ?", JSON.stringify(asset), ref.key);
      completed.push(ref.key);
    }
    return { completed, unresolved: refs.filter(ref => !completed.includes(ref.key)).map(ref => ref.key) };
  });
}

/** Resolve exact claims from the ledger; callers never supply an object identity at completion. */
export async function completeCleanupKeys(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, operationId: string, keys: string[]) {
  if (!showIdPattern.test(showId) || !uuid.test(operationId) || !Array.isArray(keys) || !keys.length || keys.length > 100 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== "string" || !key)) throw new IdentityConflict("Invalid cleanup completion");
  const refs: ObjectRef[] = [];
  for (const key of keys) {
    const row = storage.sql.exec<{ state: string; claim_operation_id: string | null; record_json: string }>("SELECT state, claim_operation_id, record_json FROM source_assets WHERE object_key = ?", key).toArray()[0];
    if (!row || !["delete_claimed", "deleted"].includes(row.state) || row.claim_operation_id !== operationId) continue;
    const asset = JSON.parse(row.record_json) as Asset;
    const ref = objectRefSchema.safeParse(asset.ref);
    if (ref.success && ref.data.key === key && asset.state === row.state && asset.claim_operation_id === operationId) refs.push(ref.data);
  }
  const result = refs.length ? await completeCleanup(storage, bucket, showId, operationId, refs) : { completed: [], unresolved: [] };
  return { deleted: result.completed, unresolved: keys.filter(key => !result.completed.includes(key)).map(key => ({ key, issues: ["Claim does not belong to this operation or object remains present"] })) };
}
