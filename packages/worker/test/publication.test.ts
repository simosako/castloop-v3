/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { ShowDO } from "../src";
import type { ShowControl } from "../src/storage";
import { applyCandidate, withdrawDeletedShow } from "../src/publication";

function seed(state: DurableObjectState, showId: string, deleted: boolean): void {
  const ref = { key: "source", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  const response = { protocol_version: 1 as const, operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1, acceptance: "accepted" as const, validation_issues: [], delivery: "pending" as const };
  const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted, accepted_at: 1,
    last_receipt: { operation_id: response.operation_id, fingerprint: "hash", response }, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
  const outcome = { record_version: 1, target: "show-withdrawal", desired_identity: "a".repeat(64), applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
  state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
  state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, ?, ?)", "show-withdrawal", "pending", JSON.stringify(outcome));
  state.storage.sql.exec("INSERT INTO delivery_refs VALUES (?, ?)", "feed", JSON.stringify({ target: "feed", public_paths: [`/${showId}/feed.xml`] }));
}

test("a reservation that becomes due during publication retains an alarm", async () => {
  const showId = "s-23456789", episodeId = "e-23456789";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.scheduling = { enabled: true, serial: false };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const at = Date.now() - 1000;
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episodeId, "stable-guid", JSON.stringify({ deleted: false, publish: true, time: { instant_ms: at }, scheduling: { ready: true, serial_ready: true } }));
    const outcome = { record_version: 1, target: episodeId, desired_identity: "scheduled", applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", episodeId, JSON.stringify(outcome));
    const coverPath = `${showId}/covers/image.png`;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ target: "feed", sources: [control.metadata], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`] }));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, state: "scheduled" as const, desiredIdentity: "scheduled", at }],
      feed: "<rss/>", cover: control.metadata!, coverPath, nextAlarm: at, release: () => {} };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async () => {})).toBe("applied");
    expect(await state.storage.getAlarm()).not.toBeNull();
    await state.storage.deleteAlarm();
  });
});

test("a deletion accepted while an earlier publication is running remains pending", async () => {
  const showId = "s-3456789a";
  await runInDurableObject(env.SHOWS.getByName(showId), async (instance: ShowDO, state) => {
    seed(state, showId, false);
    // Model an older batch finishing after a new deletion has been accepted.
    Object.assign(instance, { runner: Promise.resolve("blocked") });
    const result = await instance.operation(showId, { protocol_version: 1, operation_id: "22345678-1234-4234-8234-123456789abc", expected_revision: 1,
      action: "show.delete", payload: { confirmed: true } });
    expect(result).toMatchObject({ ok: true, data: { acceptance: "accepted", delivery: "pending" } });
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control.deleted).toBe(true);
    expect(control.last_receipt?.response.delivery).toBe("pending");
  });
});

test("an alarm overlapping an older batch retains a due reservation", async () => {
  const showId = "s-456789ab", episodeId = "e-456789ab";
  await runInDurableObject(env.SHOWS.getByName(showId), async (instance: ShowDO, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.scheduling = { enabled: true, serial: false };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episodeId, "stable-guid", JSON.stringify({ deleted: false, publish: true, time: { instant_ms: Date.now() - 1000 }, scheduling: { ready: true, serial_ready: true } }));
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", episodeId, JSON.stringify({ target: episodeId, state: "pending" }));
    Object.assign(instance, { runner: Promise.resolve("pending") });
    await instance.alarm();
    expect(await state.storage.getAlarm()).not.toBeNull();
    await state.storage.deleteAlarm();
  });
});

test("an overlapping alarm does not retry a failed reservation", async () => {
  const showId = "s-56789abc", episodeId = "e-56789abc";
  await runInDurableObject(env.SHOWS.getByName(showId), async (instance: ShowDO, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.scheduling = { enabled: true, serial: false };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episodeId, "stable-guid", JSON.stringify({ deleted: false, publish: true, time: { instant_ms: Date.now() - 1000 }, scheduling: { ready: true, serial_ready: true } }));
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'failed', ?)", episodeId, JSON.stringify({ target: episodeId, state: "failed" }));
    Object.assign(instance, { runner: Promise.resolve("failed") });
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("an unrelated audio failure does not cancel a future reservation", async () => {
  const showId = "s-zzzzzzzz", futureId = "e-01234567", failedId = "e-12345678";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.scheduling = { enabled: true, serial: false };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const at = Date.now() + 60_000;
    for (const [id, time] of [[futureId, at], [failedId, Date.now() - 1000]] as const) {
      state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", id, `guid-${id}`, JSON.stringify({ deleted: false, publish: true, time: { instant_ms: time }, scheduling: { ready: true, serial_ready: true } }));
      const outcome = { record_version: 1, target: id, desired_identity: id, applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
      state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", id, JSON.stringify(outcome));
    }
    const coverPath = `${showId}/covers/image.png`, ref = control.metadata!;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ target: "feed", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`] }));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [
      { id: futureId, state: "scheduled" as const, desiredIdentity: futureId, at },
      { id: failedId, state: "eligible" as const, desiredIdentity: failedId, audio: ref, metadata: ref },
    ], feed: "<rss/>", cover: ref, coverPath, nextAlarm: at, release: () => {} };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => { throw new Error("injected audio failure"); }, async () => {})).toBe("failed");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", failedId).one().state).toBe("failed");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", futureId).one().state).toBe("pending");
    expect(await state.storage.getAlarm()).toBe(at);
    await state.storage.deleteAlarm();
  });
});

test("a failed delegated group is recovered by deleting and copying every affected episode again", async () => {
  const showId = "s-vvvv1111";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    const ref = control.metadata!, coverPath = `${showId}/covers/image.png`;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ target: "feed", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`] }));
    const episodes = Array.from({ length: 31 }, (_, i) => ({ id: `e-${i.toString(16).padStart(8, "0")}`, state: "eligible" as const, desiredIdentity: `id-${i}`, audio: ref, metadata: ref }));
    for (const item of episodes) {
      const outcome = { record_version: 1, target: item.id, desired_identity: item.desiredIdentity, applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
      state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", item.id, JSON.stringify(outcome));
    }
    const candidate = { state: "ready" as const, revision: 1, control, episodes, feed: "<rss>new</rss>", cover: ref, coverPath, nextAlarm: null, release: () => {} };
    await env.DELIVERY_BUCKET.put(`${showId}/feed.xml`, "<rss>old</rss>");
    let groups = 0;
    const noDirectCopy = async () => { throw new Error("Unexpected direct copy"); };
    const first = await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, noDirectCopy, async () => {}, "acceptance", async items => {
      groups++;
      for (const item of items) await env.DELIVERY_BUCKET.put(item.path, "partial");
      if (groups === 8) throw new Error("response lost after copy");
    });
    expect(first).toBe("failed");
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toBe("<rss>old</rss>");
    const deleted = new Set<string>(), copied: string[] = [];
    const bucket = { delete: async (key: string) => { deleted.add(key); await env.DELIVERY_BUCKET.delete(key); },
      put: (key: string, value: string, options: R2PutOptions) => env.DELIVERY_BUCKET.put(key, value, options) } as unknown as R2Bucket;
    expect(await applyCandidate(state.storage, bucket, showId, candidate, noDirectCopy, async () => {}, "recover", async items => {
      for (const item of items) {
        expect(deleted.has(item.path)).toBe(true);
        copied.push(item.path);
        await env.DELIVERY_BUCKET.put(item.path, "recovered");
      }
    })).toBe("applied");
    expect(copied.filter(path => path.endsWith("/audio.mp3"))).toHaveLength(31);
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toBe("<rss>new</rss>");
  });
});

test("a feed write failure stays failed until an explicit recovery rebuilds it", async () => {
  const showId = "s-yyyyyyyy";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    const coverPath = `${showId}/covers/image.png`, feedPath = `${showId}/feed.xml`, ref = control.metadata!;
    const oldRef = { record_version: 1, target: "feed", identity: "old", sources: [ref], public_paths: [`/${feedPath}`, `/${coverPath}`], applied_at: 1 };
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify(oldRef));
    await env.DELIVERY_BUCKET.put(feedPath, "old feed");
    let writes = 0;
    const failingBucket = { delete: env.DELIVERY_BUCKET.delete.bind(env.DELIVERY_BUCKET), put: async () => { writes++; throw new Error("injected feed write failure"); } } as unknown as R2Bucket;
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [], feed: "<rss>new feed</rss>", cover: ref, coverPath, nextAlarm: null, release: () => {} };
    expect(await applyCandidate(state.storage, failingBucket, showId, candidate, async () => {}, async () => {})).toBe("failed");
    expect(await env.DELIVERY_BUCKET.head(feedPath)).toBeNull();
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'feed'").one().state).toBe("failed");
    expect(JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM delivery_refs WHERE target = 'feed'").one().record_json)).toEqual(oldRef);
    expect(await applyCandidate(state.storage, failingBucket, showId, candidate, async () => {}, async () => {})).toBe("failed");
    expect(writes).toBe(1);
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async () => {}, "recover")).toBe("applied");
    expect(await (await env.DELIVERY_BUCKET.get(feedPath))!.text()).toBe(candidate.feed);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'feed'").one().state).toBe("applied");
  });
});

test("withdrawal deletes only public show objects, records failure and restarts on explicit recovery", async () => {
  const showId = "s-01234567";
  const publicKeys = [`${showId}/feed.xml`, `${showId}/e-01234567/audio.mp3`, `${showId}/covers/1.jpg`];
  for (const key of publicKeys) await env.DELIVERY_BUCKET.put(key, "public");
  await env.DELIVERY_BUCKET.put("s-76543210/feed.xml", "other");
  await env.MANAGEMENT_BUCKET.put(`${showId}/private-source`, "private");
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    seed(state, showId, true);
    let calls = 0;
    const failPurge = async (paths: string[]) => { calls++; expect(paths).toEqual([`/${showId}/`]); throw new Error("injected purge failure"); };
    expect(await withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, failPurge)).toBe("failed");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").one().state).toBe("failed");
    expect(await withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, failPurge)).toBe("failed");
    expect(calls).toBe(1);
    expect(state.storage.sql.exec("SELECT target FROM delivery_refs").toArray()).toHaveLength(1);
    expect(await withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, async () => { calls++; }, "recover")).toBe("applied");
    expect(calls).toBe(2);
    expect(state.storage.sql.exec("SELECT target FROM delivery_refs").toArray()).toHaveLength(0);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control.last_receipt?.response.delivery).toBe("applied");
  });
  for (const key of publicKeys) expect(await env.DELIVERY_BUCKET.head(key)).toBeNull();
  expect(await env.DELIVERY_BUCKET.head("s-76543210/feed.xml")).not.toBeNull();
  expect(await env.MANAGEMENT_BUCKET.head(`${showId}/private-source`)).not.toBeNull();
});

test("public route uses the committed URL and treats deleted or held shows as missing", async () => {
  const showId = "s-abcdefgh";
  await runInDurableObject(env.SHOWS.getByName(showId), async (instance: ShowDO, state) => {
    seed(state, showId, false);
    let control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.current_delivery.base = "https://delivery.example.test";
    control.pending_delivery = { base: "https://pending.example.test", migration_operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    expect(await instance.publicRoute(showId)).toEqual({ state: "serve", base: null });
    control.deleted = true;
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    expect(await instance.publicRoute(showId)).toEqual({ state: "missing", base: null });
    control = { ...control, deleted: false, restore_hold: true };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    expect(await instance.publicRoute(showId)).toEqual({ state: "missing", base: null });
  });
});

test("migration cuts over only after purge succeeds without copying unchanged audio", async () => {
  const showId = "s-bcdefghj", episodeId = "e-01234567";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.pending_delivery = { base: "https://podcasts.example.com", migration_operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const ref = control.metadata!;
    const coverPath = `${showId}/covers/image.png`;
    const audioPath = `/${showId}/${episodeId}/audio.mp3`;
    const audioRef = { record_version: 1, target: episodeId, identity: "episode-identity", sources: [ref], public_paths: [audioPath], applied_at: 1 };
    const feedRef = { record_version: 1, target: "feed", identity: "old-feed", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`], applied_at: 1 };
    state.storage.sql.exec("INSERT INTO delivery_refs VALUES (?, ?)", episodeId, JSON.stringify(audioRef));
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify(feedRef));
    const outcome = { record_version: 1, target: episodeId, desired_identity: "episode-identity", applied_identity: "episode-identity", attempt_revision: 1, state: "applied", trigger: "acceptance", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'applied', ?)", episodeId, JSON.stringify(outcome));
    const entry = { id: episodeId, identity: "episode-identity", metadata: ref, audio: ref, guid: "stable", publishedAt: 1, durationMs: 1000 };
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, desiredIdentity: "episode-identity", state: "eligible" as const, audio: ref, metadata: ref }],
      feed: "<rss/>", cover: ref, coverPath, nextAlarm: null, snapshot: { show: ref, cover: ref, coverPath, base: "https://podcasts.example.com", episodes: [entry] }, release: () => {} };
    let copies = 0;
    const copy = async (_source: unknown, _path: string, mime: string) => { if (mime === "audio/mpeg") copies++; };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, copy, async () => { throw new Error("purge failed"); })).toBe("failed");
    let after = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(after.current_delivery.base).toBe("https://example.test");
    expect(after.pending_delivery?.base).toBe("https://podcasts.example.com");
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, copy, async () => {}, "recover")).toBe("applied");
    after = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(after.current_delivery).toMatchObject({ base: "https://podcasts.example.com", previous_base: "https://example.test" });
    expect(after.pending_delivery).toBeNull();
    expect(copies).toBe(0);
  });
});

test("a newer migration intent accepted during feed purge cannot be overwritten by the old candidate", async () => {
  const showId = "s-ghjkmnpq";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.pending_delivery = { base: "https://podcasts.example.com", migration_operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const ref = control.metadata!, coverPath = `${showId}/covers/image.png`;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ record_version: 1, target: "feed", identity: "old", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`], applied_at: 1 }));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [], feed: "<rss>new domain</rss>", cover: ref, coverPath, nextAlarm: null,
      snapshot: { show: ref, cover: ref, coverPath, base: "https://podcasts.example.com", episodes: [] }, release: () => {} };
    const result = await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async paths => {
      if (!paths.includes(`/${showId}/feed.xml`)) return;
      const newer = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
      newer.revision = 2;
      newer.pending_delivery = { base: newer.current_delivery.base, migration_operation_id: "22345678-1234-4234-8234-123456789abc", accepted_revision: 2 };
      state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ?", JSON.stringify(newer));
    });
    expect(result).toBe("pending");
    const newer = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(newer.current_delivery.base).toBe("https://example.test");
    expect(newer.pending_delivery).toMatchObject({ base: "https://example.test", accepted_revision: 2 });
    const recovery = { ...candidate, revision: 2, control: newer, feed: "<rss>old domain</rss>", snapshot: { ...candidate.snapshot, base: newer.current_delivery.base } };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, recovery, async () => {}, async () => {}, "recover")).toBe("applied");
    const after = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(after.current_delivery.base).toBe("https://example.test");
    expect(after.pending_delivery).toBeNull();
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toBe("<rss>old domain</rss>");
  });
});

test("withdrawal with a last valid feed does not cut over a pending migration", async () => {
  const showId = "s-cdefghjk", episodeId = "e-01234567";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.pending_delivery = { base: "https://podcasts.example.com", migration_operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const ref = control.metadata!, coverPath = `${showId}/covers/image.png`, audioPath = `/${showId}/${episodeId}/audio.mp3`;
    const outcome = { record_version: 1, target: episodeId, desired_identity: "withdrawn", applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, ?, ?)", episodeId, "pending", JSON.stringify(outcome));
    state.storage.sql.exec("INSERT INTO delivery_refs VALUES (?, ?)", episodeId, JSON.stringify({ record_version: 1, target: episodeId, identity: "old", sources: [ref], public_paths: [audioPath], applied_at: 1 }));
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ record_version: 1, target: "feed", identity: "old", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`], applied_at: 1 }));
    await env.DELIVERY_BUCKET.put(audioPath.slice(1), "audio");
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, desiredIdentity: "withdrawn", state: "withdraw" as const }],
      feed: "<rss/>", cover: ref, coverPath, nextAlarm: null, snapshot: { show: ref, cover: ref, coverPath, base: control.current_delivery.base, episodes: [] }, release: () => {} };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => { throw new Error("Unexpected copy"); }, async () => {})).toBe("applied");
    expect(await env.DELIVERY_BUCKET.head(audioPath.slice(1))).toBeNull();
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toBe("<rss/>");
    const after = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(after.current_delivery.base).toBe("https://example.test");
    expect(after.pending_delivery?.base).toBe("https://podcasts.example.com");
  });
});

test("cancelling a pending migration preserves the committed origin history", async () => {
  const showId = "s-defghjkm";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.current_delivery.previous_base = "https://previous.example.test";
    control.pending_delivery = { base: control.current_delivery.base, migration_operation_id: "12345678-1234-4234-8234-123456789abc", accepted_revision: 1 };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const ref = control.metadata!, coverPath = `${showId}/covers/image.png`;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ record_version: 1, target: "feed", identity: "old", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`], applied_at: 1 }));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [], feed: "<rss/>", cover: ref, coverPath, nextAlarm: null,
      snapshot: { show: ref, cover: ref, coverPath, base: control.current_delivery.base, episodes: [] }, release: () => {} };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async () => {})).toBe("applied");
    const after = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(after.current_delivery).toEqual(control.current_delivery);
    expect(after.pending_delivery).toBeNull();
  });
});

test("invalid episode removes audio left by an uncommitted previous attempt", async () => {
  const showId = "s-efghjkmn", episodeId = "e-01234567";
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance, state) => {
    seed(state, showId, false);
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    const ref = control.metadata!, coverPath = `${showId}/covers/image.png`, audioPath = `/${showId}/${episodeId}/audio.mp3`;
    state.storage.sql.exec("UPDATE delivery_refs SET record_json = ? WHERE target = 'feed'", JSON.stringify({ record_version: 1, target: "feed", identity: "old", sources: [ref], public_paths: [`/${showId}/feed.xml`, `/${coverPath}`], applied_at: 1 }));
    const outcome = { record_version: 1, target: episodeId, desired_identity: "invalid", applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, ?, ?)", episodeId, "pending", JSON.stringify(outcome));
    await env.DELIVERY_BUCKET.put(audioPath.slice(1), "leftover from failed copy");
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, desiredIdentity: "invalid", state: "invalid" as const }],
      feed: "<rss/>", cover: ref, coverPath, nextAlarm: null, snapshot: { show: ref, cover: ref, coverPath, base: control.current_delivery.base, episodes: [] }, release: () => {} };
    const purged: string[] = [];
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => { throw new Error("Unexpected copy"); }, async paths => { purged.push(...paths); })).toBe("applied");
    expect(await env.DELIVERY_BUCKET.head(audioPath.slice(1))).toBeNull();
    expect(purged).toContain(audioPath);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", episodeId).one().state).toBe("blocked");
    const laterPurges: string[] = [];
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async paths => { laterPurges.push(...paths); })).toBe("applied");
    expect(laterPurges).not.toContain(audioPath);
    // An older in-flight publication can finish after withdrawal; explicit
    // recovery must remove the stale copy even after the outcome was blocked.
    await env.DELIVERY_BUCKET.put(audioPath.slice(1), "late stale copy");
    const recoveryPurges: string[] = [];
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async paths => { recoveryPurges.push(...paths); }, "recover")).toBe("applied");
    expect(await env.DELIVERY_BUCKET.head(audioPath.slice(1))).toBeNull();
    expect(recoveryPurges).toContain(audioPath);
  });
});

test("withdrawal refuses an active show and does not mark newer intent complete", async () => {
  const showId = "s-12345678";
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    seed(state, showId, false);
    await expect(withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, async () => {})).rejects.toThrow("not withdrawal");
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.deleted = true;
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    const result = await withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, async () => {
      control.revision = 2;
      state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ?", JSON.stringify(control));
    });
    expect(result).toBe("pending");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").one().state).toBe("pending");
    expect(state.storage.sql.exec("SELECT target FROM delivery_refs").toArray()).toHaveLength(1);
  });
});

test("withdrawal removes all public objects across multiple R2 listing pages", async () => {
  const showId = "s-6789abcd";
  const keys = Array.from({ length: 1005 }, (_, index) => `${showId}/episode-${String(index).padStart(4, "0")}/audio.mp3`);
  for (let index = 0; index < keys.length; index += 50) {
    await Promise.all(keys.slice(index, index + 50).map(key => env.DELIVERY_BUCKET.put(key, "audio")));
  }
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    seed(state, showId, true);
    expect(await withdrawDeletedShow(state.storage, env.DELIVERY_BUCKET, showId, async () => {})).toBe("applied");
  });
  expect((await env.DELIVERY_BUCKET.list({ prefix: `${showId}/` })).objects).toHaveLength(0);
}, 20_000);

test("a concurrent accepted revision cannot be marked applied by an older publication", async () => {
  const showId = "s-789abcde";
  const episodeId = "e-01234567";
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    seed(state, showId, false);
    state.storage.sql.exec("DELETE FROM delivery_refs");
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    const ref = control.metadata!;
    const episodeOutcome = { record_version: 1, target: episodeId, desired_identity: "episode-identity", applied_identity: null, attempt_revision: null, state: "pending", trigger: "acceptance", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", episodeId, JSON.stringify(episodeOutcome));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, desiredIdentity: "episode-identity", state: "eligible" as const, audio: ref, metadata: ref }],
      feed: "<rss/>", cover: ref, coverPath: `${showId}/covers/image.png`, nextAlarm: null, release: () => {} };
    const result = await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async paths => {
      if (paths.includes(`/${showId}/feed.xml`)) {
        control.revision = 2;
        state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ? WHERE singleton = 1", JSON.stringify(control));
      }
    });
    expect(result).toBe("pending");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", episodeId).one().state).toBe("pending");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'feed'").one().state).toBe("pending");
    expect(state.storage.sql.exec("SELECT target FROM delivery_refs").toArray()).toHaveLength(0);
  });
});

test("a media purge failure marks affected releases failed and does not advertise them", async () => {
  const showId = "s-9abcdefg";
  const episodeId = "e-01234567";
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    seed(state, showId, false);
    state.storage.sql.exec("DELETE FROM delivery_refs");
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    const ref = control.metadata!;
    const outcome = { record_version: 1, target: episodeId, desired_identity: "episode-identity", applied_identity: null, attempt_revision: null, state: "pending", trigger: "alarm", error: null, notification: null };
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'pending', ?)", episodeId, JSON.stringify(outcome));
    const candidate = { state: "ready" as const, revision: 1, control, episodes: [{ id: episodeId, desiredIdentity: "episode-identity", state: "eligible" as const, audio: ref, metadata: ref }],
      feed: "<rss/>", cover: ref, coverPath: `${showId}/covers/image.png`, nextAlarm: null, release: () => {} };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, showId, candidate, async () => {}, async () => { throw new Error("injected purge failure"); }, "alarm")).toBe("failed");
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ event: "publication_failed", show_id: showId, target: "feed", revision: 1,
        operation_id: "12345678-1234-4234-8234-123456789abc", trigger: "alarm", code: "delivery_failed" });
    } finally { log.mockRestore(); }
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", episodeId).one().state).toBe("failed");
    expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
    expect(state.storage.sql.exec("SELECT target FROM delivery_refs").toArray()).toHaveLength(0);
  });
});
