import { canonicalJson, checkEpisodeReadiness, checkShowReadiness, episodeSchema, parseToml, resolvePublicationTime, showSchema, type ObjectRef, type Operation } from "@castloop/domain";
import { mediaDigestMatches, readMetadataSource, verifySourceRef } from "./objects";
import { commitAcceptance, CreationCollision, IdentityConflict, lookupReceipt, nextScheduledAlarm, readShowControl, RevisionConflict, SnapshotChanged, SnapshotNotFound, type MutationIssue, type ShowControl } from "./storage";
import { stoppedWithdrawalIdentity } from "./publication";

export class UnsupportedOperation extends Error {}
export class ValidationFailure extends Error {}

function registerSource(sql: SqlStorage, ref: ObjectRef, object: R2Object, operationId: string, kind: "show_toml" | "cover" | "episode_toml" | "audio", facts: unknown, episodeId: string | null = null): void {
  const existing = sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
  if (existing && existing.state !== "present") throw new IdentityConflict("Source key is retired or missing");
  if (existing) {
    const record = JSON.parse(existing.record_json) as { ref?: unknown };
    if (!record.ref || canonicalJson(record.ref) !== canonicalJson(ref)) throw new IdentityConflict("Source key is already registered with different identity");
    return;
  }
  const record = { record_version: 1, episode_id: episodeId, kind, operation_id: operationId, ref,
    stored_at: object.uploaded.getTime(), registered_at: Date.now(), facts, state: "present", claim_operation_id: null };
  sql.exec("INSERT INTO source_assets (object_key, state, claim_operation_id, record_json) VALUES (?, 'present', NULL, ?)", ref.key, JSON.stringify(record));
}

async function acceptAudio(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, operation: Extract<Operation, { action: "audio.set" }>) {
  const before = readShowControl(storage, showId);
  if ((before?.revision ?? 0) !== operation.expected_revision) {
    const receipt = await lookupReceipt(storage, showId, operation);
    if (receipt) return receipt;
    throw new RevisionConflict("Show revision changed; pull before retrying");
  }
  if (!before || before.deleted || !before.metadata) throw new IdentityConflict("Show does not exist or is deleted");
  const show = await loadSelectedShow(bucket, before, showId);
  if (checkShowReadiness(show, before.cover && before.cover.logical_name === show.artwork ? before.cover.facts : undefined).length) throw new ValidationFailure("Current show is invalid; repair it before updating audio");
  const { episode_id, audio, facts } = operation.payload;
  if (audio.size <= 0 || audio.size > 1024 * 1024 * 1024) throw new ValidationFailure("MP3 size must be between 1 byte and 1 GiB");
  const row = storage.sql.exec<{ guid: string; record_json: string }>("SELECT guid, record_json FROM episodes WHERE episode_id = ?", episode_id).toArray()[0];
  if (!row) throw new IdentityConflict("Episode does not exist");
  const episodeRecord = JSON.parse(row.record_json) as EpisodeRecord;
  if (episodeRecord.deleted || episodeRecord.episode_id !== episode_id || episodeRecord.guid !== row.guid) throw new IdentityConflict("Episode does not exist or is deleted");
  const previousOperation = episodeRecord.metadata.key.split("/")[3];
  if (!previousOperation) throw new IdentityConflict("Selected episode metadata key is invalid");
  const [metadata, object] = await Promise.all([
    readMetadataSource(bucket, episodeRecord.metadata, { kind: "episode_toml", showId, episodeId: episode_id, operationId: previousOperation }),
    verifySourceRef(bucket, audio, { kind: "audio", showId, episodeId: episode_id, operationId: operation.operation_id }),
  ]);
  const episode = episodeSchema.parse(parseToml(metadata));
  const timezone = episode.timezone ?? episodeRecord.time?.timezone ?? show.timezone;
  const signature = episode.published_at && timezone ? canonicalJson({ published_at: String(episode.published_at), timezone }) : null;
  const issues = checkEpisodeReadiness({ ...episode, ...(timezone ? { timezone } : {}) }, show,
    { mime: facts.mime, durationMs: facts.duration_ms, size: audio.size }, { acceptedTimeMatches: !!signature && episodeRecord.time?.input_signature === signature })
    .map(issue => ({ code: "publication_invalid", path: `episodes.${episode_id}.${issue.path}`, message: issue.message, severity: "error" as const }));
  episodeRecord.audio = { ref: audio, facts };
  const baseIssues = checkEpisodeReadiness({ ...episode, ...(timezone ? { timezone } : {}) }, { ...show, type: "episodic" },
    { mime: facts.mime, durationMs: facts.duration_ms, size: audio.size }, { acceptedTimeMatches: !!signature && episodeRecord.time?.input_signature === signature });
  episodeRecord.scheduling = { ready: baseIssues.length === 0 && episodeRecord.time !== null, serial_ready: !!episode.episode_number };
  const desiredIdentity = await episodeIdentity(episodeRecord);
  return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
    if (!current || current.deleted || !current.metadata) throw new IdentityConflict("Show does not exist or is deleted");
    const currentRow = sql.exec<{ guid: string; record_json: string }>("SELECT guid, record_json FROM episodes WHERE episode_id = ?", episode_id).toArray()[0];
    if (!currentRow || currentRow.guid !== episodeRecord.guid || (JSON.parse(currentRow.record_json) as EpisodeRecord).deleted) throw new IdentityConflict("Episode does not exist or is deleted");
    registerSource(sql, audio, object, operation.operation_id, "audio", facts, episode_id);
    sql.exec("UPDATE episodes SET record_json = ? WHERE episode_id = ?", JSON.stringify(episodeRecord), episode_id);
    setTargetPending(sql, episode_id, desiredIdentity);
    current.revision = revision;
    current.accepted_at = Date.now();
    current.scheduling = { enabled: show.publish === true, serial: show.type === "serial" };
    return { control: current, issues, delivery: episode.publish === true && issues.length ? "blocked" as const : "pending" as const, alarm: nextScheduledAlarm(sql, current, Date.now()) };
  });
}

export interface EpisodeRecord {
  record_version: 1; episode_id: string; guid: string; metadata: ObjectRef;
  audio: { ref: ObjectRef; facts: { mime: "audio/mpeg"; duration_ms: number } } | null;
  time: { timezone: string; input_signature: string; instant_ms: number } | null;
  publish: boolean; deleted: boolean;
  scheduling?: { ready: boolean; serial_ready: boolean };
}

/** Read current validation and outcomes without changing publication state. */
export async function checkShow(storage: DurableObjectStorage, bucket: R2Bucket, showId: string) {
  const captured = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    if (!control || !control.metadata || control.revision === 0) throw new SnapshotNotFound("Show not found");
    const episodes = storage.sql.exec<{ episode_id: string; guid: string; record_json: string }>("SELECT episode_id, guid, record_json FROM episodes ORDER BY episode_id").toArray();
    const outcomes = storage.sql.exec<{ target: string; state: string; record_json: string }>("SELECT target, state, record_json FROM publication_outcomes ORDER BY target").toArray();
    const delivery = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM delivery_refs ORDER BY target").toArray();
    const claims = storage.sql.exec<{ object_key: string; claim_operation_id: string | null }>("SELECT object_key, claim_operation_id FROM source_assets WHERE state = 'delete_claimed' ORDER BY object_key").toArray();
    return { control, episodes, outcomes, claims, delivery };
  });
  const issues: MutationIssue[] = [];
  if (!captured.control.deleted) {
    let show: ReturnType<typeof showSchema.parse> | undefined;
    try { show = await loadSelectedShow(bucket, captured.control, showId); }
    catch { issues.push({ code: "dependency_unavailable", path: "show.metadata", message: "Selected show metadata is unavailable or invalid", severity: "error" }); }
    if (show) {
      let cover = captured.control.cover?.logical_name === show.artwork ? captured.control.cover : null;
      if (cover) {
        try {
          const head = await bucket.head(cover.ref.key);
          if (!head || head.httpEtag !== cover.ref.etag || head.size !== cover.ref.size || !mediaDigestMatches("cover", cover.ref, head)) throw new Error();
        } catch { cover = null; issues.push({ code: "dependency_unavailable", path: "show.artwork", message: "Selected cover is unavailable or changed", severity: "error" }); }
      }
      for (const item of checkShowReadiness(show, cover?.facts)) issues.push({ code: "publication_invalid", path: `show.${item.path}`, message: item.message, severity: "error" });
      for (const row of captured.episodes) {
        const record = JSON.parse(row.record_json) as EpisodeRecord;
        if (record.episode_id !== row.episode_id || record.guid !== row.guid) throw new IdentityConflict("Episode record identity is inconsistent");
        if (record.deleted) continue;
        const previousOperation = record.metadata.key.split("/")[3];
        if (!previousOperation) { issues.push({ code: "dependency_unavailable", path: `episodes.${row.episode_id}.metadata`, message: "Selected episode metadata is invalid", severity: "error" }); continue; }
        let episode: ReturnType<typeof episodeSchema.parse>;
        try { episode = episodeSchema.parse(parseToml(await readMetadataSource(bucket, record.metadata, { kind: "episode_toml", showId, episodeId: row.episode_id, operationId: previousOperation }))); }
        catch { issues.push({ code: "dependency_unavailable", path: `episodes.${row.episode_id}.metadata`, message: "Selected episode metadata is unavailable or invalid", severity: "error" }); continue; }
        let audio = record.audio;
        if (audio) {
          try {
            const head = await bucket.head(audio.ref.key);
            if (!head || head.httpEtag !== audio.ref.etag || head.size !== audio.ref.size || !mediaDigestMatches("audio", audio.ref, head)) throw new Error();
          } catch { audio = null; issues.push({ code: "dependency_unavailable", path: `episodes.${row.episode_id}.audio`, message: "Selected audio is unavailable or changed", severity: "error" }); }
        }
        const timezone = episode.timezone ?? record.time?.timezone ?? show.timezone;
        const signature = episode.published_at && timezone ? canonicalJson({ published_at: String(episode.published_at), timezone }) : null;
        const audioFacts = audio ? { mime: audio.facts.mime, durationMs: audio.facts.duration_ms, size: audio.ref.size } : undefined;
        for (const item of checkEpisodeReadiness({ ...episode, ...(timezone ? { timezone } : {}) }, show, audioFacts, { acceptedTimeMatches: !!signature && record.time?.input_signature === signature })) {
          issues.push({ code: "publication_invalid", path: `episodes.${row.episode_id}.${item.path}`, message: item.message, severity: "error" });
        }
      }
    }
  }
  if (readShowControl(storage, showId)?.revision !== captured.control.revision) throw new SnapshotChanged("Show changed during check; run check again");
  const outcomes = captured.outcomes.map(row => {
    const record = JSON.parse(row.record_json) as { target?: string; state?: string };
    if (record.target !== row.target || record.state !== row.state) throw new IdentityConflict("Publication outcome is inconsistent");
    return record;
  });
  const delivery_paths: string[] = [];
  for (const item of captured.delivery) {
    const record = JSON.parse(item.record_json) as { public_paths?: unknown };
    if (!Array.isArray(record.public_paths) || !record.public_paths.every(path => typeof path === "string" && path.startsWith(`/${showId}/`))) throw new IdentityConflict("Delivery reference is inconsistent");
    delivery_paths.push(...record.public_paths);
  }
  return { protocol_version: 1 as const, show_id: showId, revision: captured.control.revision, issues, outcomes, cleanup_claims: captured.claims,
    delivery_base: captured.control.current_delivery.base, previous_delivery_base: captured.control.current_delivery.previous_base,
    pending_delivery_base: captured.control.pending_delivery?.base ?? null, delivery_paths: [...new Set(delivery_paths)] };
}

async function episodeIdentity(record: EpisodeRecord): Promise<string> {
  const value = canonicalJson({ version: 1, metadata: record.metadata, audio: record.audio?.ref ?? null,
    publish: record.publish, deleted: record.deleted, instant_ms: record.time?.instant_ms ?? null });
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Do not reset a failed target when its own desired identity has not changed. */
function setTargetPending(sql: SqlStorage, target: string, desiredIdentity: string): void {
  const row = sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", target).toArray()[0];
  const previous = row ? JSON.parse(row.record_json) as { desired_identity: string; applied_identity: string | null } : null;
  if (previous?.desired_identity === desiredIdentity) return;
  const record = { record_version: 1, target, desired_identity: desiredIdentity, applied_identity: previous?.applied_identity ?? null,
    attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
  sql.exec(`INSERT INTO publication_outcomes (target, state, record_json) VALUES (?, 'pending', ?)
    ON CONFLICT(target) DO UPDATE SET state = excluded.state, record_json = excluded.record_json`, target, JSON.stringify(record));
}

async function acceptDeletion(storage: DurableObjectStorage, showId: string, operation: Extract<Operation, { action: "show.delete" | "episode.delete" }>) {
  const before = readShowControl(storage, showId);
  if ((before?.revision ?? 0) !== operation.expected_revision) {
    const receipt = await lookupReceipt(storage, showId, operation);
    if (receipt) return receipt;
    throw new RevisionConflict("Show revision changed; pull before retrying");
  }
  if (!before || before.revision === 0 || !before.metadata) throw new IdentityConflict("Show does not exist");
  if (operation.action === "episode.delete") {
    if (before.deleted) throw new IdentityConflict("Show is deleted");
    const row = storage.sql.exec<{ guid: string; record_json: string }>("SELECT guid, record_json FROM episodes WHERE episode_id = ?", operation.payload.episode_id).toArray()[0];
    if (!row) throw new IdentityConflict("Episode does not exist");
    const episode = JSON.parse(row.record_json) as EpisodeRecord;
    if (episode.episode_id !== operation.payload.episode_id || episode.guid !== row.guid) throw new IdentityConflict("Episode record identity is inconsistent");
    episode.deleted = true;
    const desired = await episodeIdentity(episode);
    return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
      if (!current || current.deleted) throw new IdentityConflict("Show does not exist or is deleted");
      const currentEpisode = sql.exec<{ guid: string }>("SELECT guid FROM episodes WHERE episode_id = ?", episode.episode_id).toArray()[0];
      if (!currentEpisode || currentEpisode.guid !== episode.guid) throw new IdentityConflict("Episode does not exist");
      sql.exec("UPDATE episodes SET record_json = ? WHERE episode_id = ?", JSON.stringify(episode), episode.episode_id);
      setTargetPending(sql, episode.episode_id, desired);
      current.revision = revision;
      current.accepted_at = Date.now();
      return { control: current, issues: [], delivery: "pending" as const, alarm: nextScheduledAlarm(sql, current, Date.now()) };
    });
  }
  const desired = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson({ version: 1, show_id: showId, deleted: true })))), b => b.toString(16).padStart(2, "0")).join("");
  return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
    if (!current || !current.metadata) throw new IdentityConflict("Show does not exist");
    const rows = sql.exec<{ episode_id: string; record_json: string }>("SELECT episode_id, record_json FROM episodes").toArray();
    for (const row of rows) {
      const episode = JSON.parse(row.record_json) as EpisodeRecord;
      if (episode.episode_id !== row.episode_id) throw new IdentityConflict("Episode record identity is inconsistent");
      episode.deleted = true;
      sql.exec("UPDATE episodes SET record_json = ? WHERE episode_id = ?", JSON.stringify(episode), row.episode_id);
    }
    setTargetPending(sql, "show-withdrawal", desired);
    current.deleted = true;
    current.revision = revision;
    current.accepted_at = Date.now();
    return { control: current, issues: [], delivery: "pending" as const, alarm: null };
  });
}

async function loadSelectedShow(bucket: R2Bucket, control: ShowControl, showId: string) {
  if (!control.metadata) throw new IdentityConflict("Show does not exist");
  const operationId = control.metadata.key.split("/")[2];
  if (!operationId) throw new IdentityConflict("Selected show metadata key is invalid");
  const body = await readMetadataSource(bucket, control.metadata, { kind: "show_toml", showId, operationId });
  return showSchema.parse(parseToml(body));
}

async function acceptCover(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, operation: Extract<Operation, { action: "cover.set" }>) {
  const before = readShowControl(storage, showId);
  if ((before?.revision ?? 0) !== operation.expected_revision) {
    const receipt = await lookupReceipt(storage, showId, operation);
    if (receipt) return receipt;
    throw new RevisionConflict("Show revision changed; pull before retrying");
  }
  if (!before || before.deleted || !before.metadata) throw new IdentityConflict("Show does not exist or is deleted");
  const show = await loadSelectedShow(bucket, before, showId);
  const { logical_name, cover, facts } = operation.payload;
  if (logical_name !== show.artwork || !/^[^/\\]+\.(?:jpe?g|png)$/i.test(logical_name) || !cover.key.endsWith(`/${logical_name}`)) throw new ValidationFailure("Cover name must match the selected show artwork");
  if (cover.size <= 0 || cover.size > 20 * 1024 * 1024 || facts.width !== facts.height || facts.width < 1400 || facts.width > 3000 ||
    (facts.mime === "image/png") !== /\.png$/i.test(logical_name)) throw new ValidationFailure("Cover must be a square 1400–3000 pixel RGB JPEG or PNG");
  const object = await verifySourceRef(bucket, cover, { kind: "cover", showId, operationId: operation.operation_id });
  const issues = checkShowReadiness(show, facts).map(issue => ({ code: "publication_invalid", path: `show.${issue.path}`, message: issue.message, severity: "error" as const }));
  return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
    if (!current || current.deleted || !current.metadata) throw new IdentityConflict("Show does not exist or is deleted");
    registerSource(sql, cover, object, operation.operation_id, "cover", facts);
    current.cover = { logical_name, ref: cover, facts };
    current.revision = revision;
    current.accepted_at = Date.now();
    current.scheduling = { enabled: show.publish === true && issues.length === 0, serial: show.type === "serial" };
    return { control: current, issues, delivery: show.publish === true && issues.length ? "blocked" as const : "pending" as const, alarm: nextScheduledAlarm(sql, current, Date.now()) };
  });
}

/** Accept supported source revisions; unavailable actions are explicitly rejected. */
export async function acceptShowMetadata(storage: DurableObjectStorage, bucket: R2Bucket, deliveryBase: string, showId: string, operation: Operation) {
  const receipt = await lookupReceipt(storage, showId, operation);
  if (receipt) return receipt;
  if (operation.action === "cover.set") return acceptCover(storage, bucket, showId, operation);
  if (operation.action === "audio.set") return acceptAudio(storage, bucket, showId, operation);
  if (operation.action === "show.delete" || operation.action === "episode.delete") return acceptDeletion(storage, showId, operation);
  if (operation.action !== "metadata.batch") throw new UnsupportedOperation("This operation is not implemented yet");
  if (!operation.payload.show && !operation.payload.episodes.length) throw new ValidationFailure("Metadata batch has no changes");
  const edit = operation.payload.show;
  const before = readShowControl(storage, showId);
  if ((before?.revision ?? 0) !== operation.expected_revision) {
    const retry = await lookupReceipt(storage, showId, operation);
    if (retry) return retry;
    throw new RevisionConflict("Show revision changed; pull before retrying");
  }
  if (edit?.mode === "create" && before && before.revision > 0) throw new IdentityConflict("Show ID is already in use");
  if ((!edit || edit.mode === "update") && (!before || before.revision === 0 || before.deleted || !before.metadata)) throw new IdentityConflict("Show does not exist or is deleted");
  const previousShow = before?.metadata ? await loadSelectedShow(bucket, before, showId) : null;
  const existingCover = before?.cover;
  if (operation.payload.episodes.length && previousShow && checkShowReadiness(previousShow, existingCover && existingCover.logical_name === previousShow.artwork ? existingCover.facts : undefined).length) {
    throw new ValidationFailure("Current show is invalid; repair it before updating episodes");
  }
  const owner = { kind: "show_toml" as const, showId, operationId: operation.operation_id };
  const preparedShow = edit ? await Promise.all([readMetadataSource(bucket, edit.metadata, owner), verifySourceRef(bucket, edit.metadata, owner)]) : null;
  const show = preparedShow ? showSchema.parse(parseToml(preparedShow[0])) : previousShow;
  if (!show) throw new IdentityConflict("Show does not exist");
  const wasPublishedIntent = previousShow?.publish === true;
  let initialBase: string | undefined;
  if (!before) {
    let base: URL;
    try { base = new URL(deliveryBase); } catch { throw new ValidationFailure("Delivery base is not configured"); }
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new ValidationFailure("Delivery base must be an HTTPS origin");
    initialBase = base.origin;
  }
  const previousCover = before?.cover;
  const showIssues = checkShowReadiness(show, previousCover && previousCover.logical_name === show.artwork ? previousCover.facts : undefined);
  const issues = showIssues.map(issue => ({ code: "publication_invalid", path: `show.${issue.path}`, message: issue.message, severity: "error" as const }));
  if (operation.payload.episodes.length && issues.length) throw new ValidationFailure("Updated show is invalid; episode changes were not accepted");
  const stopIdentity = show.publish !== true && edit ? await stoppedWithdrawalIdentity(showId, edit.metadata) : null;
  const preparedEpisodes: { edit: Extract<Operation, { action: "metadata.batch" }>["payload"]["episodes"][number]; object: R2Object; record: EpisodeRecord; desiredIdentity: string }[] = [];
  for (const episodeEdit of operation.payload.episodes) {
    const row = storage.sql.exec<{ guid: string; record_json: string }>("SELECT guid, record_json FROM episodes WHERE episode_id = ?", episodeEdit.episode_id).toArray()[0];
    const previous = row ? JSON.parse(row.record_json) as EpisodeRecord : null;
    if (previous && (previous.guid !== row!.guid || previous.episode_id !== episodeEdit.episode_id)) throw new IdentityConflict("Episode record identity is inconsistent");
    if (episodeEdit.mode === "create" && previous) throw new CreationCollision("Episode ID is already in use", `episodes.${episodeEdit.episode_id}.id`);
    if (episodeEdit.mode === "update" && (!previous || previous.deleted)) throw new IdentityConflict("Episode does not exist or is deleted");
    if (episodeEdit.mode === "create" && !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(episodeEdit.guid)) throw new ValidationFailure("New episode GUID must be a UUIDv4 URN");
    const episodeOwner = { kind: "episode_toml" as const, showId, episodeId: episodeEdit.episode_id, operationId: operation.operation_id };
    const [episodeBody, object] = await Promise.all([readMetadataSource(bucket, episodeEdit.metadata, episodeOwner), verifySourceRef(bucket, episodeEdit.metadata, episodeOwner)]);
    const episode = episodeSchema.parse(parseToml(episodeBody));
    const timezone = episode.timezone ?? previous?.time?.timezone ?? show.timezone;
    let time: EpisodeRecord["time"] = null;
    let acceptedTimeMatches = false;
    if (episode.published_at && timezone) {
      const signature = canonicalJson({ published_at: String(episode.published_at), timezone });
      if (previous?.time?.input_signature === signature) { time = previous.time; acceptedTimeMatches = true; }
      else {
        try {
          const instant_ms = resolvePublicationTime(episode.published_at, timezone);
          if (Number.isSafeInteger(instant_ms) && instant_ms >= 0) time = { timezone, input_signature: signature, instant_ms };
          else issues.push({ code: "publication_invalid", path: `episodes.${episode.id}.published_at`, message: "Publication time is outside the supported range", severity: "error" });
        } catch { /* The readiness check below reports the datetime error. */ }
      }
    }
    const audio = previous?.audio ?? null;
    const audioFacts = audio ? { mime: audio.facts.mime, durationMs: audio.facts.duration_ms, size: audio.ref.size } : undefined;
    for (const issue of checkEpisodeReadiness({ ...episode, ...(timezone ? { timezone } : {}) }, show, audioFacts, { acceptedTimeMatches })) issues.push({ code: "publication_invalid", path: `episodes.${episode.id}.${issue.path}`, message: issue.message, severity: "error" });
    const baseIssues = checkEpisodeReadiness({ ...episode, ...(timezone ? { timezone } : {}) }, { ...show, type: "episodic" }, audioFacts, { acceptedTimeMatches });
    const record: EpisodeRecord = { record_version: 1, episode_id: episode.id, guid: episodeEdit.mode === "create" ? episodeEdit.guid : previous!.guid,
      metadata: episodeEdit.metadata, audio, time, publish: episode.publish ?? false, deleted: false,
      scheduling: { ready: baseIssues.length === 0 && time !== null, serial_ready: !!episode.episode_number } };
    preparedEpisodes.push({ edit: episodeEdit, object, record, desiredIdentity: await episodeIdentity(record) });
  }
  return commitAcceptance(storage, showId, operation, (sql, current, revision) => {
    if (edit?.mode === "create" && current && current.revision > 0) throw new IdentityConflict("Show ID is already in use");
    if ((!edit || edit.mode === "update") && (!current || current.deleted || !current.metadata)) throw new IdentityConflict("Show does not exist or is deleted");
    if (wasPublishedIntent && show.publish !== true && operation.payload.confirm_show_stop !== true) throw new ValidationFailure("Stopping an enabled show requires confirmation");
    if (edit && preparedShow) registerSource(sql, edit.metadata, preparedShow[1], operation.operation_id, "show_toml", null);
    if (stopIdentity && wasPublishedIntent) setTargetPending(sql, "show-withdrawal", stopIdentity);
    else if (stopIdentity && previousShow?.publish !== true) {
      // Updating a stopped show's metadata must not retry a known failure or
      // strand explicit recovery on the previous metadata identity.
      const row = sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0];
      if (row) {
        const withdrawal = JSON.parse(row.record_json) as { desired_identity: string; applied_identity: string | null; state: string };
        if (withdrawal.state !== row.state) throw new IdentityConflict("Withdrawal outcome is inconsistent");
        withdrawal.desired_identity = stopIdentity;
        if (withdrawal.state === "applied") withdrawal.applied_identity = stopIdentity;
        sql.exec("UPDATE publication_outcomes SET record_json = ? WHERE target = 'show-withdrawal'", JSON.stringify(withdrawal));
      }
    }
    for (const prepared of preparedEpisodes) {
      const existing = sql.exec<{ guid: string; record_json: string }>("SELECT guid, record_json FROM episodes WHERE episode_id = ?", prepared.edit.episode_id).toArray()[0];
      if (prepared.edit.mode === "create" && existing) throw new CreationCollision("Episode ID is already in use", `episodes.${prepared.edit.episode_id}.id`);
      if (prepared.edit.mode === "update" && (!existing || (JSON.parse(existing.record_json) as EpisodeRecord).deleted || existing.guid !== prepared.record.guid)) throw new IdentityConflict("Episode does not exist or is deleted");
      if (prepared.edit.mode === "create" && sql.exec("SELECT episode_id FROM episodes WHERE guid = ?", prepared.record.guid).toArray().length) throw new IdentityConflict("Episode GUID is already in use");
      registerSource(sql, prepared.edit.metadata, prepared.object, operation.operation_id, "episode_toml", null, prepared.edit.episode_id);
      sql.exec(`INSERT INTO episodes (episode_id, guid, record_json) VALUES (?, ?, ?)
        ON CONFLICT(episode_id) DO UPDATE SET record_json = excluded.record_json`, prepared.record.episode_id, prepared.record.guid, JSON.stringify(prepared.record));
      setTargetPending(sql, prepared.record.episode_id, prepared.desiredIdentity);
    }
    const control: ShowControl = current ?? { record_version: 1, show_id: showId, revision: 0, metadata: null, cover: null, deleted: false,
      accepted_at: null, last_receipt: null, current_delivery: { base: initialBase!, previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    control.revision = revision;
    if (edit) control.metadata = edit.metadata;
    control.accepted_at = Date.now();
    control.scheduling = { enabled: show.publish === true && showIssues.length === 0, serial: show.type === "serial" };
    return { control, issues, delivery: show.publish === true && issues.length ? "blocked" as const : "pending" as const, alarm: nextScheduledAlarm(sql, control, Date.now()) };
  });
}
