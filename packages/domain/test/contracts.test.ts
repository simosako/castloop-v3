import { expect, test } from "bun:test";
import { canonicalJson, operationFingerprint, operationSchema } from "../src";

const base = { protocol_version: 1 as const, operation_id: "12345678-1234-4234-8234-123456789abc", expected_revision: 1 };
const ref = { key: "s-01234567/_versions/x/show.toml", etag: "opaque", size: 5, sha256: "a".repeat(64) };

test("accepts all six actions and rejects malformed or ambiguous updates", () => {
  const actions = [
    { action: "metadata.batch", payload: { show: { mode: "update", metadata: ref }, episodes: [] } },
    { action: "audio.set", payload: { episode_id: "e-01234567", audio: ref, facts: { mime: "audio/mpeg", duration_ms: 100 } } },
    { action: "cover.set", payload: { logical_name: "cover.jpg", cover: ref, facts: { mime: "image/jpeg", width: 1400, height: 1400, color: "rgb", alpha: false } } },
    { action: "episode.delete", payload: { episode_id: "e-01234567", confirmed: true } },
    { action: "show.delete", payload: { confirmed: true } },
    { action: "delivery.set", payload: { target_base: "https://example.com", confirmed: true } },
  ];
  for (const action of actions) expect(operationSchema.safeParse({ ...base, ...action }).success).toBe(true);
  expect(operationSchema.safeParse({ ...base, action: "show.delete", payload: { confirmed: false } }).success).toBe(false);
  expect(operationSchema.safeParse({ ...base, action: "show.delete", payload: { confirmed: true, extra: 1 } }).success).toBe(false);
  expect(operationSchema.safeParse({ ...base, action: "metadata.batch", payload: { episodes: [{ mode: "update", episode_id: "e-01234567", metadata: { ...ref, sha256: null } }] } }).success).toBe(false);
});

test("fingerprints canonical object order but preserves array order", async () => {
  const a = operationSchema.parse({ ...base, action: "show.delete", payload: { confirmed: true } });
  const b = operationSchema.parse({ action: "show.delete", payload: { confirmed: true }, expected_revision: 1, operation_id: base.operation_id, protocol_version: 1 });
  expect(await operationFingerprint("s-01234567", a)).toBe(await operationFingerprint("s-01234567", b));
  expect(canonicalJson({ a: [1, 2] })).not.toBe(canonicalJson({ a: [2, 1] }));
  for (const bad of [undefined, NaN, Infinity, [undefined], { a: undefined }, new Date()]) expect(() => canonicalJson(bad)).toThrow();
});
