/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ShowDO } from "../src";
import type { ShowControl } from "../src/storage";
import { exportShow } from "../src/export";
import { claimCleanup } from "../src/cleanup";

test("export captures required identities, protects sources during validation and fails on missing objects", async () => {
  const showId = "s-4abcdefg", op = "12345678-1234-4234-8234-123456789abc", key = `${showId}/_versions/${op}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "show metadata");
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: op, ref, stored_at: 0, registered_at: 1, facts: null, state: "present", claim_operation_id: null };
    state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", key, JSON.stringify(asset));
    const wrapper = { head: async (name: string) => {
      expect(state.storage.sql.exec("SELECT object_key FROM source_pins WHERE object_key = ?", key).toArray()).toHaveLength(1);
      expect(claimCleanup(state.storage, showId, op, [ref], 1, 2 * 86400000).skipped[0]?.reason).toBe("protected");
      return env.MANAGEMENT_BUCKET.head(name);
    } } as R2Bucket;
    const snapshot = await exportShow(state.storage, wrapper, showId);
    expect(snapshot).toMatchObject({ snapshot_version: 1, show_id: showId, source_revision: 1, required_objects: [ref], historical_missing_or_deleted: [] });
    expect(snapshot.source_assets).toHaveLength(1);
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
  });
  const url = `https://example.test/v1/shows/${showId}/export`;
  const headers = { authorization: "Bearer local-test-token" };
  expect((await SELF.fetch(url)).status).toBe(401);
  const response = await SELF.fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ show_id: showId, required_objects: [ref] });
  await env.MANAGEMENT_BUCKET.delete(key);
  expect((await SELF.fetch(url, { headers })).status).toBe(503);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
  });
});

test("an export pins an old version after the selected source changes", async () => {
  const showId = "s-5abcdefg", oldOp = "12345678-1234-4234-8234-123456789abc", newOp = "22345678-1234-4234-8234-123456789abc", cleanupId = "32345678-1234-4234-8234-123456789abc";
  const refs = await Promise.all([oldOp, newOp].map(async operation => {
    const key = `${showId}/_versions/${operation}/show.toml`;
    const object = await env.MANAGEMENT_BUCKET.put(key, `metadata-${operation}`);
    return { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  }));
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: refs[0]!, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
    for (const [index, operation] of [oldOp, newOp].entries()) {
      const asset = { record_version: 1, episode_id: null, kind: "show_toml", operation_id: operation, ref: refs[index], stored_at: 0, registered_at: 1, facts: null, state: "present", claim_operation_id: null };
      state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'present', NULL, ?)", refs[index]!.key, JSON.stringify(asset));
    }
    const wrapper = { head: async (key: string) => {
      // Simulate a newer accepted revision after export captured its snapshot.
      control.revision = 2; control.metadata = refs[1]!;
      state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ?", JSON.stringify(control));
      expect(claimCleanup(state.storage, showId, cleanupId, [refs[0]!], 1, 2 * 86400000).skipped[0]?.reason).toBe("protected");
      return env.MANAGEMENT_BUCKET.head(key);
    } } as R2Bucket;
    const snapshot = await exportShow(state.storage, wrapper, showId);
    expect(snapshot).toMatchObject({ source_revision: 1, required_objects: [refs[0]] });
    expect(state.storage.sql.exec("SELECT object_key FROM source_pins").toArray()).toHaveLength(0);
    expect(claimCleanup(state.storage, showId, cleanupId, [refs[0]!], 1, 2 * 86400000).claimed).toEqual([refs[0]]);
  });
});
