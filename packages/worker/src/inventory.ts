import { canonicalJson, episodeIdPattern, objectRefSchema, showIdPattern, type ObjectRef } from "@castloop/domain";
import { assertSourceOwnership } from "./objects";
import { IdentityConflict } from "./storage";

function owner(key: string, showId: string) {
  const parts = key.split("/");
  if (parts[0] !== showId) throw new Error("Show ownership mismatch");
  const episode = episodeIdPattern.test(parts[1] ?? "") ? parts[1]! : null;
  const index = episode ? 2 : 1;
  if (parts.length !== index + 3) throw new Error("Unrecognized object path");
  const operationId = parts[index + 1]!;
  const filename = parts[index + 2]!;
  const kind = parts[index] === "_maintenance" && !episode ? "maintenance"
    : parts[index] !== "_versions" ? null
    : episode ? filename === "episode.toml" ? "episode_toml" : filename === "audio.mp3" ? "audio" : null
    : filename === "show.toml" ? "show_toml" : "cover";
  if (!kind) throw new Error("Unrecognized object name");
  if (kind === "episode_toml" || kind === "audio") assertSourceOwnership(key, { kind, showId, operationId, episodeId: episode! });
  else assertSourceOwnership(key, { kind, showId, operationId });
  return { kind, episodeId: episode, operationId };
}

/** Inspect unregistered objects without selecting or publishing any source. */
export async function registerInventory(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, refs: ObjectRef[]) {
  if (!showIdPattern.test(showId) || !Array.isArray(refs) || !refs.length || refs.length > 100 || new Set(refs.map(ref => ref.key)).size !== refs.length) throw new IdentityConflict("Invalid inventory request");
  const inspected: { ref: ObjectRef; details: ReturnType<typeof owner>; storedAt: number }[] = [];
  const skipped: { key: string; issues: string[] }[] = [];
  for (const ref of refs) {
    try {
      objectRefSchema.parse(ref);
      const details = owner(ref.key, showId);
      const object = await bucket.head(ref.key);
      if (!object || object.httpEtag !== ref.etag || object.size !== ref.size || !Number.isSafeInteger(object.uploaded.getTime()) || object.uploaded.getTime() < 0) throw new Error("Object missing or identity changed");
      if ((object.customMetadata?.sha256 ?? null) !== ref.sha256) throw new Error("Object digest metadata differs from the inventory request");
      inspected.push({ ref, details, storedAt: object.uploaded.getTime() });
    } catch (error) { skipped.push({ key: ref.key, issues: [error instanceof Error ? error.message : "Inspection failed"] }); }
  }
  const registered = storage.transactionSync(() => {
    const result: ObjectRef[] = [];
    for (const item of inspected) {
      const existing = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM source_assets WHERE object_key = ?", item.ref.key).toArray()[0];
      if (existing) {
        const asset = JSON.parse(existing.record_json) as { state?: string; ref?: ObjectRef };
        if (existing.state === "present" && asset.state === "present" && canonicalJson(asset.ref) === canonicalJson(item.ref)) result.push(item.ref);
        else skipped.push({ key: item.ref.key, issues: ["Source identity is different or key is retired"] });
        continue;
      }
      const asset = { record_version: 1, episode_id: item.details.episodeId, kind: item.details.kind, operation_id: item.details.operationId,
        ref: item.ref, stored_at: item.storedAt, registered_at: Date.now(), facts: null, state: "present", claim_operation_id: null };
      storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", item.ref.key, JSON.stringify(asset));
      result.push(item.ref);
    }
    return result;
  });
  return { registered, skipped };
}

/** Cursor is scoped to one Show; claims always recheck the current ledger. */
export function readInventory(storage: DurableObjectStorage, showId: string, cursor?: string) {
  if (!showIdPattern.test(showId)) throw new IdentityConflict("Invalid show ID");
  let after = "";
  if (cursor !== undefined) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
      const decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(decoded, char => char.charCodeAt(0)))) as { show_id?: string; key?: string; version?: number };
      if (value.version !== 1 || value.show_id !== showId || typeof value.key !== "string" || !value.key.startsWith(`${showId}/`)) throw new Error();
      after = value.key;
    } catch { throw new IdentityConflict("Invalid inventory cursor"); }
  }
  return storage.transactionSync(() => {
    const rows = storage.sql.exec<{ object_key: string; state: string; claim_operation_id: string | null; record_json: string }>(
      "SELECT object_key, state, claim_operation_id, record_json FROM source_assets WHERE object_key > ? ORDER BY object_key LIMIT 101", after).toArray();
    const records = rows.slice(0, 100).map(row => {
      const value = JSON.parse(row.record_json) as { ref?: ObjectRef; state?: string; claim_operation_id?: string | null };
      if (!objectRefSchema.safeParse(value.ref).success || value.ref?.key !== row.object_key || value.state !== row.state || value.claim_operation_id !== row.claim_operation_id) throw new IdentityConflict("Inventory ledger is inconsistent");
      return value;
    });
    const last = rows[99]?.object_key;
    const next_cursor = rows.length > 100 && last ? btoa(Array.from(new TextEncoder().encode(JSON.stringify({ version: 1, show_id: showId, key: last })), byte => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : null;
    return { protocol_version: 1 as const, show_id: showId, records, next_cursor };
  });
}
