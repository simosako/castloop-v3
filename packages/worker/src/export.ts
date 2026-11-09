import { canonicalJson, objectRefSchema, showExportSchema, showIdPattern, type ObjectRef } from "@castloop/domain";
import { IdentityConflict, readShowControl, SnapshotNotFound } from "./storage";
import type { EpisodeRecord } from "./show";
import { mediaDigestMatches } from "./objects";

/** Capture one Show atomically and pin every source required to restore it. */
export async function exportShow(storage: DurableObjectStorage, bucket: R2Bucket, showId: string) {
  if (!showIdPattern.test(showId)) throw new IdentityConflict("Invalid show ID");
  const executionId = crypto.randomUUID();
  const captured = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    if (!control || !control.metadata || !control.revision) throw new SnapshotNotFound("Show not found");
    const episodes = storage.sql.exec<{ episode_id: string; guid: string; record_json: string }>("SELECT episode_id, guid, record_json FROM episodes ORDER BY episode_id").toArray().map(row => {
      const record = JSON.parse(row.record_json) as EpisodeRecord;
      if (record.record_version !== 1 || record.episode_id !== row.episode_id || record.guid !== row.guid || typeof record.deleted !== "boolean") throw new IdentityConflict("Episode record is inconsistent");
      return record;
    });
    const source_assets = storage.sql.exec<{ object_key: string; state: string; claim_operation_id: string | null; record_json: string }>("SELECT object_key, state, claim_operation_id, record_json FROM source_assets ORDER BY object_key").toArray().map(row => {
      const record = JSON.parse(row.record_json) as { record_version?: number; ref?: ObjectRef; state?: string; claim_operation_id?: string | null; kind?: string };
      if (record.record_version !== 1 || !objectRefSchema.safeParse(record.ref).success || record.ref?.key !== row.object_key || record.state !== row.state || record.claim_operation_id !== row.claim_operation_id) throw new IdentityConflict("Source ledger is inconsistent");
      return record;
    });
    const publication_outcomes = storage.sql.exec<{ target: string; state: string; record_json: string }>("SELECT target, state, record_json FROM publication_outcomes ORDER BY target").toArray().map(row => {
      const record = JSON.parse(row.record_json) as { record_version?: number; target?: string; state?: string };
      if (record.record_version !== 1 || record.target !== row.target || record.state !== row.state) throw new IdentityConflict("Publication outcome is inconsistent");
      return record;
    });
    const delivery_refs = storage.sql.exec<{ target: string; record_json: string }>("SELECT target, record_json FROM delivery_refs ORDER BY target").toArray().map(row => {
      const record = JSON.parse(row.record_json) as { record_version?: number; target?: string; sources?: ObjectRef[] };
      if (record.record_version !== 1 || record.target !== row.target || !Array.isArray(record.sources) || !record.sources.every(ref => objectRefSchema.safeParse(ref).success)) throw new IdentityConflict("Delivery references are inconsistent");
      return record;
    });
    const refs: ObjectRef[] = [];
    if (!control.deleted) {
      refs.push(control.metadata);
      if (control.cover) refs.push(control.cover.ref);
      for (const episode of episodes) if (!episode.deleted) { refs.push(episode.metadata); if (episode.audio) refs.push(episode.audio.ref); }
    }
    for (const delivery of delivery_refs) refs.push(...delivery.sources!);
    const required = new Map<string, ObjectRef>();
    for (const input of refs) {
      const ref = objectRefSchema.parse(input);
      if (!ref.key.startsWith(`${showId}/`)) throw new IdentityConflict("Required source has incorrect owner");
      const old = required.get(ref.key);
      if (old && canonicalJson(old) !== canonicalJson(ref)) throw new IdentityConflict("Required source identity conflicts");
      required.set(ref.key, ref);
    }
    const assets = new Map(source_assets.map(asset => [asset.ref!.key, asset]));
    for (const ref of required.values()) {
      const asset = assets.get(ref.key);
      if (!asset || asset.state !== "present" || canonicalJson(asset.ref) !== canonicalJson(ref)) throw new IdentityConflict("Required source is missing, retired or inconsistent");
      storage.sql.exec("INSERT INTO source_pins (object_key, execution_id) VALUES (?, ?)", ref.key, executionId);
    }
    return { snapshot_version: 1 as const, show_id: showId, source_revision: control.revision, show_control: control, episodes, source_assets, publication_outcomes, delivery_refs,
      required_objects: [...required.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      historical_missing_or_deleted: source_assets.filter(asset => asset.state === "missing" || asset.state === "deleted").map(asset => asset.ref!.key) };
  });
  try {
    const kinds = new Map(captured.source_assets.map(asset => [asset.ref!.key, asset.kind]));
    for (let i = 0; i < captured.required_objects.length; i += 8) await Promise.all(captured.required_objects.slice(i, i + 8).map(async ref => {
      const head = await bucket.head(ref.key);
      if (!head || head.httpEtag !== ref.etag || head.size !== ref.size || !mediaDigestMatches(kinds.get(ref.key), ref, head)) throw new Error(`Required source is unavailable or changed: ${ref.key}`);
    }));
    if (new TextEncoder().encode(JSON.stringify(captured)).byteLength > 16 * 1024 * 1024) throw new Error("Show export exceeds 16 MiB");
    return showExportSchema.parse(captured);
  } finally { storage.sql.exec("DELETE FROM source_pins WHERE execution_id = ?", executionId); }
}
