import { expect, test } from "bun:test";
import { collectSnapshot, fetchSnapshotPage, RejectedOperationError, submitOperation, UncertainOperationError } from "../src/api";
import type { Operation } from "@castloop/domain";

const id = "s-01234567";
const ref = { key: "key", etag: '"etag"', size: 1, sha256: "a".repeat(64) };
const episode = { episode_id: "e-01234567", metadata: ref, guid: "opaque", deleted: false };

test("rejects repeated cursors and duplicate or unordered snapshot entries", async () => {
  const page = { protocol_version: 1, show_id: id, revision: 1, show: { metadata: ref, deleted: false }, episodes: [episode], next_cursor: "same" };
  await expect(collectSnapshot(id, async () => page)).rejects.toThrow();
  await expect(collectSnapshot(id, async () => ({ ...page, episodes: [episode, episode], next_cursor: null }))).rejects.toThrow("duplicate");
});

test("mutation distinguishes explicit rejection from an uncertain response", async () => {
  const operation: Operation = { protocol_version: 1, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 1, action: "show.delete", payload: { confirmed: true } };
  const accepted = { protocol_version: 1 as const, operation_id: operation.operation_id, accepted_revision: 2, acceptance: "accepted" as const, validation_issues: [], delivery: "pending" as const };
  expect(await submitOperation("https://example.test", "token", id, operation, async () => Response.json(accepted))).toEqual(accepted);
  const reject = async () => Response.json({ protocol_version: 1, operation_id: operation.operation_id, acceptance: "rejected", issues: [{ code: "revision_conflict", message: "stale" }] }, { status: 409 });
  await expect(submitOperation("https://example.test", "token", id, operation, reject)).rejects.toBeInstanceOf(RejectedOperationError);
  const collision = async () => Response.json({ protocol_version: 1, operation_id: operation.operation_id, acceptance: "rejected", issues: [{ code: "identity_conflict", path: "episodes.e-01234567.id", message: "in use" }] }, { status: 409 });
  try { await submitOperation("https://example.test", "token", id, operation, collision); throw new Error("expected rejection"); }
  catch (error) { expect(error).toBeInstanceOf(RejectedOperationError); expect(error).toMatchObject({ path: "episodes.e-01234567.id", operationMatched: true }); }
  const unidentified = async () => Response.json({ protocol_version: 1, operation_id: null, acceptance: "rejected", issues: [{ code: "identity_conflict", path: "episodes.e-01234567.id", message: "in use" }] }, { status: 409 });
  try { await submitOperation("https://example.test", "token", id, operation, unidentified); throw new Error("expected rejection"); }
  catch (error) { expect(error).toMatchObject({ operationMatched: false }); }
  await expect(submitOperation("https://example.test", "token", id, operation, async () => { throw new Error("disconnected"); })).rejects.toBeInstanceOf(UncertainOperationError);
  await expect(submitOperation("https://example.test", "token", id, operation, async () => Response.json({ error: "unavailable" }, { status: 503 }))).rejects.toBeInstanceOf(UncertainOperationError);
  await expect(submitOperation("https://example.test", "token", id, operation, async () => Response.json({ ...accepted, operation_id: "wrong" }))).rejects.toBeInstanceOf(UncertainOperationError);
});

test("authenticates snapshot requests and translates revision drift", async () => {
  let authorization = "";
  const transport = async (_input: URL, options: RequestInit) => {
    authorization = new Headers(options?.headers).get("authorization") ?? "";
    return Response.json({ issues: [{ code: "snapshot_revision_changed", message: "changed" }] }, { status: 409 });
  };
  await expect(fetchSnapshotPage("https://example.test", "token", id, undefined, transport)).rejects.toThrow("run pull again");
  expect(authorization).toBe("Bearer token");
  await expect(fetchSnapshotPage("http://example.test", "token", id, undefined, transport)).rejects.toThrow("HTTPS");
});
