/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test, vi } from "vitest";
import type { ShowControl } from "../src/storage";
import type { ShowDO } from "../src";
import { operationSchema } from "@castloop/domain";
import { acceptShowMetadata } from "../src/show";

test("show listing verifies discovered prefixes against durable state", async () => {
  const live = "s-11111111", deleted = "s-22222222", orphan = "s-33333333";
  const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
  for (const [showId, isDeleted] of [[live, false], [deleted, true]] as const) {
    await env.MANAGEMENT_BUCKET.put(`${showId}/source`, "private");
    await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
      const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: isDeleted, accepted_at: 1,
        last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
      state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    });
  }
  await env.MANAGEMENT_BUCKET.put(`${orphan}/temporary`, "private");
  expect((await SELF.fetch("https://example.test/v1/shows")).status).toBe(401);
  const response = await SELF.fetch("https://example.test/v1/shows", { headers: { authorization: "Bearer local-test-token" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as { shows: { show_id: string; revision: number; deleted: boolean }[]; incomplete: boolean };
  expect(body.shows).toEqual(expect.arrayContaining([{ show_id: live, revision: 1, deleted: false }, { show_id: deleted, revision: 1, deleted: true }]));
  expect(body.shows.some(item => item.show_id === orphan)).toBe(false);
  expect(body.incomplete).toBe(false);
  expect((await SELF.fetch("https://example.test/v1/shows?bad=1", { headers: { authorization: "Bearer local-test-token" } })).status).toBe(400);
});

test("snapshot endpoint requires a token and reads the deterministically addressed show", async () => {
  const showId = "s-01234567";
  const path = `https://example.test/v1/shows/${showId}/snapshot`;
  expect((await SELF.fetch(path)).status).toBe(401);
  expect((await SELF.fetch(path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  const headers = { authorization: "Bearer local-test-token" };
  expect((await SELF.fetch(path, { headers })).status).toBe(404);
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const ref = { key: "key", etag: '"etag"', size: 5, sha256: "a".repeat(64) };
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false,
      accepted_at: 1, last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, ?, ?)", showId, 1, JSON.stringify(control));
  });
  const response = await SELF.fetch(path, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ show_id: showId, revision: 1, episodes: [], next_cursor: null });
  expect((await SELF.fetch(`${path}?cursor=bad!`, { headers })).status).toBe(400);
  expect((await SELF.fetch(`${path}?other=value`, { headers })).status).toBe(400);
});

test("show metadata acceptance stores drafts, requires stop confirmation and recognizes a lost-response retry", async () => {
  const showId = "s-76543210";
  const path = `https://example.test/v1/shows/${showId}/operations`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  async function prepare(operationId: string, publish: boolean) {
    const key = `${showId}/_versions/${operationId}/show.toml`;
    const bytes = new TextEncoder().encode(`schema_version = 1\nid = "${showId}"\npublish = ${publish}\n`);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
    return { key, etag: object!.httpEtag, size: bytes.length, sha256 };
  }
  const firstId = "12345678-1234-4234-8234-123456789abc";
  const firstRef = await prepare(firstId, true);
  const first = { protocol_version: 1, operation_id: firstId, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: firstRef }, episodes: [] } };
  const accepted = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(first) });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 1, delivery: "blocked", validation_issues: expect.arrayContaining([expect.objectContaining({ path: "show.title" })]) });
  const duplicateFirst = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(first) });
  expect(await duplicateFirst.json()).toMatchObject({ acceptance: "already_accepted", accepted_revision: 1, delivery: "blocked" });
  // Simulate the delivery reference left by an earlier successful publication.
  await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
    state.storage.sql.exec("INSERT INTO delivery_refs VALUES (?, ?)", "feed", "{}");
  });
  await env.DELIVERY_BUCKET.put(`${showId}/feed.xml`, "previous feed");
  await env.DELIVERY_BUCKET.put(`${showId}/e-01234567/audio.mp3`, "previous audio");
  const secondId = "22345678-1234-4234-8234-123456789abc";
  const secondRef = await prepare(secondId, false);
  const stop = { protocol_version: 1, operation_id: secondId, expected_revision: 1, action: "metadata.batch", payload: { show: { mode: "update", metadata: secondRef }, episodes: [] } };
  const declined = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(stop) });
  expect(declined.status).toBe(400);
  expect(await declined.json()).toMatchObject({ acceptance: "rejected" });
  const confirmed = { ...stop, payload: { ...stop.payload, confirm_show_stop: true } };
  const done = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(confirmed) });
  expect(done.status).toBe(200);
  expect(await done.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 2, delivery: "applied" });
  expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
  expect(await env.DELIVERY_BUCKET.head(`${showId}/e-01234567/audio.mp3`)).toBeNull();
  await env.MANAGEMENT_BUCKET.delete(secondRef.key);
  const retry = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(confirmed) });
  expect(retry.status).toBe(200);
  expect(await retry.json()).toMatchObject({ acceptance: "already_accepted", accepted_revision: 2 });
});

test("malformed or inconsistent staged TOML is explicitly rejected before acceptance", async () => {
  const showId = "s-zzzzzzzy", path = `https://example.test/v1/shows/${showId}/operations`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const cases = [
    { operationId: "12345678-1234-4234-8234-123456789abc", text: "schema_version = [", status: 400, code: "malformed_input" },
    { operationId: "22345678-1234-4234-8234-123456789abc", text: `schema_version = 1\nid = "${showId}"\nunknown = true\n`, status: 400, code: "malformed_input" },
    { operationId: "32345678-1234-4234-8234-123456789abc", text: 'schema_version = 1\nid = "s-01234567"\n', status: 409, code: "identity_conflict" },
    { operationId: "42345678-1234-4234-8234-123456789abc", text: `schema_version = 1\nid = "${showId}"\n`, status: 409, code: "identity_conflict", wrongDigest: true },
  ];
  for (const item of cases) {
    const key = `${showId}/_versions/${item.operationId}/show.toml`, bytes = new TextEncoder().encode(item.text);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
    const operation = { protocol_version: 1, operation_id: item.operationId, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: { key, etag: object!.httpEtag, size: bytes.length, sha256: item.wrongDigest ? "0".repeat(64) : sha256 } }, episodes: [] } };
    const response = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(operation) });
    expect(response.status).toBe(item.status);
    expect(await response.json()).toMatchObject({ operation_id: item.operationId, acceptance: "rejected", issues: [expect.objectContaining({ code: item.code })] });
  }
  await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec("SELECT * FROM show_control").toArray()).toHaveLength(0);
  });
});

test("cover selection requires the accepted logical name and registers a verified source", async () => {
  const showId = "s-12345678";
  const path = `https://example.test/v1/shows/${showId}/operations`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const showIdOp = "12345678-1234-4234-8234-123456789abc";
  const showKey = `${showId}/_versions/${showIdOp}/show.toml`;
  const showBody = new TextEncoder().encode(`schema_version = 1\nid = "${showId}"\nartwork = "cover.png"\n`);
  const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  const showObject = await env.MANAGEMENT_BUCKET.put(showKey, showBody);
  const create = { protocol_version: 1, operation_id: showIdOp, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: { key: showKey, etag: showObject!.httpEtag, size: showBody.length, sha256: await hash(showBody) } }, episodes: [] } };
  expect((await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(create) })).status).toBe(200);
  const coverId = "22345678-1234-4234-8234-123456789abc";
  const coverBody = new TextEncoder().encode("cover fixture");
  const coverKey = `${showId}/_versions/${coverId}/cover.png`;
  const coverObject = await env.MANAGEMENT_BUCKET.put(coverKey, coverBody, { customMetadata: { sha256: await hash(coverBody) } });
  const cover = { protocol_version: 1, operation_id: coverId, expected_revision: 1, action: "cover.set", payload: { logical_name: "cover.png", cover: { key: coverKey, etag: coverObject!.httpEtag, size: coverBody.length, sha256: await hash(coverBody) }, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } } };
  const invalid = { ...cover, payload: { ...cover.payload, logical_name: "other.png" } };
  expect((await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(invalid) })).status).toBe(400);
  const mismatched = { ...cover, payload: { ...cover.payload, cover: { ...cover.payload.cover, sha256: "0".repeat(64) } } };
  const rejection = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(mismatched) });
  expect(rejection.status).toBe(409);
  expect(await rejection.json()).toMatchObject({ acceptance: "rejected", operation_id: coverId, issues: [expect.objectContaining({ code: "identity_conflict" })] });
  const accepted = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(cover) });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 2 });
  await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
    const row = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one();
    expect(JSON.parse(row.record_json).cover.ref.key).toBe(coverKey);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", coverKey).one().state).toBe("present");
  });
});

test("deleted-show purge failure stays failed until explicit recovery through the service binding", async () => {
  const showId = "s-3456789a";
  const endpoint = `https://example.test/v1/shows/${showId}`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const firstId = "12345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${firstId}/show.toml`;
  const bytes = new TextEncoder().encode(`schema_version = 1\nid = "${showId}"\n`);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
  const create = { protocol_version: 1, operation_id: firstId, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: { key, etag: object!.httpEtag, size: bytes.length, sha256 } }, episodes: [] } };
  expect((await SELF.fetch(`${endpoint}/operations`, { method: "POST", headers, body: JSON.stringify(create) })).status).toBe(200);
  await env.DELIVERY_BUCKET.put(`${showId}/feed.xml`, "old feed");
  const deletion = { protocol_version: 1, operation_id: "22345678-1234-4234-8234-123456789abc", expected_revision: 1, action: "show.delete", payload: { confirmed: true } };
  const first = await SELF.fetch(`${endpoint}/operations`, { method: "POST", headers, body: JSON.stringify(deletion) });
  expect(await first.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 2, delivery: "failed" });
  expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
  const duplicate = await SELF.fetch(`${endpoint}/operations`, { method: "POST", headers, body: JSON.stringify(deletion) });
  expect(await duplicate.json()).toMatchObject({ acceptance: "already_accepted", delivery: "failed" });
  const recovery = { protocol_version: 1, operation_id: "32345678-1234-4234-8234-123456789abc", expected_revision: 2 };
  const stale = await SELF.fetch(`${endpoint}/recover`, { method: "POST", headers, body: JSON.stringify({ ...recovery, expected_revision: 1 }) });
  expect(stale.status).toBe(409);
  const retried = await SELF.fetch(`${endpoint}/recover`, { method: "POST", headers, body: JSON.stringify(recovery) });
  expect(await retried.json()).toMatchObject({ operation_id: recovery.operation_id, observed_revision: 2, delivery: "applied" });
  expect(await env.MANAGEMENT_BUCKET.head(key)).not.toBeNull();
});

test("stopped-show withdrawal stays recoverable after an unrelated invalid metadata edit", async () => {
  const showId = "s-456789ab";
  const endpoint = `https://example.test/v1/shows/${showId}`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const prepare = async (operationId: string, publish: boolean, description: string) => {
    const key = `${showId}/_versions/${operationId}/show.toml`;
    const bytes = new TextEncoder().encode(`schema_version = 1\nid = "${showId}"\npublish = ${publish}\ndescription = "${description}"\n`);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
    return { key, etag: object!.httpEtag, size: bytes.length, sha256 };
  };
  const send = (operationId: string, revision: number, metadata: object, mode: "create" | "update", confirmed = false) => SELF.fetch(`${endpoint}/operations`, { method: "POST", headers,
    body: JSON.stringify({ protocol_version: 1, operation_id: operationId, expected_revision: revision, action: "metadata.batch", payload: { show: { mode, metadata }, episodes: [], ...(confirmed ? { confirm_show_stop: true } : {}) } }) });
  const id1 = "12345678-1234-4234-8234-123456789abc";
  expect((await send(id1, 0, await prepare(id1, true, "initial"), "create")).status).toBe(200);
  await env.DELIVERY_BUCKET.put(`${showId}/feed.xml`, "old feed");
  const id2 = "22345678-1234-4234-8234-123456789abc";
  const stop = await send(id2, 1, await prepare(id2, false, "stopped"), "update", true);
  expect(await stop.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 2, delivery: "failed" });
  const id3 = "32345678-1234-4234-8234-123456789abc";
  const edit = await send(id3, 2, await prepare(id3, false, "still stopped"), "update");
  expect(await edit.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 3, delivery: "failed" });
  const recovery = { protocol_version: 1, operation_id: "42345678-1234-4234-8234-123456789abc", expected_revision: 3 };
  const result = await SELF.fetch(`${endpoint}/recover`, { method: "POST", headers, body: JSON.stringify(recovery) });
  expect(await result.json()).toMatchObject({ observed_revision: 3, delivery: "applied" });
});

test("an existing show can be stopped even if the installation delivery base is unavailable", async () => {
  const showId = "s-56789abc";
  const stub = env.SHOWS.getByName(showId);
  const prepare = async (id: string, publish: boolean) => {
    const key = `${showId}/_versions/${id}/show.toml`;
    const bytes = new TextEncoder().encode(`schema_version = 1\nid = "${showId}"\npublish = ${publish}\n`);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
    return { key, etag: object!.httpEtag, size: bytes.length, sha256 };
  };
  const firstId = "12345678-1234-4234-8234-123456789abc";
  const stopId = "22345678-1234-4234-8234-123456789abc";
  const first = operationSchema.parse({ protocol_version: 1, operation_id: firstId, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: await prepare(firstId, true) }, episodes: [] } });
  const stop = operationSchema.parse({ protocol_version: 1, operation_id: stopId, expected_revision: 1, action: "metadata.batch", payload: { show: { mode: "update", metadata: await prepare(stopId, false) }, episodes: [], confirm_show_stop: true } });
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    await expect(acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "", showId, first)).rejects.toThrow("Delivery base is not configured");
    await acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "https://delivery.example.test", showId, first);
    const result = await acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "", showId, stop);
    expect(result).toMatchObject({ accepted_revision: 2, acceptance: "accepted" });
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control.current_delivery.base).toBe("https://delivery.example.test");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").one().state).toBe("pending");
  });
});

test("accepted show and audio changes invoke the publication executor through the management API", async () => {
  const showId = "s-89abcdef";
  const episodeId = "e-01234567";
  const endpoint = `https://example.test/v1/shows/${showId}/operations`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const copier = env.COPIER as unknown as { history(): Promise<string[]>; setFailure(path: string): Promise<void>; reset(): Promise<void> };
  await copier.reset();
  try {
    const id = (n: number | string) => `${n}2345678-1234-4234-8234-123456789abc`;
    const put = async (key: string, text: string) => {
      const bytes = new TextEncoder().encode(text);
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      const object = await env.MANAGEMENT_BUCKET.put(key, bytes, { customMetadata: { sha256 } });
      return { key, etag: object!.httpEtag, size: bytes.length, sha256 };
    };
    const send = async (revision: number, operationId: string, action: string, payload: object) => {
      const response = await SELF.fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ protocol_version: 1, operation_id: operationId, expected_revision: revision, action, payload }) });
      expect(response.status).toBe(200);
      return response.json() as Promise<{ acceptance: string; delivery: string }>;
    };
    const show = await put(`${showId}/_versions/${id(1)}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = "Show"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "UTC"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`);
    expect(await send(0, id(1), "metadata.batch", { show: { mode: "create", metadata: show }, episodes: [] })).toMatchObject({ acceptance: "accepted", delivery: "blocked" });
    const cover = await put(`${showId}/_versions/${id(2)}/cover.png`, "cover");
    expect(await send(1, id(2), "cover.set", { logical_name: "cover.png", cover, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } })).toMatchObject({ delivery: "applied" });
    const episode = await put(`${showId}/${episodeId}/_versions/${id(3)}/episode.toml`, `schema_version = 1\nid = "${episodeId}"\nshow_id = "${showId}"\npublish = true\ntitle = "Episode"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = 2020-01-01T12:00:00Z\n`);
    const guid = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await send(2, id(3), "metadata.batch", { episodes: [{ mode: "create", episode_id: episodeId, metadata: episode, guid }] });
    const audio = await put(`${showId}/${episodeId}/_versions/${id(4)}/audio.mp3`, "audio");
    expect(await send(3, id(4), "audio.set", { episode_id: episodeId, audio, facts: { mime: "audio/mpeg", duration_ms: 1000 } })).toMatchObject({ delivery: "applied" });
    const feed = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
    expect(feed).toContain(guid);
    expect(feed).toContain(`/${showId}/${episodeId}/audio.mp3`);
    expect(await copier.history()).toEqual(expect.arrayContaining([expect.stringContaining(`/${showId}/covers/`), expect.stringContaining(`/${showId}/${episodeId}/audio.mp3`)]));
    const futureId = "e-12345678";
    const futureGuid = "urn:uuid:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const due = Date.now() + 60 * 60 * 1000;
    const future = await put(`${showId}/${futureId}/_versions/${id(5)}/episode.toml`, `schema_version = 1\nid = "${futureId}"\nshow_id = "${showId}"\npublish = true\ntitle = "Future"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = ${new Date(due).toISOString()}\n`);
    await send(4, id(5), "metadata.batch", { episodes: [{ mode: "create", episode_id: futureId, metadata: future, guid: futureGuid }] });
    const futureAudio = await put(`${showId}/${futureId}/_versions/${id(6)}/audio.mp3`, "future audio");
    expect(await send(5, id(6), "audio.set", { episode_id: futureId, audio: futureAudio, facts: { mime: "audio/mpeg", duration_ms: 1000 } })).toMatchObject({ delivery: "scheduled" });
    const stub = env.SHOWS.getByName(showId);
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBe(due); });
    await runInDurableObject(stub, (_instance: ShowDO, state) => {
      const outcome = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", futureId).one().record_json);
      outcome.state = "failed";
      state.storage.sql.exec("UPDATE publication_outcomes SET state = 'failed', record_json = ? WHERE target = ?", JSON.stringify(outcome), futureId);
    });
    const futureRecovery = await SELF.fetch(`https://example.test/v1/shows/${showId}/recover`, { method: "POST", headers,
      body: JSON.stringify({ protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 6, episode_id: futureId }) });
    expect(await futureRecovery.json()).toMatchObject({ delivery: "scheduled" });
    await runInDurableObject(stub, async (_instance: ShowDO, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", futureId).one().state).toBe("pending");
      expect(await state.storage.getAlarm()).toBe(due);
    });
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).not.toContain(futureGuid);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance: ShowDO, state) => {
      expect(await state.storage.getAlarm()).toBe(due);
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", futureId).one().state).toBe("pending");
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(due + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toContain(futureGuid);
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
    // The future reservation sorts before the failing episode, so the first
    // batch encounters it before the unrelated audio copy fails.
    const firstLater = "e-3456789a";
    const secondLater = "e-23456789";
    const firstGuid = "urn:uuid:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const secondGuid = "urn:uuid:dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const firstAt = due + 60 * 60 * 1000;
    const secondAt = firstAt + 60 * 60 * 1000;
    const laterText = (episode: string, at: number) => `schema_version = 1\nid = "${episode}"\nshow_id = "${showId}"\npublish = true\ntitle = "Later"\ndescription = "Details"\ntimezone = "UTC"\npublished_at = ${new Date(at).toISOString()}\n`;
    const firstMetadata = await put(`${showId}/${firstLater}/_versions/${id(7)}/episode.toml`, laterText(firstLater, firstAt));
    await send(6, id(7), "metadata.batch", { episodes: [{ mode: "create", episode_id: firstLater, metadata: firstMetadata, guid: firstGuid }] });
    const firstAudio = await put(`${showId}/${firstLater}/_versions/${id(8)}/audio.mp3`, "first later");
    await send(7, id(8), "audio.set", { episode_id: firstLater, audio: firstAudio, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    const secondMetadata = await put(`${showId}/${secondLater}/_versions/${id(9)}/episode.toml`, laterText(secondLater, secondAt));
    await send(8, id(9), "metadata.batch", { episodes: [{ mode: "create", episode_id: secondLater, metadata: secondMetadata, guid: secondGuid }] });
    const secondAudio = await put(`${showId}/${secondLater}/_versions/${id("a")}/audio.mp3`, "second later");
    await send(9, id("a"), "audio.set", { episode_id: secondLater, audio: secondAudio, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBe(firstAt); });
    await copier.setFailure(`/${firstLater}/audio.mp3`);
    clock.mockReturnValue(firstAt + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance: ShowDO, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", firstLater).one().state).toBe("failed");
      expect(await state.storage.getAlarm()).toBe(secondAt);
    });
    await copier.setFailure("");
    clock.mockReturnValue(secondAt + 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const lastFeed = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
    expect(lastFeed).not.toContain(firstGuid);
    expect(lastFeed).toContain(secondGuid);
    expect((await copier.history()).filter(path => path.includes(`/${firstLater}/audio.mp3`))).toHaveLength(1);
    await runInDurableObject(stub, (_instance: ShowDO, state) => {
      const outcome = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", secondLater).one().record_json);
      outcome.state = "failed";
      state.storage.sql.exec("UPDATE publication_outcomes SET state = 'failed', record_json = ? WHERE target = ?", JSON.stringify(outcome), secondLater);
    });
    const copiedBeforeRecovery = await copier.history();
    const recoverEpisode = await SELF.fetch(`https://example.test/v1/shows/${showId}/recover`, { method: "POST", headers,
      body: JSON.stringify({ protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 10, episode_id: firstLater }) });
    expect(await recoverEpisode.json()).toMatchObject({ delivery: "applied" });
    const recoveredFeed = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
    expect(recoveredFeed).toContain(firstGuid);
    expect(recoveredFeed).toContain(secondGuid);
    expect((await copier.history()).slice(copiedBeforeRecovery.length)).toEqual([expect.stringContaining(`/${firstLater}/audio.mp3`)]);
    await runInDurableObject(stub, (_instance: ShowDO, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", firstLater).one().state).toBe("applied");
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", secondLater).one().state).toBe("failed");
      const outcome = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", secondLater).one().record_json);
      outcome.state = "applied";
      state.storage.sql.exec("UPDATE publication_outcomes SET state = 'applied', record_json = ? WHERE target = ?", JSON.stringify(outcome), secondLater);
    });
    const missing = await SELF.fetch(`https://example.test/v1/shows/${showId}/recover`, { method: "POST", headers,
      body: JSON.stringify({ protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 10, episode_id: "e-zzzzzzzz" }) });
    expect(missing.status).toBe(404);
    const cancelled = "e-456789ab";
    const cancelledAt = secondAt + 60 * 60 * 1000;
    const cancelledMetadata = await put(`${showId}/${cancelled}/_versions/${id("b")}/episode.toml`, laterText(cancelled, cancelledAt));
    await send(10, id("b"), "metadata.batch", { episodes: [{ mode: "create", episode_id: cancelled, metadata: cancelledMetadata, guid: "urn:uuid:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }] });
    const cancelledAudio = await put(`${showId}/${cancelled}/_versions/${id("c")}/audio.mp3`, "cancelled");
    await send(11, id("c"), "audio.set", { episode_id: cancelled, audio: cancelledAudio, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBe(cancelledAt); });
    await send(12, id("d"), "episode.delete", { episode_id: cancelled, confirmed: true });
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBeNull(); });
    const invalidShow = await put(`${showId}/_versions/${id("e")}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = ""\n`);
    expect(await send(13, id("e"), "metadata.batch", { show: { mode: "update", metadata: invalidShow }, episodes: [] })).toMatchObject({ delivery: "blocked" });
    await env.DELIVERY_BUCKET.put(`${showId}/${episodeId}/audio.mp3`, "public audio");
    expect(await send(14, id("f"), "episode.delete", { episode_id: episodeId, confirmed: true })).toMatchObject({ delivery: "failed" });
    expect(await env.DELIVERY_BUCKET.head(`${showId}/${episodeId}/audio.mp3`)).toBeNull();
    await runInDurableObject(stub, (_instance: ShowDO, state) => {
      expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", episodeId).one().state).toBe("failed");
    });
    const recovery = await SELF.fetch(`https://example.test/v1/shows/${showId}/recover`, { method: "POST", headers,
      body: JSON.stringify({ protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 15, episode_id: episodeId }) });
    expect(await recovery.json()).toMatchObject({ delivery: "applied" });
    const afterDeletion = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
    expect(afterDeletion).toContain("<title>Show</title>");
    expect(afterDeletion).not.toContain(guid);
    expect(afterDeletion).toContain(futureGuid);
    expect(await env.DELIVERY_BUCKET.head(`${showId}/${episodeId}/audio.mp3`)).toBeNull();
    expect(await env.MANAGEMENT_BUCKET.head(audio.key)).not.toBeNull();
    const nextDeletion = await SELF.fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 15,
      action: "episode.delete", payload: { episode_id: futureId, confirmed: true } }) });
    expect(await nextDeletion.json()).toMatchObject({ delivery: "applied" });
    const afterSecondDeletion = await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text();
    expect(afterSecondDeletion).toContain("<title>Show</title>");
    expect(afterSecondDeletion).not.toContain(guid);
    expect(afterSecondDeletion).not.toContain(futureGuid);
    expect(afterSecondDeletion).toContain(secondGuid);
    const exported = await SELF.fetch(`https://example.test/v1/shows/${showId}/export`, { headers });
    expect(exported.status).toBe(200);
    expect(await exported.json()).toMatchObject({ show_id: showId, source_revision: 16 });
    const repairId = crypto.randomUUID();
    const repaired = await put(`${showId}/_versions/${repairId}/show.toml`, `schema_version = 1\nid = "${showId}"\npublish = true\ntitle = "Show"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "UTC"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`);
    await send(16, repairId, "metadata.batch", { show: { mode: "update", metadata: repaired }, episodes: [] });
    const reservedId = "e-56789abc", reservedGuid = "urn:uuid:ffffffff-ffff-4fff-8fff-ffffffffffff", reservedAt = secondAt + 2 * 60 * 60 * 1000;
    const reserveOp = crypto.randomUUID();
    const reservedMetadata = await put(`${showId}/${reservedId}/_versions/${reserveOp}/episode.toml`, laterText(reservedId, reservedAt));
    await send(17, reserveOp, "metadata.batch", { episodes: [{ mode: "create", episode_id: reservedId, metadata: reservedMetadata, guid: reservedGuid }] });
    const reserveAudioOp = crypto.randomUUID();
    const reservedAudio = await put(`${showId}/${reservedId}/_versions/${reserveAudioOp}/audio.mp3`, "reserved audio");
    await send(18, reserveAudioOp, "audio.set", { episode_id: reservedId, audio: reservedAudio, facts: { mime: "audio/mpeg", duration_ms: 1000 } });
    const sourceSnapshot = await (await SELF.fetch(`https://example.test/v1/shows/${showId}/export`, { headers })).json();
    await send(19, crypto.randomUUID(), "show.delete", { confirmed: true });
    expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
    const restoreId = crypto.randomUUID();
    const envelope = JSON.stringify({ format_version: 1, created_at: Date.now(), installation: { management_origin: "https://example.test", management_bucket: env.R2_MANAGEMENT_BUCKET, delivery_bucket: env.R2_DELIVERY_BUCKET }, shows: [sourceSnapshot] });
    const staged = await put(`${showId}/_maintenance/${restoreId}/restore.json`, envelope);
    const restored = await SELF.fetch(`https://example.test/v1/shows/${showId}/restore`, { method: "POST", headers,
      body: JSON.stringify({ protocol_version: 1, operation_id: restoreId, expected_revision: 20, snapshot: staged, replace: true, confirmed: true }) });
    expect(await restored.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 21, delivery: "blocked" });
    expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
    const preview = await SELF.fetch(`https://example.test/v1/shows/${showId}/restore-resume`, { headers });
    expect(await preview.json()).toMatchObject({ state: "ready", revision: 21, episodes: expect.arrayContaining([
      expect.objectContaining({ id: firstLater, state: "eligible" }), expect.objectContaining({ id: reservedId, state: "scheduled", at: reservedAt })]) });
    const copiesBeforeResume = (await copier.history()).length;
    const resumeId = crypto.randomUUID();
    const resumeRequest = { protocol_version: 1, operation_id: resumeId, expected_revision: 21, confirmed: true };
    const resume = await SELF.fetch(`https://example.test/v1/shows/${showId}/restore-resume`, { method: "POST", headers, body: JSON.stringify(resumeRequest) });
    expect(await resume.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 22, delivery: "scheduled" });
    expect((await copier.history()).slice(copiesBeforeResume)).toEqual(expect.arrayContaining([expect.stringContaining(`/${firstLater}/audio.mp3`), expect.stringContaining(`/${secondLater}/audio.mp3`)]));
    expect(await (await env.DELIVERY_BUCKET.get(`${showId}/feed.xml`))!.text()).toContain(firstGuid);
    await runInDurableObject(stub, async (_instance: ShowDO, state) => { expect(await state.storage.getAlarm()).toBe(reservedAt); });
    const duplicateResume = await SELF.fetch(`https://example.test/v1/shows/${showId}/restore-resume`, { method: "POST", headers, body: JSON.stringify(resumeRequest) });
    expect(await duplicateResume.json()).toMatchObject({ acceptance: "already_accepted", accepted_revision: 22 });
  } finally { vi.restoreAllMocks(); await copier.reset(); }
});
