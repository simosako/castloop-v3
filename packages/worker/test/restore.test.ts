/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ShowDO } from "../src";
import type { ShowControl } from "../src/storage";
import { exportShow } from "../src/export";
import { acceptRestore } from "../src/restore";
import { claimCleanup } from "../src/cleanup";

test("restore validates sources and safety guards, then installs a held snapshot idempotently", async () => {
  const showId = "s-3abcdefg", sourceId = "12345678-1234-4234-8234-123456789abc", restoreId = "22345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${sourceId}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "source");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  const coverKey = `${showId}/_versions/${sourceId}/cover.png`, coverSha = "b".repeat(64);
  const coverObject = await env.MANAGEMENT_BUCKET.put(coverKey, "cover", { customMetadata: { sha256: coverSha } });
  const coverRef = { key: coverKey, etag: coverObject!.httpEtag, size: coverObject!.size, sha256: coverSha };
  const coverFacts = { mime: "image/png" as const, width: 1400, height: 1400, color: "rgb" as const, alpha: false as const };
  const stub = env.SHOWS.getByName(showId);
  const snapshot = await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: { logical_name: "cover.png", ref: coverRef, facts: coverFacts }, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://delivery.example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: sourceId, ref, stored_at: 1, registered_at: 1, facts: null, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", coverKey, JSON.stringify({ ...asset, kind: "cover", ref: coverRef, facts: coverFacts }));
    return exportShow(state.storage, env.MANAGEMENT_BUCKET, showId);
  });
  await env.MANAGEMENT_BUCKET.put(coverKey, "cover", { customMetadata: { sha256: "c".repeat(64) } });
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    await expect(exportShow(state.storage, env.MANAGEMENT_BUCKET, showId)).rejects.toThrow("Required source is unavailable or changed");
    expect(state.storage.sql.exec("SELECT * FROM source_pins").toArray()).toHaveLength(0);
  });
  await env.MANAGEMENT_BUCKET.put(coverKey, "cover", { customMetadata: { sha256: coverSha } });
  const envelope = { format_version: 1, created_at: 1, installation: { management_origin: "https://management.example.test", management_bucket: env.R2_MANAGEMENT_BUCKET, delivery_bucket: env.R2_DELIVERY_BUCKET }, shows: [snapshot] };
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
  const stagedKey = `${showId}/_maintenance/${restoreId}/restore.json`;
  const staged = await env.MANAGEMENT_BUCKET.put(stagedKey, bytes);
  const input = { protocol_version: 1, operation_id: restoreId, expected_revision: 1, snapshot: { key: stagedKey, etag: staged!.httpEtag, size: bytes.length, sha256 }, replace: true, confirmed: true };
  const url = `https://example.test/v1/shows/${showId}/restore`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const send = (payload: object) => SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
  expect((await send(input)).status).toBe(409);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    control.deleted = true; control.revision = 2;
    state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ?", JSON.stringify(control));
    state.storage.sql.exec("INSERT INTO publication_outcomes VALUES ('show-withdrawal', 'applied', '{}')");
    state.storage.sql.exec("INSERT INTO source_pins VALUES (?, 'another-reader')", key);
  });
  expect((await send({ ...input, expected_revision: 2, replace: false })).status).toBe(409);
  expect((await send({ ...input, expected_revision: 2 })).status).toBe(409);
  await runInDurableObject(stub, (_instance: ShowDO, state) => { state.storage.sql.exec("DELETE FROM source_pins"); });
  await env.MANAGEMENT_BUCKET.delete(key);
  expect((await send({ ...input, expected_revision: 2 })).status).toBe(409);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control).toMatchObject({ revision: 2, deleted: true });
  });
  const replaced = await env.MANAGEMENT_BUCKET.put(key, "source");
  expect(replaced!.httpEtag).toBe(ref.etag);
  await env.MANAGEMENT_BUCKET.put(coverKey, "cover", { customMetadata: { sha256: "c".repeat(64) } });
  expect((await send({ ...input, expected_revision: 2 })).status).toBe(409);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control).toMatchObject({ revision: 2, deleted: true });
  });
  await env.MANAGEMENT_BUCKET.put(coverKey, "cover", { customMetadata: { sha256: coverSha } });
  const accepted = await send({ ...input, expected_revision: 2 });
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 3, delivery: "blocked" });
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control).toMatchObject({ revision: 3, deleted: false, restore_hold: true, metadata: ref });
    expect(await state.storage.getAlarm()).toBeNull();
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", stagedKey).one().state).toBe("present");
  });
  await env.MANAGEMENT_BUCKET.delete(stagedKey);
  expect(await (await send({ ...input, expected_revision: 2 })).json()).toMatchObject({ acceptance: "already_accepted", accepted_revision: 3 });
  expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
});

test("resuming a restored deleted show keeps it withdrawn and does not schedule", async () => {
  const showId = "s-2abcdefg";
  const ref = { key: `${showId}/old.toml`, etag: '"etag"', size: 3, sha256: "a".repeat(64) };
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: true, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://delivery.example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: true };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
  });
  await env.DELIVERY_BUCKET.put(`${showId}/feed.xml`, "stale");
  const url = `https://example.test/v1/shows/${showId}/restore-resume`, headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  expect(await (await SELF.fetch(url, { headers })).json()).toMatchObject({ state: "withdraw", revision: 1, episodes: [] });
  const request = { protocol_version: 1, operation_id: crypto.randomUUID(), expected_revision: 1, confirmed: true };
  expect(await (await SELF.fetch(url, { method: "POST", headers, body: JSON.stringify(request) })).json()).toMatchObject({ accepted_revision: 2, delivery: "applied" });
  expect(await env.DELIVERY_BUCKET.head(`${showId}/feed.xml`)).toBeNull();
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const control = JSON.parse(state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM show_control").one().record_json) as ShowControl;
    expect(control).toMatchObject({ deleted: true, restore_hold: false, scheduling: { enabled: false } });
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

test("restore rejects a source claimed for cleanup during validation", async () => {
  const showId = "s-1abcdefg", sourceId = "12345678-1234-4234-8234-123456789abc", restoreId = "22345678-1234-4234-8234-123456789abc", cleanupId = "32345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${sourceId}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "source");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://delivery.example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: sourceId, ref, stored_at: 1, registered_at: 1, facts: null, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
    const snapshot = await exportShow(state.storage, env.MANAGEMENT_BUCKET, showId);
    // Model restoration into an absent Show with an existing inventoried source.
    state.storage.sql.exec("DELETE FROM show_control");
    const envelope = { format_version: 1, created_at: 1, installation: { management_origin: "https://management.example.test", management_bucket: env.R2_MANAGEMENT_BUCKET, delivery_bucket: env.R2_DELIVERY_BUCKET }, shows: [snapshot] };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");
    const stagedKey = `${showId}/_maintenance/${restoreId}/restore.json`;
    const staged = await env.MANAGEMENT_BUCKET.put(stagedKey, bytes);
    const operation = { protocol_version: 1 as const, operation_id: restoreId, expected_revision: 0, action: "restore" as const,
      payload: { snapshot: { key: stagedKey, etag: staged!.httpEtag, size: bytes.length, sha256 }, replace: false, confirmed: true as const } };
    const wrapper = { get: env.MANAGEMENT_BUCKET.get.bind(env.MANAGEMENT_BUCKET), head: async (name: string) => {
      const result = await env.MANAGEMENT_BUCKET.head(name);
      expect(claimCleanup(state.storage, showId, cleanupId, [ref], 1, 2 * 86400000).claimed).toEqual([ref]);
      return result;
    } } as R2Bucket;
    await expect(acceptRestore(state.storage, wrapper, showId, operation, env.R2_MANAGEMENT_BUCKET, env.R2_DELIVERY_BUCKET)).rejects.toThrow("Restore cannot run while sources are pinned or claimed");
    expect(state.storage.sql.exec("SELECT * FROM show_control").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec<{ state: string }>("SELECT state FROM source_assets WHERE object_key = ?", key).one().state).toBe("delete_claimed");
    expect(await env.MANAGEMENT_BUCKET.head(key)).not.toBeNull();
  });
});
