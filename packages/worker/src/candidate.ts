import { canonicalJson, checkShowReadiness, episodeSchema, parseToml, renderFeed, selectEpisode, showSchema, type ObjectRef, type ReadinessIssue } from "@castloop/domain";
import { readMetadataSource, verifySourceRef } from "./objects";
import { IdentityConflict, readShowControl, SnapshotChanged, type ShowControl } from "./storage";
import type { EpisodeRecord } from "./show";

interface CapturedEpisode { record: EpisodeRecord; failed: boolean; desiredIdentity: string }
export interface FeedSnapshot {
  show: ObjectRef; cover: ObjectRef; coverPath: string; base: string;
  episodes: { id: string; identity: string; metadata: ObjectRef; audio: ObjectRef; guid: string; publishedAt: number; durationMs: number }[];
}
export interface CandidateEpisode {
  id: string;
  state: "withdraw" | "invalid" | "scheduled" | "failed" | "eligible";
  issues?: ReadinessIssue[];
  at?: number;
  audio?: ObjectRef;
  metadata?: ObjectRef;
  desiredIdentity: string;
  feedEntry?: FeedSnapshot["episodes"][number];
  serialReady?: boolean;
}
export type PublicationCandidate = {
  revision: number;
  control: ShowControl;
  episodes: CandidateEpisode[];
  release: () => void;
} & (
  | { state: "hold"; issues: ReadinessIssue[] }
  | { state: "withdraw" }
  | { state: "ready"; feed: string; cover: ObjectRef; coverPath: string; nextAlarm: number | null; snapshot?: FeedSnapshot; targeted?: boolean; serial?: boolean }
);

/**
 * Capture and pin sources in the same transaction so a concurrent cleanup
 * cannot retire a source between selecting it and reading/copying it.
 * The caller keeps the pins until every external read or copy has settled.
 */
export async function prepareCandidate(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, now: number, retryFailed: boolean | string = false, previewRestore = false): Promise<PublicationCandidate> {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid publication time");
  const executionId = crypto.randomUUID();
  const captured = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    if (!control || !control.metadata || !control.revision) throw new IdentityConflict("Show does not exist");
    const rows = storage.sql.exec<{ episode_id: string; guid: string; record_json: string; state: string | null; outcome_json: string | null }>(
      "SELECT e.episode_id, e.guid, e.record_json, o.state, o.record_json AS outcome_json FROM episodes e LEFT JOIN publication_outcomes o ON o.target = e.episode_id ORDER BY e.episode_id").toArray();
    const episodes: CapturedEpisode[] = rows.map(row => {
      const record = JSON.parse(row.record_json) as EpisodeRecord;
      if (record.record_version !== 1 || record.episode_id !== row.episode_id || record.guid !== row.guid || typeof record.deleted !== "boolean" || typeof record.publish !== "boolean") throw new IdentityConflict("Episode record identity is inconsistent");
      const outcome = row.outcome_json ? JSON.parse(row.outcome_json) as { target?: string; state?: string; desired_identity?: string } : null;
      if (!outcome || outcome.target !== record.episode_id || outcome.state !== row.state || typeof outcome.desired_identity !== "string") throw new IdentityConflict("Episode publication outcome is inconsistent");
      return { record, failed: row.state === "failed", desiredIdentity: outcome.desired_identity };
    });
    const priorRow = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM delivery_refs WHERE target = 'feed'").toArray()[0];
    const prior = priorRow ? JSON.parse(priorRow.record_json) as { snapshot?: FeedSnapshot } : null;
    if (!control.deleted) {
      const snapshot = prior?.snapshot;
      const refs = [control.metadata, ...(control.cover ? [control.cover.ref] : []), ...episodes.filter(item => !item.record.deleted && item.record.publish).flatMap(item => [item.record.metadata, ...(item.record.audio ? [item.record.audio.ref] : [])]),
        ...(snapshot ? [snapshot.show, snapshot.cover, ...snapshot.episodes.flatMap(item => [item.metadata, item.audio])] : [])];
      const seen = new Map<string, string>();
      for (const ref of refs) {
        const identity = canonicalJson(ref);
        if (seen.has(ref.key)) {
          if (seen.get(ref.key) !== identity) throw new IdentityConflict("Conflicting identities for the same source key");
          continue;
        }
        seen.set(ref.key, identity);
        const asset = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM source_assets WHERE object_key = ?", ref.key).toArray()[0];
        if (!asset || asset.state !== "present") throw new IdentityConflict("Selected source is unavailable or retired");
        const record = JSON.parse(asset.record_json) as { ref?: ObjectRef; state?: string };
        if (record.state !== "present" || !record.ref || canonicalJson(record.ref) !== identity) throw new IdentityConflict("Selected source identity is inconsistent");
        storage.sql.exec("INSERT INTO source_pins (object_key, execution_id) VALUES (?, ?)", ref.key, executionId);
      }
    }
    return { control, episodes, snapshot: prior?.snapshot };
  });
  const release = () => { storage.sql.exec("DELETE FROM source_pins WHERE execution_id = ?", executionId); };
  try {
    if (captured.control.deleted) return { state: "withdraw", revision: captured.control.revision, control: captured.control, episodes: [], release };
    const showRef = captured.control.metadata!;
    const showOp = showRef.key.split("/")[2] ?? "";
    const show = showSchema.parse(parseToml(await readMetadataSource(bucket, showRef, { kind: "show_toml", showId, operationId: showOp })));
    if (show.publish !== true) return { state: "withdraw", revision: captured.control.revision, control: captured.control, episodes: [], release };
    const cover = captured.control.cover?.logical_name === show.artwork ? captured.control.cover : null;
    let coverAvailable = false;
    if (cover) {
      try { await verifySourceRef(bucket, cover.ref, { kind: "cover", showId, operationId: cover.ref.key.split("/")[2] ?? "" }); coverAvailable = true; }
      catch { /* The prior valid feed must remain available. */ }
    }
    const issues = checkShowReadiness(show, coverAvailable ? cover!.facts : undefined);
    if (captured.control.restore_hold && !previewRestore) issues.push({ path: "show", message: "Restore hold requires an explicit resume" });
    if (issues.length) {
      if (previewRestore || captured.control.restore_hold) return { state: "hold", revision: captured.control.revision, control: captured.control, episodes: [], issues, release };
      const snapshot = captured.snapshot;
      const withdrawals = captured.episodes.filter(item => (item.record.deleted || !item.record.publish) && (typeof retryFailed !== "string" || item.record.episode_id === retryFailed) && (!item.failed || !!retryFailed));
      const removed = new Set(withdrawals.map(item => item.record.episode_id));
      if (!snapshot || !snapshot.episodes.some(item => removed.has(item.id))) return { state: "hold", revision: captured.control.revision, control: captured.control, episodes: [], issues, release };
      const oldShow = showSchema.parse(parseToml(await readMetadataSource(bucket, snapshot.show, { kind: "show_toml", showId, operationId: snapshot.show.key.split("/")[2] ?? "" })));
      const remaining = snapshot.episodes.filter(item => !removed.has(item.id));
      const feedItems = await Promise.all(remaining.map(async item => ({ metadata: episodeSchema.parse(parseToml(await readMetadataSource(bucket, item.metadata,
        { kind: "episode_toml", showId, episodeId: item.id, operationId: item.metadata.key.split("/")[3] ?? "" }))), guid: item.guid,
        publishedAt: item.publishedAt, audioBytes: item.audio.size, durationMs: item.durationMs })));
      if (readShowControl(storage, showId)?.revision !== captured.control.revision) throw new SnapshotChanged("Show changed while building publication candidate");
      const nextSnapshot = { ...snapshot, episodes: remaining };
      const feed = renderFeed({ show: oldShow, baseUrl: snapshot.base, artworkUrl: `${snapshot.base}/${snapshot.coverPath}`, episodes: feedItems, builtAt: now,
        ...(captured.control.current_delivery.migration_operation_id ? { newFeedUrl: `${snapshot.base}/${showId}/feed.xml` } : {}) });
      return { state: "ready", revision: captured.control.revision, control: captured.control,
        episodes: withdrawals.map(item => ({ id: item.record.episode_id, desiredIdentity: item.desiredIdentity, state: "withdraw" as const })),
        feed, cover: snapshot.cover, coverPath: snapshot.coverPath, nextAlarm: null, snapshot: nextSnapshot, targeted: typeof retryFailed === "string", release };
    }
    const results: { decision: CandidateEpisode; feedItem?: Parameters<typeof renderFeed>[0]["episodes"][number] }[] = [];
    // Bounded groups prevent an archive with many episodes from starting an
    // unbounded number of simultaneous R2 reads.
    const selected = typeof retryFailed === "string" ? captured.episodes.filter(item => item.record.episode_id === retryFailed) : captured.episodes;
    for (let offset = 0; offset < selected.length; offset += 8) {
      const group = selected.slice(offset, offset + 8);
      results.push(...await Promise.all(group.map(async ({ record, failed, desiredIdentity }) => {
        if (record.deleted || !record.publish) return { decision: { id: record.episode_id, desiredIdentity, state: "withdraw" as const } };
        try {
          const text = await readMetadataSource(bucket, record.metadata, { kind: "episode_toml", showId, episodeId: record.episode_id, operationId: record.metadata.key.split("/")[3] ?? "" });
          const metadata = episodeSchema.parse(parseToml(text));
          if (metadata.publish !== record.publish) throw new IdentityConflict("Episode publication intent is inconsistent");
          if (record.audio) await verifySourceRef(bucket, record.audio.ref, { kind: "audio", showId, episodeId: record.episode_id, operationId: record.audio.ref.key.split("/")[3] ?? "" });
          const audio = record.audio ? { mime: record.audio.facts.mime, size: record.audio.ref.size, durationMs: record.audio.facts.duration_ms } : undefined;
          const selection = selectEpisode(show, { metadata, deleted: record.deleted, audio, time: record.time, failed }, now, !!retryFailed);
          const decision: CandidateEpisode = { id: record.episode_id, desiredIdentity, state: selection.state, ...(selection.state === "invalid" ? { issues: selection.issues } : {}),
            ...("at" in selection ? { at: selection.at } : {}), metadata: record.metadata, serialReady: !!metadata.episode_number, ...(record.audio ? { audio: record.audio.ref } : {}) };
          if (selection.state === "eligible" && record.audio) decision.feedEntry = { id: record.episode_id, identity: desiredIdentity, metadata: record.metadata, audio: record.audio.ref, guid: record.guid, publishedAt: selection.at, durationMs: record.audio.facts.duration_ms };
          return selection.state === "eligible" && record.audio
            ? { decision, feedItem: { metadata, guid: record.guid, publishedAt: selection.at, audioBytes: record.audio.ref.size, durationMs: record.audio.facts.duration_ms } }
            : { decision };
        } catch (error) {
          return { decision: { id: record.episode_id, desiredIdentity, state: "invalid" as const, issues: [{ path: "source", message: error instanceof Error ? error.message : "Source unavailable" }] } };
        }
      })));
    }
    if (readShowControl(storage, showId)?.revision !== captured.control.revision) throw new SnapshotChanged("Show changed while building publication candidate");
    const extension = cover!.facts.mime === "image/png" ? "png" : "jpg";
    if (!cover!.ref.sha256) throw new IdentityConflict("Cover digest is missing");
    const coverPath = `${showId}/covers/${cover!.ref.sha256}.${extension}`;
    const base = captured.control.pending_delivery?.base ?? captured.control.current_delivery.base;
    if (typeof retryFailed === "string" && captured.snapshot) {
      const prior = captured.snapshot;
      const oldShow = showSchema.parse(parseToml(await readMetadataSource(bucket, prior.show, { kind: "show_toml", showId, operationId: prior.show.key.split("/")[2] ?? "" })));
      const entries = prior.episodes.filter(item => item.id !== retryFailed);
      const target = results[0];
      if (target?.decision.feedEntry) entries.push(target.decision.feedEntry);
      entries.sort((a, b) => a.id.localeCompare(b.id));
      const feedItems = await Promise.all(entries.map(async item => ({ metadata: episodeSchema.parse(parseToml(await readMetadataSource(bucket, item.metadata,
        { kind: "episode_toml", showId, episodeId: item.id, operationId: item.metadata.key.split("/")[3] ?? "" }))), guid: item.guid,
        publishedAt: item.publishedAt, audioBytes: item.audio.size, durationMs: item.durationMs })));
      if (readShowControl(storage, showId)?.revision !== captured.control.revision) throw new SnapshotChanged("Show changed while building publication candidate");
      const feed = renderFeed({ show: oldShow, baseUrl: prior.base, artworkUrl: `${prior.base}/${prior.coverPath}`, episodes: feedItems, builtAt: now,
        ...(captured.control.current_delivery.migration_operation_id ? { newFeedUrl: `${prior.base}/${showId}/feed.xml` } : {}) });
      return { state: "ready", revision: captured.control.revision, control: captured.control, episodes: results.map(item => item.decision), feed,
        cover: prior.cover, coverPath: prior.coverPath, nextAlarm: target?.decision.state === "scheduled" ? target.decision.at ?? null : null,
        snapshot: { ...prior, episodes: entries }, targeted: true, serial: show.type === "serial", release };
    }
    const migration = (captured.control.pending_delivery && captured.control.pending_delivery.base !== captured.control.current_delivery.base) || captured.control.current_delivery.migration_operation_id;
    const feed = renderFeed({ show, baseUrl: base, artworkUrl: `${base}/${coverPath}`, episodes: results.flatMap(item => item.feedItem ? [item.feedItem] : []), builtAt: now,
      ...(migration ? { newFeedUrl: `${base}/${showId}/feed.xml` } : {}) });
    const future = results.flatMap(item => item.decision.state === "scheduled" && item.decision.at !== undefined ? [item.decision.at] : []);
    const snapshot: FeedSnapshot = { show: showRef, cover: cover!.ref, coverPath, base, episodes: results.flatMap(item => item.decision.feedEntry ? [item.decision.feedEntry] : []) };
    return { state: "ready", revision: captured.control.revision, control: captured.control, episodes: results.map(item => item.decision), feed, cover: cover!.ref, coverPath, snapshot, targeted: typeof retryFailed === "string", serial: show.type === "serial",
      nextAlarm: future.reduce<number | null>((earliest, time) => earliest === null || time < earliest ? time : earliest, null), release };
  } catch (error) {
    release();
    throw error;
  }
}
