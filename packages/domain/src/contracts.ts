import { z } from "zod";
import { episodeIdPattern } from "./identity";

const id = z.string().regex(episodeIdPattern);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const safeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = safeInteger.refine(n => n > 0);
const nonempty = z.string().min(1);
export const objectRefSchema = z.strictObject({
  key: nonempty, etag: nonempty, size: safeInteger,
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
});
const preparedRef = objectRefSchema.extend({ sha256: z.string().regex(/^[0-9a-f]{64}$/) });
const showEdit = z.strictObject({ mode: z.enum(["create", "update"]), metadata: preparedRef });
const episodeEdit = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("create"), episode_id: id, metadata: preparedRef, guid: nonempty }),
  z.strictObject({ mode: z.literal("update"), episode_id: id, metadata: preparedRef }),
]);
const base = { protocol_version: z.literal(1), operation_id: uuid, expected_revision: safeInteger };

export const operationSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...base, action: z.literal("metadata.batch"), payload: z.strictObject({
    show: showEdit.optional(), episodes: z.array(episodeEdit).refine(items => new Set(items.map(x => x.episode_id)).size === items.length, "Episode IDs must be unique"), confirm_show_stop: z.literal(true).optional(),
  }) }),
  z.strictObject({ ...base, action: z.literal("audio.set"), payload: z.strictObject({
    episode_id: id, audio: preparedRef, facts: z.strictObject({ mime: z.literal("audio/mpeg"), duration_ms: positive }),
  }) }),
  z.strictObject({ ...base, action: z.literal("cover.set"), payload: z.strictObject({
    logical_name: nonempty, cover: preparedRef,
    facts: z.strictObject({ mime: z.enum(["image/jpeg", "image/png"]), width: positive, height: positive, color: z.literal("rgb"), alpha: z.literal(false) }),
  }) }),
  z.strictObject({ ...base, action: z.literal("episode.delete"), payload: z.strictObject({ episode_id: id, confirmed: z.literal(true) }) }),
  z.strictObject({ ...base, action: z.literal("show.delete"), payload: z.strictObject({ confirmed: z.literal(true) }) }),
  z.strictObject({ ...base, action: z.literal("delivery.set"), payload: z.strictObject({ target_base: nonempty, confirmed: z.literal(true) }) }),
]);
export type Operation = z.infer<typeof operationSchema>;

/** Canonical JSON for request identity. Reject values that JSON would silently change. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new Error("Sparse arrays are not JSON values");
      values.push(canonicalJson(value[i]));
    }
    return `[${values.join(",")}]`;
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  throw new Error("Value is not JSON");
}

export async function operationFingerprint(showId: string, operation: Operation): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ ...operation, show_id: showId }));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
