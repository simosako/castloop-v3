/// <reference types="@cloudflare/vitest-plugin/types" />
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { episodeSchema, parseToml, resolvePublicationTime } from "@castloop/domain";
import type { ShowDO } from "../src";
import { commitAcceptance, readSnapshot, type ShowControl } from "../src/storage";
import type { Operation } from "@castloop/domain";

test("SQL and alarm roll back together after an interrupted transaction", async () => {
  const stub = env.SHOWS.get(env.SHOWS.newUniqueId());
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    state.storage.sql.exec("CREATE TABLE probe (value INTEGER NOT NULL)");
    state.storage.sql.exec("INSERT INTO probe VALUES (1)");
    await state.storage.setAlarm(2_000_000_000_000);
    await expect(state.storage.transaction(async () => {
      state.storage.sql.exec("UPDATE probe SET value = 2");
      await state.storage.setAlarm(2_000_000_100_000);
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(state.storage.sql.exec<{ value: number }>("SELECT value FROM probe").one().value).toBe(1);
    expect(await state.storage.getAlarm()).toBe(2_000_000_000_000);
    await state.storage.transaction(async () => {
      state.storage.sql.exec("UPDATE probe SET value = 3");
      await state.storage.setAlarm(2_000_000_200_000);
    });
    expect(state.storage.sql.exec<{ value: number }>("SELECT value FROM probe").one().value).toBe(3);
    expect(await state.storage.getAlarm()).toBe(2_000_000_200_000);
  });
});

test("metadata snapshot pages bind cursor to show and revision", async () => {
  const stub = env.SHOWS.get(env.SHOWS.newUniqueId());
  await runInDurableObject(stub, (_instance: ShowDO, state) => {
    const showId = "s-01234567";
    const ref = { key: "key", etag: '"opaque"', size: 1, sha256: "a".repeat(64) };
    const control: ShowControl = { record_version: 1, show_id: showId, revision: 1, metadata: ref, cover: null, deleted: false, accepted_at: 1,
      last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false };
    state.storage.transactionSync(() => {
      state.storage.sql.exec("INSERT INTO show_control VALUES (1, ?, 1, ?)", showId, JSON.stringify(control));
      for (let i = 0; i < 101; i++) {
        const episode_id = `e-${i.toString(16).padStart(8, "0")}`;
        const guid = `urn:uuid:${i}`;
        state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", episode_id, guid, JSON.stringify({ episode_id, guid, metadata: ref, deleted: i === 100 }));
      }
    });
    const first = readSnapshot(state.storage, showId);
    expect(first.episodes).toHaveLength(100);
    expect(first.next_cursor).toBeTruthy();
    const second = readSnapshot(state.storage, showId, first.next_cursor!);
    expect(second.episodes).toHaveLength(1);
    expect(second.episodes[0]!.deleted).toBe(true);
    expect(second.next_cursor).toBeNull();
    expect(() => readSnapshot(state.storage, "s-76543210", first.next_cursor!)).toThrow("cursor");
    expect(() => readSnapshot(state.storage, showId, "invalid!")).toThrow("cursor");
    control.revision = 2;
    state.storage.sql.exec("UPDATE show_control SET revision = 2, record_json = ?", JSON.stringify(control));
    expect(() => readSnapshot(state.storage, showId, first.next_cursor!)).toThrow("changed during pull");
  });
});

test("shared TOML and Temporal code runs inside Workers runtime", () => {
  const episode = episodeSchema.parse(parseToml('schema_version = 1\nid = "e-01234567"\nshow_id = "s-01234567"\npublished_at = 2026-01-01T12:00:00+09:00'));
  expect(resolvePublicationTime(episode.published_at!, "Asia/Tokyo")).toBe(Date.parse("2026-01-01T03:00:00Z"));
});

test("show storage initializes the versioned tables independently for each show", async () => {
  const first = env.SHOWS.get(env.SHOWS.newUniqueId());
  const second = env.SHOWS.get(env.SHOWS.newUniqueId());
  await runInDurableObject(first, (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec<{ schema_version: number }>("SELECT schema_version FROM schema_meta").one().schema_version).toBe(1);
    state.storage.sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", "e-01234567", "urn:uuid:test", "{}");
    expect(() => state.storage.sql.exec("INSERT INTO source_assets VALUES (?, ?, ?, ?)", "key", "delete_claimed", null, "{}")).toThrow();
  });
  await runInDurableObject(second, (_instance: ShowDO, state) => {
    expect(state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM episodes").one().count).toBe(0);
  });
});

test("acceptance is atomic, recognizes duplicate receipts and rejects stale or reused operations", async () => {
  const stub = env.SHOWS.get(env.SHOWS.newUniqueId());
  const showId = "s-01234567";
  const operation: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 0, action: "show.delete", payload: { confirmed: true } };
  const makeControl = (revision: number): ShowControl => ({
    record_version: 1, show_id: showId, revision, metadata: null, cover: null, deleted: true,
    accepted_at: 1, last_receipt: null, current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 },
    pending_delivery: null, restore_hold: false,
  });
  await runInDurableObject(stub, async (_instance: ShowDO, state) => {
    const apply = (sql: SqlStorage, _current: ShowControl | null, revision: number) => {
      sql.exec("INSERT INTO episodes VALUES (?, ?, ?)", "e-01234567", "urn:uuid:test", "{}");
      return { control: makeControl(revision), issues: [], delivery: "pending" as const, alarm: 2_000_000_000_000 };
    };
    const first = await commitAcceptance(state.storage, showId, operation, apply);
    expect(first.accepted_revision).toBe(1);
    const duplicate = await commitAcceptance(state.storage, showId, operation, () => { throw new Error("must not run twice"); });
    expect(duplicate.acceptance).toBe("already_accepted");
    expect(await state.storage.getAlarm()).toBe(2_000_000_000_000);
    await expect(commitAcceptance(state.storage, showId, { ...operation, expected_revision: 1 }, apply)).rejects.toThrow("different request");
    await expect(commitAcceptance(state.storage, showId, { ...operation, operation_id: "22345678-1234-4234-8234-123456789abc" }, apply)).rejects.toThrow("revision changed");
    const next = { ...operation, operation_id: "32345678-1234-4234-8234-123456789abc", expected_revision: 1 };
    await expect(commitAcceptance(state.storage, showId, next, sql => {
      sql.exec("DELETE FROM episodes");
      throw new Error("injected failure");
    })).rejects.toThrow("injected failure");
    expect(state.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM episodes").one().count).toBe(1);
    expect(state.storage.sql.exec<{ revision: number }>("SELECT revision FROM show_control").one().revision).toBe(1);
  });
});
