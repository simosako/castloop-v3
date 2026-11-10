import { canonicalJson, showIdPattern, type ObjectRef } from "@castloop/domain";
import { IdentityConflict, nextScheduledAlarm, readShowControl } from "./storage";
import type { FeedSnapshot, PublicationCandidate } from "./candidate";
import { COPY_GROUP_SIZE, MAX_PUBLICATION_COPIES, type CopyItem } from "./copy-contract";

interface WithdrawalOutcome {
  record_version: 1; target: "show-withdrawal"; desired_identity: string; applied_identity: string | null;
  attempt_revision: number | null; state: "pending" | "applied" | "blocked" | "failed";
  trigger: string; error: { code: string; message: string; operation_id: string | null; at: number } | null;
  notification: "unconfigured" | "pending" | "accepted" | "failed" | null;
}

export async function stoppedWithdrawalIdentity(showId: string, metadata: ObjectRef): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ version: 1, show_id: showId, deleted: false, publish: false, metadata }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** A withdrawal is current only if its identity matches the selected source. */
export async function hasCurrentWithdrawal(storage: DurableObjectStorage, showId: string): Promise<boolean> {
  const captured = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    const row = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0];
    return { control, row };
  });
  if (!captured.control || !captured.row) return false;
  const outcome = JSON.parse(captured.row.record_json) as WithdrawalOutcome;
  if (captured.control.deleted) return true;
  if (!captured.control.metadata) return false;
  const identity = await stoppedWithdrawalIdentity(showId, captured.control.metadata);
  // Another event may have accepted a revision while hashing.
  return readShowControl(storage, showId)?.revision === captured.control.revision && outcome.desired_identity === identity;
}

/** Withdraw a deleted or explicitly stopped show; no private source is read or deleted. */
export async function withdrawDeletedShow(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, purge: (paths: string[]) => Promise<void>, trigger: "acceptance" | "recover" = "acceptance"): Promise<"applied" | "failed" | "pending"> {
  if (!showIdPattern.test(showId)) throw new IdentityConflict("Invalid show ID");
  const captured = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    if (!control) throw new IdentityConflict("Show does not exist");
    const row = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0];
    if (!row) throw new IdentityConflict("Withdrawal outcome is missing");
    const outcome = JSON.parse(row.record_json) as WithdrawalOutcome;
    if (outcome.target !== "show-withdrawal" || outcome.state !== row.state || typeof outcome.desired_identity !== "string") throw new IdentityConflict("Withdrawal outcome is inconsistent");
    return { revision: control.revision, deleted: control.deleted, metadata: control.metadata, operationId: control.last_receipt?.operation_id ?? null, outcome };
  });
  if (!captured.deleted && (!captured.metadata || captured.outcome.desired_identity !== await stoppedWithdrawalIdentity(showId, captured.metadata))) throw new IdentityConflict("Current show intent is not withdrawal");
  if (captured.outcome.state === "applied") return "applied";
  if (captured.outcome.state === "failed" && trigger !== "recover") return "failed";

  let failure = false;
  try {
    const keys: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix: `${showId}/`, cursor, limit: 1000 });
      for (const object of page.objects) {
        if (!object.key.startsWith(`${showId}/`)) throw new Error("Delivery listing returned an unexpected key");
        keys.push(object.key);
      }
      const next = page.truncated ? page.cursor : undefined;
      if (page.truncated && (!next || cursors.has(next))) throw new Error("Delivery listing cursor did not advance");
      if (next) cursors.add(next);
      cursor = next;
    } while (cursor);
    for (let index = 0; index < keys.length; index += 1000) await bucket.delete(keys.slice(index, index + 1000));
    await purge([`/${showId}/`]);
  } catch (error) {
    failure = true;
    console.error(JSON.stringify({ event: "show_withdrawal_failed", show_id: showId, target: "show-withdrawal", revision: captured.revision,
      operation_id: captured.operationId, trigger, code: "delivery_failed", error: error instanceof Error ? error.message : "unknown" }));
  }

  return storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    const row = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = 'show-withdrawal'").toArray()[0];
    if (!control || control.deleted !== captured.deleted || control.revision !== captured.revision || !row) return "pending";
    const outcome = JSON.parse(row.record_json) as WithdrawalOutcome;
    if (outcome.target !== "show-withdrawal" || outcome.desired_identity !== captured.outcome.desired_identity) return "pending";
    outcome.attempt_revision = captured.revision;
    outcome.trigger = trigger;
    outcome.state = failure ? "failed" : "applied";
    outcome.error = failure ? { code: "delivery_failed", message: "Show withdrawal did not complete", operation_id: captured.operationId, at: Date.now() } : null;
    outcome.notification = failure ? "unconfigured" : null;
    if (!failure) {
      outcome.applied_identity = outcome.desired_identity;
      storage.sql.exec("DELETE FROM delivery_refs");
    }
    storage.sql.exec("UPDATE publication_outcomes SET state = ?, record_json = ? WHERE target = 'show-withdrawal'", outcome.state, JSON.stringify(outcome));
    if (control.last_receipt?.response.accepted_revision === captured.revision) {
      control.last_receipt.response.delivery = outcome.state;
      storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(control));
    }
    return outcome.state;
  });
}

interface DeliveryRef { record_version: 1; target: string; identity: string; sources: ObjectRef[]; public_paths: string[]; applied_at: number; snapshot?: FeedSnapshot }
type Outcome = Omit<WithdrawalOutcome, "target"> & { target: string };
type ReadyCandidate = Extract<PublicationCandidate, { state: "ready" }>;
type CopyMedia = (source: ObjectRef, target: string, mime: "audio/mpeg" | "image/jpeg" | "image/png") => Promise<void>;

/** Apply one already captured candidate. No automatic drain or retry occurs. */
export async function applyCandidate(storage: DurableObjectStorage, bucket: R2Bucket, showId: string, candidate: ReadyCandidate, copy: CopyMedia,
  purge: (paths: string[]) => Promise<void>, trigger: "acceptance" | "alarm" | "recover" = "acceptance",
  copyGroup?: (items: CopyItem[]) => Promise<void>): Promise<"applied" | "failed" | "pending"> {
  const eligible = candidate.episodes.filter(item => item.state === "eligible");
  const encoded = canonicalJson({ version: 1, show: candidate.snapshot?.show ?? candidate.control.metadata, cover: candidate.cover, base: candidate.snapshot?.base ?? candidate.control.current_delivery.base,
    episodes: candidate.snapshot?.episodes.map(item => ({ id: item.id, identity: item.identity })) ?? eligible.map(item => ({ id: item.id, identity: item.desiredIdentity })) });
  const feedIdentity = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))), byte => byte.toString(16).padStart(2, "0")).join("");
  const before = storage.transactionSync(() => {
    const control = readShowControl(storage, showId);
    if (!control || control.revision !== candidate.revision || control.deleted) return null;
    if (canonicalJson(control.pending_delivery) !== canonicalJson(candidate.control.pending_delivery)) return null;
    if (control.pending_delivery && (!candidate.snapshot || ![control.current_delivery.base, control.pending_delivery.base].includes(candidate.snapshot.base))) throw new IdentityConflict("Pending delivery and feed differ");
    const refs = new Map<string, DeliveryRef>();
    const unresolvedEligible = new Set<string>();
    const unresolvedWithdrawal = new Set<string>();
    for (const row of storage.sql.exec<{ target: string; record_json: string }>("SELECT target, record_json FROM delivery_refs").toArray()) {
      const record = JSON.parse(row.record_json) as DeliveryRef;
      if (record.target !== row.target || !Array.isArray(record.sources) || !Array.isArray(record.public_paths) || record.public_paths.some(path => !path.startsWith(`/${showId}/`))) throw new IdentityConflict("Delivery reference is inconsistent");
      refs.set(row.target, record);
    }
    for (const item of candidate.episodes) {
      const row = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = ?", item.id).toArray()[0];
      const outcome = row && JSON.parse(row.record_json) as Outcome;
      if (!outcome || outcome.target !== item.id || outcome.state !== row.state || outcome.desired_identity !== item.desiredIdentity) return null;
      if (item.state === "eligible" && outcome.state !== "applied") unresolvedEligible.add(item.id);
      if (item.state !== "eligible" && outcome.state !== "applied" && outcome.state !== "blocked") unresolvedWithdrawal.add(item.id);
    }
    const row = storage.sql.exec<{ state: string; record_json: string }>("SELECT state, record_json FROM publication_outcomes WHERE target = 'feed'").toArray()[0];
    const prior = row ? JSON.parse(row.record_json) as Outcome : null;
    if (prior && (prior.target !== "feed" || prior.state !== row!.state)) throw new IdentityConflict("Feed outcome is inconsistent");
    if (prior?.desired_identity === feedIdentity && prior.state === "failed" && trigger !== "recover") return { refs, unresolvedEligible, unresolvedWithdrawal, skip: true };
    const outcome: Outcome = { record_version: 1, target: "feed", desired_identity: feedIdentity, applied_identity: prior?.applied_identity ?? null,
      attempt_revision: null, state: "pending", trigger, error: null, notification: null };
    storage.sql.exec("INSERT INTO publication_outcomes (target, state, record_json) VALUES ('feed', 'pending', ?) ON CONFLICT(target) DO UPDATE SET state = excluded.state, record_json = excluded.record_json", JSON.stringify(outcome));
    return { refs, unresolvedEligible, unresolvedWithdrawal, skip: false, recoverCover: prior?.state !== "applied" };
  });
  if (!before) return "pending";
  if (before.skip) {
    return storage.transaction(async () => {
      const control = readShowControl(storage, showId);
      if (!control || control.revision !== candidate.revision) return "pending";
      const next = nextScheduledAlarm(storage.sql, control, Date.now());
      if (next === null) await storage.deleteAlarm();
      else await storage.setAlarm(next);
      return "failed";
    });
  }

  let failure: { target: string; message: string } | undefined;
  let target = "feed";
  const previousFeed = before.refs.get("feed");
  const feedPath = `/${showId}/feed.xml`;
  const coverPath = `/${candidate.coverPath}`;
  const mediaPaths: string[] = [];
  const touchedEpisodes = new Set<string>(before.unresolvedEligible);
  try {
    const needsCover = (!candidate.snapshot || canonicalJson(candidate.snapshot.show) === canonicalJson(candidate.control.metadata)) && ((!candidate.targeted && trigger === "recover" && before.recoverCover) || !previousFeed?.public_paths.includes(coverPath));
    const needsAudio = (item: typeof candidate.episodes[number]) => item.state === "eligible" &&
      ((trigger === "recover" && (candidate.targeted || before.unresolvedEligible.has(item.id))) || !before.refs.get(item.id)?.sources.some(ref => canonicalJson(ref) === canonicalJson(item.audio)));
    if (Number(needsCover) + candidate.episodes.filter(needsAudio).length > MAX_PUBLICATION_COPIES) throw new Error(`Publication exceeds the current limit of ${MAX_PUBLICATION_COPIES} media copies per attempt`);
    let group: CopyItem[] = [];
    const flush = async () => {
      if (!group.length) return;
      const current = group; group = [];
      // A failed group does not identify which member failed; all touched
      // eligible episodes remain incomplete, while reservations stay intact.
      target = "feed";
      if (copyGroup) await copyGroup(current);
      else for (const item of current) await copy(item.source, item.path, item.mime);
    };
    const queue = async (item: CopyItem) => { group.push(item); if (group.length === COPY_GROUP_SIZE) await flush(); };
    if (needsCover) {
      await bucket.delete(candidate.coverPath);
      const mime = candidate.coverPath.endsWith(".png") ? "image/png" as const : "image/jpeg" as const;
      await queue({ source: candidate.cover, path: candidate.coverPath, mime });
      mediaPaths.push(coverPath);
    }
    for (const item of candidate.episodes) {
      target = item.id;
      const path = `/${showId}/${item.id}/audio.mp3`;
      const previous = before.refs.get(item.id);
      if (item.state === "eligible") {
        if (!item.audio || !item.metadata) throw new IdentityConflict("Eligible episode has no selected source");
        if (needsAudio(item)) {
          touchedEpisodes.add(item.id);
          await bucket.delete(path.slice(1));
          await queue({ source: item.audio, path: path.slice(1), mime: "audio/mpeg" });
          mediaPaths.push(path);
        }
      } else if (trigger === "recover" || previous || before.unresolvedWithdrawal.has(item.id)) {
        // A previous attempt may have copied audio and failed before it could
        // commit a delivery reference. Non-eligible intent must remove that
        // possible leftover even when the ledger has no public reference.
        if (item.state !== "failed") touchedEpisodes.add(item.id);
        await bucket.delete(path.slice(1));
        mediaPaths.push(path);
      }
    }
    await flush();
    target = "feed";
    // A large restore or recovery can affect hundreds of objects. Purging the
    // Show prefix bounds API calls while remaining isolated from other Shows.
    if (mediaPaths.length > 25) await purge([`/${showId}/`]);
    else if (mediaPaths.length) await purge(mediaPaths);
    await bucket.delete(feedPath.slice(1));
    await bucket.put(feedPath.slice(1), candidate.feed, { httpMetadata: { contentType: "application/rss+xml; charset=utf-8", cacheControl: "public, max-age=0, s-maxage=2592000, must-revalidate" } });
    await purge([feedPath]);
    const oldCovers = previousFeed?.public_paths.filter(path => path.startsWith(`/${showId}/covers/`) && path !== coverPath) ?? [];
    for (const path of oldCovers) await bucket.delete(path.slice(1));
    for (let offset = 0; offset < oldCovers.length; offset += 25) await purge(oldCovers.slice(offset, offset + 25));
  } catch (error) {
    failure = { target, message: error instanceof Error ? error.message : "Delivery failed" };
    console.error(JSON.stringify({ event: "publication_failed", show_id: showId, target, ...(target.startsWith("e-") ? { episode_id: target } : {}),
      revision: candidate.revision, operation_id: candidate.control.last_receipt?.operation_id ?? null, trigger, code: "delivery_failed", error: failure.message }));
  }

  return storage.transaction(async () => {
    const control = readShowControl(storage, showId);
    const feedRow = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = 'feed'").toArray()[0];
    const feedOutcome = feedRow && JSON.parse(feedRow.record_json) as Outcome;
    if (!control || control.revision !== candidate.revision || !feedOutcome || feedOutcome.desired_identity !== feedIdentity) return "pending";
    if (canonicalJson(control.pending_delivery) !== canonicalJson(candidate.control.pending_delivery)) return "pending";
    for (const item of candidate.episodes) {
      const row = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", item.id).toArray()[0];
      const outcome = row && JSON.parse(row.record_json) as Outcome;
      if (!outcome || outcome.desired_identity !== item.desiredIdentity) return "pending";
    }
    const now = Date.now();
    feedOutcome.attempt_revision = candidate.revision;
    feedOutcome.trigger = trigger;
    feedOutcome.state = failure ? "failed" : "applied";
    feedOutcome.error = failure ? { code: "delivery_failed", message: failure.message.startsWith("Publication exceeds the current limit of ") ? failure.message : "Feed publication did not complete", operation_id: control.last_receipt?.operation_id ?? null, at: now } : null;
    feedOutcome.notification = failure ? "unconfigured" : null;
    if (!failure) feedOutcome.applied_identity = feedIdentity;
    storage.sql.exec("UPDATE publication_outcomes SET state = ?, record_json = ? WHERE target = 'feed'", feedOutcome.state, JSON.stringify(feedOutcome));
    for (const item of candidate.episodes) {
      const row = storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", item.id).one();
      const outcome = JSON.parse(row.record_json) as Outcome;
      if (failure) {
        // A different episode's copy/delete failure must not cancel a future
        // reservation merely because this batch inspected its public path.
        if (item.state === "scheduled" && failure.target !== item.id) continue;
        if (failure.target !== item.id && !touchedEpisodes.has(item.id)) continue;
        outcome.state = "failed";
        outcome.attempt_revision = candidate.revision;
        outcome.trigger = trigger;
        outcome.error = { code: "delivery_failed", message: "Episode publication did not complete", operation_id: control.last_receipt?.operation_id ?? null, at: now };
        outcome.notification = "unconfigured";
      } else if (item.state !== "failed" && item.state !== "scheduled") {
        outcome.state = item.state === "invalid" ? "blocked" : "applied";
        outcome.attempt_revision = candidate.revision;
        outcome.trigger = trigger;
        outcome.error = null;
        outcome.notification = null;
        if (outcome.state === "applied") outcome.applied_identity = outcome.desired_identity;
        if (item.state === "eligible") {
          const ref: DeliveryRef = { record_version: 1, target: item.id, identity: item.desiredIdentity, sources: [item.metadata!, item.audio!], public_paths: [`/${showId}/${item.id}/audio.mp3`], applied_at: now };
          storage.sql.exec("INSERT INTO delivery_refs VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET record_json = excluded.record_json", item.id, JSON.stringify(ref));
        } else storage.sql.exec("DELETE FROM delivery_refs WHERE target = ?", item.id);
      } else if (item.state === "scheduled" || item.state === "failed") {
        // These episodes are absent from the new feed and their public audio
        // was removed; preserve a known failure without keeping stale refs.
        storage.sql.exec("DELETE FROM delivery_refs WHERE target = ?", item.id);
        if (item.state === "scheduled" && trigger === "recover") {
          outcome.state = "pending";
          outcome.attempt_revision = candidate.revision;
          outcome.trigger = trigger;
          outcome.error = null;
          outcome.notification = null;
        }
      }
      storage.sql.exec("UPDATE publication_outcomes SET state = ?, record_json = ? WHERE target = ?", outcome.state, JSON.stringify(outcome), item.id);
    }
    if (!failure) {
      const sources = candidate.snapshot ? [candidate.snapshot.show, candidate.snapshot.cover, ...candidate.snapshot.episodes.flatMap(item => [item.metadata, item.audio])]
        : [candidate.control.metadata!, candidate.cover, ...eligible.flatMap(item => [item.metadata!, item.audio!])];
      const ref: DeliveryRef = { record_version: 1, target: "feed", identity: feedIdentity, sources, public_paths: [feedPath, coverPath], applied_at: now, ...(candidate.snapshot ? { snapshot: candidate.snapshot } : {}) };
      storage.sql.exec("INSERT INTO delivery_refs VALUES ('feed', ?) ON CONFLICT(target) DO UPDATE SET record_json = excluded.record_json", JSON.stringify(ref));
      // A withdrawal can use the last valid feed while the current Show is
      // invalid. Keep a pending migration until a feed for its target is ready.
      if (control.pending_delivery && candidate.snapshot?.base === control.pending_delivery.base) {
        const pending = control.pending_delivery;
        if (pending.base !== control.current_delivery.base) {
          control.current_delivery = { base: pending.base, previous_base: control.current_delivery.base, migration_operation_id: pending.migration_operation_id, applied_revision: candidate.revision };
        }
        control.pending_delivery = null;
        storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(control));
      }
    }
    if (!candidate.targeted && control.last_receipt?.response.accepted_revision === candidate.revision) {
      control.last_receipt.response.delivery = failure ? "failed" : "applied";
      storage.sql.exec("UPDATE show_control SET record_json = ? WHERE singleton = 1", JSON.stringify(control));
    }
    let nextAlarm = nextScheduledAlarm(storage.sql, control, now);
    // A reservation can become due after the candidate was captured but
    // before this batch finishes. Its scheduled entry was not published by
    // this batch, so arrange a fresh alarm instead of dropping it as overdue.
    if (control.scheduling?.enabled && candidate.episodes.some(item => item.state === "scheduled" && item.at !== undefined && item.at <= now &&
      (!failure || failure.target !== item.id))) {
      const recheck = now + 1000;
      nextAlarm = nextAlarm === null ? recheck : Math.min(nextAlarm, recheck);
    }
    if (nextAlarm === null) await storage.deleteAlarm();
    else await storage.setAlarm(nextAlarm);
    return failure ? "failed" : "applied";
  });
}
