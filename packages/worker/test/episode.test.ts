/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ShowDO } from "../src";
import { prepareCandidate } from "../src/candidate";
import { applyCandidate } from "../src/publication";
import { acceptShowMetadata, checkShow, ValidationFailure } from "../src/show";
import { operationSchema } from "@castloop/domain";

test("episode batches preserve GUID and time, reject invalid show changes, and save incomplete episodes", async () => {
  const show = "s-23456789";
  const ep = "e-01234567";
  const path = `https://example.test/v1/shows/${show}/operations`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const guid = "urn:uuid:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const operationId = (n: number) => `${n}2345678-1234-4234-8234-123456789abc`;
  const put = async (key: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), x => x.toString(16).padStart(2, "0")).join("");
    const object = await env.MANAGEMENT_BUCKET.put(key, bytes, { customMetadata: { sha256 } });
    return { key, etag: object!.httpEtag, size: bytes.length, sha256 };
  };
  // Exercise source acceptance separately from the automatic executor so this
  // test can inject failures at specific publication stages below.
  const accept = async (operation: unknown) => runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    try { return Response.json(await acceptShowMetadata(state.storage, env.MANAGEMENT_BUCKET, "https://delivery.example.test", show, operationSchema.parse(operation))); }
    catch (error) { if (error instanceof ValidationFailure) return new Response(error.message, { status: 400 }); throw error; }
  });
  const send = async (revision: number, id: string, payload: object) => accept({ protocol_version: 1, operation_id: id, expected_revision: revision, action: "metadata.batch", payload });
  const showText = (zone: string, title = "Show") => `schema_version = 1\nid = "${show}"\npublish = true\ntitle = "${title}"\ndescription = "Description"\nwebsite = "https://example.com"\nlanguage = "en"\ntimezone = "${zone}"\nartwork = "cover.png"\ncategories = [{name="Technology"}]\nexplicit = false\n`;
  const s0 = await put(`${show}/_versions/${operationId(1)}/show.toml`, showText("Asia/Tokyo"));
  expect((await send(0, operationId(1), { show: { mode: "create", metadata: s0 }, episodes: [] })).status).toBe(200);
  const cover = await put(`${show}/_versions/${operationId(2)}/cover.png`, "fixture");
  expect((await accept({ protocol_version: 1, operation_id: operationId(2), expected_revision: 1, action: "cover.set", payload: { logical_name: "cover.png", cover, facts: { mime: "image/png", width: 1400, height: 1400, color: "rgb", alpha: false } } })).status).toBe(200);
  const episodeText = (title: string) => `schema_version = 1\nid = "${ep}"\nshow_id = "${show}"\npublish = true\ntitle = "${title}"\ndescription = "Details"\ntimezone = "Asia/Tokyo"\npublished_at = 2026-11-01T12:00:00+09:00\n`;
  const e0 = await put(`${show}/${ep}/_versions/${operationId(3)}/episode.toml`, episodeText("First"));
  const create = await send(2, operationId(3), { episodes: [{ mode: "create", episode_id: ep, metadata: e0, guid }] });
  expect(create.status).toBe(200);
  expect(await create.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 3, validation_issues: expect.arrayContaining([expect.objectContaining({ path: `episodes.${ep}.audio` })]) });
  const readEpisode = () => runInDurableObject(env.SHOWS.getByName(show), (_instance: ShowDO, state) => JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM episodes WHERE episode_id = ?", ep).one().record_json));
  const initial = await readEpisode();
  expect(initial.guid).toBe(guid);
  expect(initial.time.instant_ms).toBe(Date.parse("2026-11-01T03:00:00Z"));
  const audio = await put(`${show}/${ep}/_versions/${operationId(9)}/audio.mp3`, "local audio fixture");
  const audioOp = { protocol_version: 1, operation_id: operationId(9), expected_revision: 3, action: "audio.set", payload: { episode_id: ep, audio, facts: { mime: "audio/mpeg", duration_ms: 1000 } } };
  const audioResponse = await accept(audioOp);
  expect(audioResponse.status).toBe(200);
  expect(await audioResponse.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 4, validation_issues: [] });
  expect((await readEpisode()).audio.ref.key).toBe(audio.key);
  const collision = { protocol_version: 1, operation_id: "b2345678-1234-4234-8234-123456789abc", expected_revision: 4, action: "metadata.batch", payload: { episodes: [{ mode: "create", episode_id: ep, metadata: e0, guid }] } };
  const collisionResponse = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(collision) });
  expect(collisionResponse.status).toBe(409);
  expect(await collisionResponse.json()).toMatchObject({ acceptance: "rejected", issues: [{ code: "identity_conflict", path: `episodes.${ep}.id` }] });
  const staleResponse = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify({ ...collision, expected_revision: 3 }) });
  expect(staleResponse.status).toBe(409);
  expect(await staleResponse.json()).toMatchObject({ acceptance: "rejected", issues: [{ code: "revision_conflict", path: "" }] });
  expect((await readEpisode()).guid).toBe(guid);
  const batchId = "a2345678-1234-4234-8234-123456789abc";
  const changedShow = await put(`${show}/_versions/${batchId}/show.toml`, showText("Asia/Tokyo", "Not committed"));
  const malformedEpisode = await put(`${show}/${ep}/_versions/${batchId}/episode.toml`, `schema_version = 1\nid = "${ep}"\nshow_id = "${show}"\ntitle = 123\n`);
  const batch = { protocol_version: 1, operation_id: batchId, expected_revision: 4, action: "metadata.batch", payload: {
    show: { mode: "update", metadata: changedShow }, episodes: [{ mode: "update", episode_id: ep, metadata: malformedEpisode }],
  } };
  const rejectedBatch = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(batch) });
  expect(rejectedBatch.status).toBe(400);
  expect(await rejectedBatch.json()).toMatchObject({ acceptance: "rejected", operation_id: batchId, issues: [expect.objectContaining({ code: "malformed_input" })] });
  await runInDurableObject(env.SHOWS.getByName(show), (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json);
    expect(control).toMatchObject({ revision: 4, metadata: s0 });
    expect(state.storage.sql.exec("SELECT object_key FROM source_assets WHERE object_key IN (?, ?)", changedShow.key, malformedEpisode.key).toArray()).toHaveLength(0);
  });
  expect((await readEpisode()).metadata).toEqual(e0);
  await env.MANAGEMENT_BUCKET.put(audio.key, "local audio fixture", { customMetadata: { sha256: "b".repeat(64) } });
  await env.MANAGEMENT_BUCKET.put(cover.key, "fixture", { customMetadata: { sha256: "b".repeat(64) } });
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    const checked = await checkShow(state.storage, env.MANAGEMENT_BUCKET, show);
    expect(checked.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "dependency_unavailable", path: "show.artwork" }),
      expect.objectContaining({ code: "dependency_unavailable", path: `episodes.${ep}.audio` }),
    ]));
  });
  await env.MANAGEMENT_BUCKET.put(audio.key, "local audio fixture", { customMetadata: { sha256: audio.sha256 } });
  await env.MANAGEMENT_BUCKET.put(cover.key, "fixture", { customMetadata: { sha256: cover.sha256 } });
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    const at = initial.time.instant_ms as number;
    const scheduled = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, at - 1);
    expect(scheduled.state).toBe("ready");
    if (scheduled.state !== "ready") throw new Error("Expected ready candidate");
    expect(scheduled.nextAlarm).toBe(at);
    expect(scheduled.feed).not.toContain(guid);
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(4);
    scheduled.release();
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
    const due = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, at);
    expect(due.state).toBe("ready");
    if (due.state !== "ready") throw new Error("Expected ready candidate");
    expect(due.feed).toContain(guid);
    expect(due.feed).toContain(`/${show}/${ep}/audio.mp3`);
    expect(due.episodes).toEqual([expect.objectContaining({ id: ep, state: "eligible", at })]);
    expect(due.nextAlarm).toBeNull();
    due.release();
    state.storage.sql.exec("UPDATE source_assets SET state = 'delete_claimed', claim_operation_id = ? WHERE object_key = ?", "cleanup", audio.key);
    await expect(prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, at)).rejects.toThrow("unavailable or retired");
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
    state.storage.sql.exec("UPDATE source_assets SET state = 'present', claim_operation_id = NULL WHERE object_key = ?", audio.key);
    const firstAttempt = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, at);
    if (firstAttempt.state !== "ready") throw new Error("Expected ready candidate");
    const events: string[] = [];
    const copy = async (source: { key: string }, destination: string, mime: string) => {
      events.push(`copy ${mime}`);
      if (mime === "audio/mpeg") throw new Error("injected copy failure");
      const sourceObject = await env.MANAGEMENT_BUCKET.get(source.key);
      await env.DELIVERY_BUCKET.put(destination, await sourceObject!.arrayBuffer());
    };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, show, firstAttempt, copy, async paths => { events.push(`purge ${paths.join(",")}`); })).toBe("failed");
    firstAttempt.release();
    expect(await env.DELIVERY_BUCKET.head(`${show}/feed.xml`)).toBeNull();
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", ep).one().state).toBe("failed");
    const recovery = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, at, true);
    if (recovery.state !== "ready") throw new Error("Expected ready recovery candidate");
    events.length = 0;
    const successfulCopy = async (source: { key: string }, destination: string, mime: string) => {
      events.push(`copy ${mime}`);
      const sourceObject = await env.MANAGEMENT_BUCKET.get(source.key);
      await env.DELIVERY_BUCKET.put(destination, await sourceObject!.arrayBuffer());
    };
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, show, recovery, successfulCopy, async paths => { events.push(`purge ${paths.join(",")}`); }, "recover")).toBe("applied");
    recovery.release();
    expect(events[0]).toBe("copy image/png");
    expect(events[1]).toBe("copy audio/mpeg");
    expect(events[2]).toContain(`/${show}/${ep}/audio.mp3`);
    expect(events[3]).toBe(`purge /${show}/feed.xml`);
    expect(await (await env.DELIVERY_BUCKET.get(`${show}/feed.xml`))!.text()).toContain(guid);
    expect(await env.DELIVERY_BUCKET.head(`${show}/${ep}/audio.mp3`)).not.toBeNull();
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
  });
  const checked = await SELF.fetch(`https://example.test/v1/shows/${show}/check`, { headers });
  expect(checked.status).toBe(200);
  expect(await checked.json()).toMatchObject({ revision: 4, issues: [], outcomes: expect.arrayContaining([expect.objectContaining({ target: ep, state: "applied" })]) });
  const e1 = await put(`${show}/${ep}/_versions/${operationId(4)}/episode.toml`, episodeText("Renamed"));
  expect((await send(4, operationId(4), { episodes: [{ mode: "update", episode_id: ep, metadata: e1 }] })).status).toBe(200);
  expect((await readEpisode()).time).toEqual(initial.time);
  expect((await readEpisode()).guid).toBe(guid);
  expect((await readEpisode()).audio.ref.key).toBe(audio.key);
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    const renamed = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, initial.time.instant_ms);
    if (renamed.state !== "ready") throw new Error("Expected ready candidate");
    let copies = 0;
    expect(await applyCandidate(state.storage, env.DELIVERY_BUCKET, show, renamed, async () => { copies++; }, async () => {})).toBe("applied");
    renamed.release();
    expect(copies).toBe(0);
    const feed = await (await env.DELIVERY_BUCKET.get(`${show}/feed.xml`))!.text();
    expect(feed).toContain("Renamed");
    expect(feed).toContain(guid);
  });
  const badShow = await put(`${show}/_versions/${operationId(5)}/show.toml`, showText("Asia/Tokyo", ""));
  const e2 = await put(`${show}/${ep}/_versions/${operationId(5)}/episode.toml`, episodeText("Never accepted"));
  const combined = await send(5, operationId(5), { show: { mode: "update", metadata: badShow }, episodes: [{ mode: "update", episode_id: ep, metadata: e2 }] });
  expect(combined.status).toBe(400);
  expect((await readEpisode()).metadata.key).toBe(e1.key);
  await runInDurableObject(env.SHOWS.getByName(show), (_instance: ShowDO, state) => {
    const row = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM publication_outcomes WHERE target = ?", ep).one();
    const record = JSON.parse(row.record_json);
    record.state = "failed";
    state.storage.sql.exec("UPDATE publication_outcomes SET state = 'failed', record_json = ? WHERE target = ?", JSON.stringify(record), ep);
  });
  const changedZone = await put(`${show}/_versions/${operationId(6)}/show.toml`, showText("America/New_York"));
  expect((await send(5, operationId(6), { show: { mode: "update", metadata: changedZone }, episodes: [] })).status).toBe(200);
  expect((await readEpisode()).time).toEqual(initial.time);
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = ?", ep).one().state).toBe("failed");
    const candidate = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, initial.time.instant_ms);
    expect(candidate.state).toBe("ready");
    if (candidate.state !== "ready") throw new Error("Expected ready candidate");
    expect(candidate.episodes).toEqual([expect.objectContaining({ id: ep, state: "failed" })]);
    expect(candidate.feed).not.toContain(guid);
    candidate.release();
  });
  const invalid = await put(`${show}/_versions/${operationId(7)}/show.toml`, showText("America/New_York", ""));
  expect((await send(6, operationId(7), { show: { mode: "update", metadata: invalid }, episodes: [] })).status).toBe(200);
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    const candidate = await prepareCandidate(state.storage, env.MANAGEMENT_BUCKET, show, initial.time.instant_ms);
    expect(candidate).toMatchObject({ state: "hold", issues: expect.arrayContaining([expect.objectContaining({ path: "title" })]) });
    candidate.release();
  });
  const refused = await put(`${show}/${ep}/_versions/${operationId(8)}/episode.toml`, episodeText("Refused"));
  expect((await send(7, operationId(8), { episodes: [{ mode: "update", episode_id: ep, metadata: refused }] })).status).toBe(400);
  expect((await readEpisode()).metadata.key).toBe(e1.key);
  // Withdrawal requests remain eligible even when current show metadata is invalid or unavailable.
  await env.MANAGEMENT_BUCKET.delete(invalid.key);
  const deleteEpisode = { protocol_version: 1, operation_id: "a2345678-1234-4234-8234-123456789abc", expected_revision: 7, action: "episode.delete", payload: { episode_id: ep, confirmed: true } };
  expect((await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(deleteEpisode) })).status).toBe(200);
  expect((await readEpisode()).deleted).toBe(true);
  await env.DELIVERY_BUCKET.put(`${show}/feed.xml`, "old feed");
  await env.DELIVERY_BUCKET.put(`${show}/${ep}/audio.mp3`, "old audio");
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => { await state.storage.setAlarm(2_000_000_000_000); });
  const deleteShow = { protocol_version: 1, operation_id: "b2345678-1234-4234-8234-123456789abc", expected_revision: 8, action: "show.delete", payload: { confirmed: true } };
  const deleted = await SELF.fetch(path, { method: "POST", headers, body: JSON.stringify(deleteShow) });
  expect(await deleted.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 9, delivery: "applied" });
  expect(await env.DELIVERY_BUCKET.head(`${show}/feed.xml`)).toBeNull();
  expect(await env.DELIVERY_BUCKET.head(`${show}/${ep}/audio.mp3`)).toBeNull();
  await runInDurableObject(env.SHOWS.getByName(show), async (_instance: ShowDO, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM publication_outcomes WHERE target = 'show-withdrawal'").one().state).toBe("applied");
    expect(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json).toContain('"deleted":true');
  });
  const afterDelete = await SELF.fetch(`https://example.test/v1/shows/${show}/check`, { headers });
  expect(await afterDelete.json()).toMatchObject({ revision: 9, outcomes: expect.arrayContaining([expect.objectContaining({ target: "show-withdrawal", state: "applied" })]) });
  expect(await env.MANAGEMENT_BUCKET.head(e1.key)).not.toBeNull();
});
