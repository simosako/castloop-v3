import { expect, test } from "bun:test";
import { exportEnvelopeSchema, showExportSchema } from "../src/export";

test("export validation rejects altered ownership, unknown fields, retired requirements and duplicate identities", () => {
  const show = "s-01234567", ep = "e-01234567", op = "12345678-1234-4234-8234-123456789abc";
  const source = (key: string) => ({ key, etag: '"etag"', size: 7, sha256: "a".repeat(64) });
  const showRef = source(`${show}/_versions/${op}/show.toml`), epRef = source(`${show}/${ep}/_versions/${op}/episode.toml`);
  const asset = (ref: typeof showRef, kind: string, episode_id: string | null) => ({ record_version: 1, episode_id, kind, operation_id: op, ref, stored_at: 1, registered_at: 1, facts: null, state: "present", claim_operation_id: null });
  const input = { snapshot_version: 1, show_id: show, source_revision: 4,
    show_control: { record_version: 1, show_id: show, revision: 4, metadata: showRef, cover: null, deleted: false, accepted_at: 1, last_receipt: null,
      current_delivery: { base: "https://example.test", previous_base: null, migration_operation_id: null, applied_revision: 0 }, pending_delivery: null, restore_hold: false },
    episodes: [{ record_version: 1, episode_id: ep, guid: "external-non-uuid-guid", metadata: epRef, audio: null, time: null, publish: false, deleted: false }],
    source_assets: [asset(showRef, "show_toml", null), asset(epRef, "episode_toml", ep)], publication_outcomes: [], delivery_refs: [], required_objects: [showRef, epRef], historical_missing_or_deleted: [] };
  expect(showExportSchema.parse(input).episodes[0]?.guid).toBe("external-non-uuid-guid");
  const envelope = { format_version: 1, created_at: 1, installation: { management_origin: "https://example.test", management_bucket: "source", delivery_bucket: "delivery" }, shows: [input] };
  expect(exportEnvelopeSchema.safeParse(envelope).success).toBe(true);
  expect(exportEnvelopeSchema.safeParse({ ...envelope, unknown: true }).success).toBe(false);
  expect(exportEnvelopeSchema.safeParse({ ...envelope, shows: [input, input] }).success).toBe(false);
  expect(showExportSchema.safeParse({ ...input, episodes: [...input.episodes, input.episodes[0]] }).success).toBe(false);
  expect(showExportSchema.safeParse({ ...input, required_objects: [showRef] }).success).toBe(false);
  expect(showExportSchema.safeParse({ ...input, source_assets: [asset(showRef, "cover", null), input.source_assets[1]] }).success).toBe(false);
  expect(showExportSchema.safeParse({ ...input, source_assets: [{ ...input.source_assets[0], state: "deleted", claim_operation_id: op }, input.source_assets[1]], historical_missing_or_deleted: [showRef.key] }).success).toBe(false);
  expect(showExportSchema.safeParse({ ...input, source_revision: 5 }).success).toBe(false);
});
