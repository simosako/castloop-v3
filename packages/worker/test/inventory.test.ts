/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import type { ShowDO } from "../src";
import { registerInventory } from "../src/inventory";

test("inventory verifies ownership and identity, never revives retired keys, and pages ledger", async () => {
  const showId = "s-5abcdefg", op = "12345678-1234-4234-8234-123456789abc", key = `${showId}/_versions/${op}/show.toml`;
  const object = await env.MANAGEMENT_BUCKET.put(key, "private source", { customMetadata: { sha256: "a".repeat(64) } });
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256: "a".repeat(64) };
  const alienKey = `s-6abcdefg/_versions/${op}/show.toml`;
  const alien = await env.MANAGEMENT_BUCKET.put(alienKey, "alien");
  const alienRef = { key: alienKey, etag: alien!.httpEtag, size: alien!.size, sha256: null };
  const endpoint = `https://example.test/v1/shows/${showId}/inventory`;
  const headers = { authorization: "Bearer local-test-token", "content-type": "application/json" };
  const send = (objects: unknown[]) => SELF.fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ protocol_version: 1, objects }) });
  expect((await SELF.fetch(endpoint)).status).toBe(401);
  expect(await (await send([{ ...ref, sha256: "b".repeat(64) }])).json()).toMatchObject({ registered: [], skipped: [{ key, issues: ["Object digest metadata differs from the inventory request"] }] });
  expect(await (await send([{ ...ref, sha256: null }])).json()).toMatchObject({ registered: [], skipped: [{ key, issues: ["Object digest metadata differs from the inventory request"] }] });
  expect(await (await send([ref, alienRef])).json()).toMatchObject({ show_id: showId, registered: [ref], skipped: [{ key: alienKey }] });
  expect(await (await send([ref])).json()).toMatchObject({ registered: [ref], skipped: [] });
  const stub = env.SHOWS.getByName(showId);
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec("SELECT show_id FROM show_control").toArray()).toHaveLength(0);
    const row = state.storage.sql.exec<{ record_json: string }>("SELECT record_json FROM source_assets WHERE object_key = ?", key).one();
    const asset = JSON.parse(row.record_json);
    asset.state = "deleted"; asset.claim_operation_id = op;
    state.storage.sql.exec("UPDATE source_assets SET state = 'deleted', claim_operation_id = ?, record_json = ? WHERE object_key = ?", op, JSON.stringify(asset), key);
    for (let i = 0; i < 100; i++) {
      const extra = { ...asset, ref: { ...ref, key: `${showId}/extra-${String(i).padStart(3, "0")}` } };
      state.storage.sql.exec("INSERT INTO source_assets VALUES (?, 'deleted', ?, ?)", extra.ref.key, op, JSON.stringify(extra));
    }
  });
  expect(await (await send([ref])).json()).toMatchObject({ registered: [], skipped: [{ key }] });
  const first = await (await SELF.fetch(endpoint, { headers })).json() as { records: unknown[]; next_cursor: string };
  expect(first.records).toHaveLength(100);
  expect(first.next_cursor).toBeTruthy();
  const second = await (await SELF.fetch(`${endpoint}?cursor=${first.next_cursor}`, { headers })).json() as { records: unknown[]; next_cursor: null };
  expect(second.records).toHaveLength(1);
  expect(second.next_cursor).toBeNull();
  expect((await SELF.fetch(`${endpoint}?cursor=bad!`, { headers })).status).toBe(400);
});

test("an inventoried source remains selectable when its reference fields were recorded in a different order", async () => {
  const showId = "s-7abcdefg", op = "12345678-1234-4234-8234-123456789abc";
  const key = `${showId}/_versions/${op}/show.toml`, body = `schema_version = 1\nid = "${showId}"\npublish = false\n`;
  const bytes = new TextEncoder().encode(body);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  const object = await env.MANAGEMENT_BUCKET.put(key, bytes, { customMetadata: { sha256 } });
  const reversed = { sha256, size: bytes.length, etag: object!.httpEtag, key };
  await runInDurableObject(env.SHOWS.getByName(showId), async (_instance: ShowDO, state) => {
    expect((await registerInventory(state.storage, env.MANAGEMENT_BUCKET, showId, [reversed])).registered).toHaveLength(1);
  });
  const response = await SELF.fetch(`https://example.test/v1/shows/${showId}/operations`, { method: "POST", headers: { authorization: "Bearer local-test-token", "content-type": "application/json" }, body: JSON.stringify({ protocol_version: 1, operation_id: op, expected_revision: 0, action: "metadata.batch", payload: { show: { mode: "create", metadata: { key, etag: object!.httpEtag, size: bytes.length, sha256 } }, episodes: [] } }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ acceptance: "accepted", accepted_revision: 1 });
});
