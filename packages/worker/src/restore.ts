import { canonicalJson, exportEnvelopeSchema, type Operation } from "@castloop/domain";
import { assertSourceOwnership, mediaDigestMatches } from "./objects";
import { hasCurrentWithdrawal } from "./publication";
import { commitAcceptance, IdentityConflict, lookupReceipt, readShowControl, RevisionConflict, type ShowControl } from "./storage";

type RestoreOperation = Extract<Operation, { action: "restore" }>;

/** Verify an immutable staged envelope before atomically installing a held snapshot. */
export async function acceptRestore(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, operation: RestoreOperation, sourceBucket: string, deliveryBucket: string, isRunning: () => boolean = () => false) {
  const before = readShowControl(storage, showId);
  if ((before?.revision ?? 0) !== operation.expected_revision) {
    const receipt = await lookupReceipt(storage, showId, operation);
    if (receipt) return receipt;
    throw new RevisionConflict("Show revision changed; retry from current state");
  }
  if (before && !operation.payload.replace) throw new IdentityConflict("Replacing an existing show requires --replace");
  const stopped = before ? await hasCurrentWithdrawal(storage, showId) : false;
  const withdrawal = before ? storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0] : undefined;
  if (before && (!stopped || withdrawal?.state !== "applied")) throw new IdentityConflict("Stop the existing show and complete withdrawal before restore");
  const ref = operation.payload.snapshot;
  assertSourceOwnership(ref.key, { kind: "maintenance", showId, operationId: operation.operation_id });
  if (ref.size <= 0 || ref.size > 16 * 1024 * 1024) throw new IdentityConflict("Restore envelope exceeds size limit");
  const staged = await bucket.get(ref.key, { onlyIf: new Headers({ "If-Match": ref.etag }) });
  if (!staged || !("body" in staged) || staged.httpEtag !== ref.etag || staged.size !== ref.size) throw new IdentityConflict("Restore envelope is missing or changed");
  const bytes = await staged.arrayBuffer();
  if (bytes.byteLength !== ref.size) throw new IdentityConflict("Restore envelope size changed");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== ref.sha256) throw new IdentityConflict("Restore envelope digest mismatch");
  const envelope = exportEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if (envelope.shows.length !== 1 || envelope.shows[0]!.show_id !== showId || envelope.installation.management_bucket !== sourceBucket || envelope.installation.delivery_bucket !== deliveryBucket) throw new IdentityConflict("Restore envelope belongs to another show or installation");
  const snapshot = envelope.shows[0]!;
  const kinds = new Map(snapshot.source_assets.map(asset => [asset.ref.key, asset.kind]));
  for (let i = 0; i < snapshot.required_objects.length; i += 8) await Promise.all(snapshot.required_objects.slice(i, i + 8).map(async source => {
    const object = await bucket.head(source.key);
    if (!object || object.httpEtag !== source.etag || object.size !== source.size || !mediaDigestMatches(kinds.get(source.key), source, object)) throw new IdentityConflict(`Required source is unavailable or changed: ${source.key}`);
  }));
  return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
    if (!!current !== !!before || (current && canonicalJson(current) !== canonicalJson(before))) throw new RevisionConflict("Show changed during restore preparation");
    if (isRunning()) throw new IdentityConflict("Publication is running; retry restore later");
    if (sql.exec("SELECT object_key FROM source_pins LIMIT 1").toArray().length || sql.exec("SELECT object_key FROM source_assets WHERE state = 'delete_claimed' LIMIT 1").toArray().length) throw new IdentityConflict("Restore cannot run while sources are pinned or claimed");
    if (current && sql.exec("SELECT target FROM delivery_refs LIMIT 1").toArray().length) throw new IdentityConflict("Existing delivery withdrawal is incomplete");
    const stagedRow = sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
    if (stagedRow && (stagedRow.state !== "present" || canonicalJson((JSON.parse(stagedRow.record_json) as { ref: unknown }).ref) !== canonicalJson(ref))) throw new IdentityConflict("Restore envelope key is retired or changed");
    for (const source of snapshot.required_objects) {
      const row = sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM source_assets WHERE object_key = ?", source.key).toArray()[0];
      if (row && (row.state !== "present" || canonicalJson((JSON.parse(row.record_json) as { ref: unknown }).ref) !== canonicalJson(source))) throw new IdentityConflict("Required source was retired or changed during restore");
    }
    for (const asset of snapshot.source_assets) {
      const row = sql.exec("SELECT object_key FROM source_assets WHERE object_key = ?", asset.ref.key).toArray()[0];
      if (!row) sql.exec("INSERT INTO source_assets VALUES (?, ?, ?, ?)", asset.ref.key, asset.state, asset.claim_operation_id, JSON.stringify(asset));
    }
    if (!stagedRow) {
      const record = { record_version: 1, episode_id: null, kind: "maintenance", operation_id: operation.operation_id, ref, stored_at: staged.uploaded.getTime(), registered_at: Date.now(), facts: null, state: "present", claim_operation_id: null };
      sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", ref.key, JSON.stringify(record));
    }
    sql.exec("DELETE FROM episodes");
    sql.exec("DELETE FROM publication_outcomes");
    sql.exec("DELETE FROM delivery_refs");
    for (const episode of snapshot.episodes) sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episode.episode_id, episode.guid, JSON.stringify(episode));
    for (const outcome of snapshot.publication_outcomes) sql.exec("INSERT INTO publication_outcomes VALUES (?, ?, ?)", outcome.target, outcome.state, JSON.stringify(outcome));
    for (const delivery of snapshot.delivery_refs) sql.exec("INSERT INTO delivery_refs VALUES (?, ?)", delivery.target, JSON.stringify(delivery));
    const control: ShowControl = { ...snapshot.show_control, revision, accepted_at: Date.now(), last_receipt: null, restore_hold: true };
    return { control, issues: [], delivery: "blocked" as const, alarm: null };
  });
}
