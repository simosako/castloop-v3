/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ShowDO } from "../src";
import type { ShowControl } from "../src/storage";
import { claimCleanup, completeCleanup } from "../src/cleanup";
import { registerInventory } from "../src/inventory";

test("cleanup retires only old unreferenced sources and completes only after confirmed absence", async () => {
  const showId = "s-9abcdefg", episodeId = "e-01234567";
  const op = (n: number) => `${n}2345678-1234-4234-8234-123456789abc`;
  const cleanupId = op(9), now = 20 * 86400000;
  const refs = await Promise.all(Array.from({ length: 6 }, async (_, i) => {
    const key = `${showId}/_versions/${op(i + 1)}/show.toml`;
    const object = await env.MANAGEMENT_BUCKET.put(key, `object-${i}`);
    return { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  }));
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: refs[0]!, cover: null, deleted: false, accepted_at: 1,
      last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    for (let i = 0; i < refs.length; i++) {
      const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: op(i + 1), ref: refs[i], stored_at: i === 4 ? now - 86400000 : 0,
        registered_at: 0, facts: null, state: "present", claim_operation_id: null };
      state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", refs[i]!.key, JSON.stringify(asset));
    }
    state.storage.sql.exec("INSERT INTO delivery_refs VALUES ('feed', ?)", JSON.stringify({ sources: [refs[1]] }));
    state.storage.sql.exec("INSERT INTO source_pins VALUES (?, 'active')", refs[2]!.key);
    const episode = { record_version: 1, episode_id: episodeId, guid: "guid", metadata: refs[3], audio: null, deleted: false, publish: false, time: null };
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episodeId, "guid", JSON.stringify(episode));
    const result = claimCleanup(state.storage, showId, cleanupId, refs, 2, now);
    expect(result.claimed).toEqual([refs[5]]);
    expect(result.skipped.map(item => item.reason)).toEqual(["protected", "protected", "protected", "protected", "too_recent"]);
    expect(claimCleanup(state.storage, showId, cleanupId, [refs[5]!], 2, now).claimed).toEqual([refs[5]]);
    expect(claimCleanup(state.storage, showId, op(8), [refs[5]!], 2, now).skipped[0]?.reason).toBe("already_retired_or_missing");
    expect((await completeCleanup(state.storage, env.MANAGEMENT_BUCKET, showId, cleanupId, [refs[5]!])).unresolved).toEqual([refs[5]!.key]);
    await env.MANAGEMENT_BUCKET.delete(refs[5]!.key);
    expect((await completeCleanup(state.storage, env.MANAGEMENT_BUCKET, showId, cleanupId, [refs[5]!])).completed).toEqual([refs[5]!.key]);
    expect((await completeCleanup(state.storage, env.MANAGEMENT_BUCKET, showId, cleanupId, [refs[5]!])).completed).toEqual([refs[5]!.key]);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", refs[5]!.key).one().state).toBe("deleted");
    expect(claimCleanup(state.storage, showId, op(8), [refs[5]!], 2, now).claimed).toHaveLength(0);
  });
});

test("cleanup fails closed for incomplete Show withdrawal and malformed delivery references", async () => {
  const showId = "s-8abcdefg", operationId = "12345678-1234-4234-8234-123456789abc", key = `${showId}/_versions/${operationId}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "old");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: true, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: operationId, ref, stored_at: 0, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
    expect(claimCleanup(state.storage, showId, operationId, [ref], 1, 2 * 86400000).skipped[0]?.reason).toBe("protected");
    state.storage.sql.exec("INSERT INTO delivery_refs VALUES ('feed', '{}')");
    expect(() => claimCleanup(state.storage, showId, operationId, [ref], 1, 2 * 86400000)).toThrow("Delivery sources are inconsistent");
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", key).one().state).toBe("present");
  });
});

test("deleted Episode sources stay protected until its withdrawal succeeds", async () => {
  const showId = "s-7abcdefg", episodeId = "e-01234567", operationId = "12345678-1234-4234-8234-123456789abc";
  const key = `${showId}/${episodeId}/_versions/${operationId}/audio.mp3`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "audio");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  await runInDurableObject(env.SHOWS.getByName(showId), (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    const episode = { record_version: 1, episode_id: episodeId, guid: "guid", metadata: ref, audio: { ref }, deleted: true, publish: false, time: null };
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, 'guid', ?)", episodeId, JSON.stringify(episode));
    const asset = { record_version: 1, episode_id: episodeId, kind: "audio", operation_id: operationId, ref, stored_at: 0, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
    // The Show reference also protects this fixture; use a distinct Show source to isolate the Episode rule.
    control.metadata = { ...ref, key: `${showId}/_versions/${operationId}/show.toml` };
    state.storage.sql.exec("UPDATE show_control SET record_json = ?", JSON.stringify(control));
    expect(claimCleanup(state.storage, showId, operationId, [ref], 1, 2 * 86400000).skipped[0]?.reason).toBe("protected");
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES (?, 'applied', '{}')", episodeId);
    expect(claimCleanup(state.storage, showId, operationId, [ref], 1, 2 * 86400000).claimed).toEqual([ref]);
  });
});

test("authenticated cleanup API preserves exact claims until absence is observed", async () => {
  const showId = "s-6abcdefg", sourceOp = "12345678-1234-4234-8234-123456789abc", cleanupId = "22345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${sourceOp}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "old");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: sourceOp, ref, stored_at: 0, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
  });
  const base = `https://example.test/v1/shows/${showId}/cleanup`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const claim = { protocol_version: 1, operation_id: cleanupId, older_than_days: 1, candidates: [ref] };
  expect((await SELF.fetch(`${base}/claim`, { method: "POST", body: JSON.stringify(claim) })).status).toBe(401);
  expect((await SELF.fetch(`${base}/claim`, { method: "POST", headers, body: JSON.stringify({ ...claim, candidates: [ref, ref] }) })).status).toBe(400);
  const claimed = await SELF.fetch(`${base}/claim`, { method: "POST", headers, body: JSON.stringify(claim) });
  expect(claimed.headers.get("cache-control")).toBe("no-store");
  expect(await claimed.json()).toMatchObject({ show_id: showId, operation_id: cleanupId, claimed: [ref], skipped: [] });
  const finish = async (operationId: string) => (await SELF.fetch(`${base}/complete`, { method: "POST", headers,
    body: JSON.stringify({ protocol_version: 1, operation_id: operationId, keys: [key] }) })).json();
  expect(await finish(sourceOp)).toMatchObject({ deleted: [], unresolved: [{ key }] });
  expect(await finish(cleanupId)).toMatchObject({ deleted: [], unresolved: [{ key }] });
  await env.MANAGEMENT_BUCKET.delete(key);
  expect(await finish(cleanupId)).toMatchObject({ deleted: [key], unresolved: [] });
  expect(await finish(cleanupId)).toMatchObject({ deleted: [key], unresolved: [] });
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", key).one().state).toBe("deleted");
  });
});

test("abandoned uploads can be inventoried and cleaned without creating a Show", async () => {
  const showId = "s-hjkmnpqr", sourceOp = "12345678-1234-4234-8234-123456789abc", cleanupId = "22345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${sourceOp}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "abandoned draft");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: null };
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    expect(await registerInventory(state.storage, env.MANAGEMENT_BUCKET, showId, [ref])).toMatchObject({ registered: [ref], skipped: [] });
    expect(state.storage.sql.exec("SELECT * FROM show_control").toArray()).toHaveLength(0);
    const uploaded = object!.uploaded.getTime();
    expect(claimCleanup(state.storage, showId, cleanupId, [ref], 1, uploaded + 60_000).skipped[0]?.reason).toBe("too_recent");
    expect(claimCleanup(state.storage, showId, cleanupId, [ref], 1, uploaded + 2 * 86400000).claimed).toEqual([ref]);
    expect((await completeCleanup(state.storage, env.MANAGEMENT_BUCKET, showId, cleanupId, [ref])).unresolved).toEqual([key]);
    await env.MANAGEMENT_BUCKET.delete(key);
    expect((await completeCleanup(state.storage, env.MANAGEMENT_BUCKET, showId, cleanupId, [ref])).completed).toEqual([key]);
    expect(state.storage.sql.exec("SELECT * FROM show_control").toArray()).toHaveLength(0);
  });
});
