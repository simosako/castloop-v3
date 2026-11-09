import { z } from "zod";
import { canonicalJson, objectRefSchema } from "./contracts";
import { episodeIdPattern, showIdPattern } from "./identity";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = integer.refine(value => value > 0);
const text = z.string().min(1);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const episodeId = z.string().regex(episodeIdPattern);
const showId = z.string().regex(showIdPattern);
const audioFacts = z.strictObject({ mime: z.literal("audio/mpeg"), duration_ms: positive });
const coverFacts = z.strictObject({ mime: z.enum(["image/jpeg", "image/png"]), width: positive, height: positive, color: z.literal("rgb"), alpha: z.literal(false) });
const issue = z.strictObject({ code: text, path: z.string(), message: text, severity: z.enum(["error", "warning"]) });
const receiptResponse = z.strictObject({ protocol_version: z.literal(1), operation_id: uuid, accepted_revision: positive, acceptance: z.enum(["accepted", "already_accepted"]), validation_issues: z.array(issue), delivery: z.enum(["applied", "scheduled", "pending", "blocked", "failed"]) });
const control = z.strictObject({ record_version: z.literal(1), show_id: showId, revision: positive, metadata: objectRefSchema,
  cover: z.strictObject({ logical_name: text, ref: objectRefSchema, facts: coverFacts }).nullable(), deleted: z.boolean(), accepted_at: integer.nullable(),
  last_receipt: z.strictObject({ operation_id: uuid, fingerprint: text, response: receiptResponse }).nullable(),
  current_delivery: z.strictObject({ base: text, previous_base: text.nullable(), migration_operation_id: uuid.nullable(), applied_revision: integer }),
  pending_delivery: z.strictObject({ base: text, migration_operation_id: uuid, accepted_revision: positive }).nullable(), restore_hold: z.boolean(),
  scheduling: z.strictObject({ enabled: z.boolean(), serial: z.boolean() }).optional() });
const episode = z.strictObject({ record_version: z.literal(1), episode_id: episodeId, guid: text, metadata: objectRefSchema,
  audio: z.strictObject({ ref: objectRefSchema, facts: audioFacts }).nullable(), time: z.strictObject({ timezone: text, input_signature: text, instant_ms: integer }).nullable(),
  publish: z.boolean(), deleted: z.boolean(), scheduling: z.strictObject({ ready: z.boolean(), serial_ready: z.boolean() }).optional() });
const asset = z.strictObject({ record_version: z.literal(1), episode_id: episodeId.nullable(), kind: z.enum(["show_toml", "episode_toml", "audio", "cover", "maintenance"]),
  operation_id: uuid, ref: objectRefSchema, stored_at: integer, registered_at: integer, facts: z.union([audioFacts, coverFacts]).nullable(),
  state: z.enum(["present", "delete_claimed", "deleted", "missing"]), claim_operation_id: uuid.nullable() });
const outcome = z.strictObject({ record_version: z.literal(1), target: text, desired_identity: text, applied_identity: text.nullable(), attempt_revision: integer.nullable(),
  state: z.enum(["pending", "applied", "blocked", "failed"]), trigger: z.enum(["acceptance", "alarm", "recover", "restore-resume"]),
  error: z.strictObject({ code: text, message: text, operation_id: uuid.nullable(), at: integer }).nullable(), notification: z.enum(["unconfigured", "pending", "accepted", "failed"]).nullable() });
const feedEntry = z.strictObject({ id: episodeId, identity: text, metadata: objectRefSchema, audio: objectRefSchema, guid: text, publishedAt: integer, durationMs: positive });
const feedSnapshot = z.strictObject({ show: objectRefSchema, cover: objectRefSchema, coverPath: text, base: text, episodes: z.array(feedEntry) });
const delivery = z.strictObject({ record_version: z.literal(1), target: text, identity: text, sources: z.array(objectRefSchema), public_paths: z.array(text), applied_at: integer, snapshot: feedSnapshot.optional() });

export const showExportSchema = z.strictObject({ snapshot_version: z.literal(1), show_id: showId, source_revision: positive, show_control: control, episodes: z.array(episode),
  source_assets: z.array(asset), publication_outcomes: z.array(outcome), delivery_refs: z.array(delivery), required_objects: z.array(objectRefSchema), historical_missing_or_deleted: z.array(text) }).superRefine((snapshot, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (snapshot.show_control.show_id !== snapshot.show_id || snapshot.show_control.revision !== snapshot.source_revision) fail("Show identity or revision mismatch");
  const unique = (items: string[], label: string) => { if (new Set(items).size !== items.length) fail(`Duplicate ${label}`); };
  unique(snapshot.episodes.map(item => item.episode_id), "episode ID");
  unique(snapshot.episodes.map(item => item.guid), "episode GUID");
  unique(snapshot.source_assets.map(item => item.ref.key), "source key");
  unique(snapshot.publication_outcomes.map(item => item.target), "outcome target");
  unique(snapshot.delivery_refs.map(item => item.target), "delivery target");
  unique(snapshot.required_objects.map(item => item.key), "required source");
  unique(snapshot.historical_missing_or_deleted, "historical source");
  const assets = new Map(snapshot.source_assets.map(item => [item.ref.key, item]));
  const episodes = new Set(snapshot.episodes.map(item => item.episode_id));
  for (const item of snapshot.source_assets) {
    const episodeOwned = item.kind === "audio" || item.kind === "episode_toml";
    const root = item.episode_id ? `${snapshot.show_id}/${item.episode_id}` : snapshot.show_id;
    const folder = item.kind === "maintenance" ? "_maintenance" : "_versions";
    const prefix = `${root}/${folder}/${item.operation_id}/`;
    const filename = item.ref.key.startsWith(prefix) ? item.ref.key.slice(prefix.length) : "";
    const allowed = item.kind === "show_toml" ? filename === "show.toml" : item.kind === "episode_toml" ? filename === "episode.toml" : item.kind === "audio" ? filename === "audio.mp3" : item.kind === "maintenance" ? filename === "restore.json" : /^[^/\\]+\.(?:jpe?g|png)$/i.test(filename);
    if (!allowed || episodeOwned !== (item.episode_id !== null)) fail("Source owner or path mismatch");
    if ((item.state === "present" && item.claim_operation_id !== null) || ((item.state === "delete_claimed" || item.state === "deleted") && item.claim_operation_id === null)) fail("Invalid source retirement state");
  }
  const expected = new Map<string, string>();
  const add = (ref: z.infer<typeof objectRefSchema>) => { const identity = canonicalJson(ref), previous = expected.get(ref.key); if (previous && previous !== identity) fail("Conflicting required identities"); expected.set(ref.key, identity); };
  const selectedKind = (ref: z.infer<typeof objectRefSchema>, kind: string, owner: string | null) => { const source = assets.get(ref.key); if (!source || source.kind !== kind || source.episode_id !== owner || canonicalJson(source.ref) !== canonicalJson(ref)) fail("Selected source type or owner mismatch"); };
  if (!snapshot.show_control.deleted) {
    selectedKind(snapshot.show_control.metadata, "show_toml", null);
    add(snapshot.show_control.metadata);
    if (snapshot.show_control.cover) { selectedKind(snapshot.show_control.cover.ref, "cover", null); add(snapshot.show_control.cover.ref); }
    for (const item of snapshot.episodes) if (!item.deleted) { selectedKind(item.metadata, "episode_toml", item.episode_id); add(item.metadata); if (item.audio) { selectedKind(item.audio.ref, "audio", item.episode_id); add(item.audio.ref); } }
  }
  for (const item of snapshot.delivery_refs) {
    if (item.target !== "feed" && !episodes.has(item.target)) fail("Unknown delivery target");
    const paths = new RegExp(`^/${snapshot.show_id}/(?:feed\\.xml|e-[0-9abcdefghjkmnpqrstvwxyz]{8}/audio\\.mp3|covers/[a-f0-9]{64}\\.(?:jpg|png))$`);
    if (item.public_paths.some(path => !paths.test(path))) fail("Invalid public path");
    for (const ref of item.sources) add(ref);
    if (item.snapshot) {
      if (item.target !== "feed" || !item.public_paths.includes(`/${item.snapshot.coverPath}`)) fail("Feed snapshot target or cover mismatch");
      const snapshotSources = [item.snapshot.show, item.snapshot.cover, ...item.snapshot.episodes.flatMap(entry => [entry.metadata, entry.audio])];
      const sources = new Map(item.sources.map(ref => [ref.key, canonicalJson(ref)]));
      if (new Set(item.sources.map(ref => ref.key)).size !== item.sources.length || snapshotSources.some(ref => sources.get(ref.key) !== canonicalJson(ref)) || new Set(item.snapshot.episodes.map(entry => entry.id)).size !== item.snapshot.episodes.length) fail("Feed snapshot sources are inconsistent");
      for (const entry of item.snapshot.episodes) if (snapshot.episodes.find(episode => episode.episode_id === entry.id)?.guid !== entry.guid) fail("Feed snapshot GUID mismatch");
    }
  }
  for (const item of snapshot.publication_outcomes) if (item.target !== "feed" && item.target !== "show-withdrawal" && !episodes.has(item.target)) fail("Unknown outcome target");
  const required = new Map(snapshot.required_objects.map(ref => [ref.key, canonicalJson(ref)]));
  if (required.size !== expected.size || [...expected].some(([key, value]) => required.get(key) !== value)) fail("Required source manifest mismatch");
  for (const [key, value] of expected) { const item = assets.get(key); if (!item || item.state !== "present" || canonicalJson(item.ref) !== value) fail("Required source is missing or retired"); }
  const historical = snapshot.source_assets.filter(item => item.state === "missing" || item.state === "deleted").map(item => item.ref.key);
  if (historical.length !== snapshot.historical_missing_or_deleted.length || historical.some(key => !snapshot.historical_missing_or_deleted.includes(key))) fail("Historical source manifest mismatch");
});

export const exportEnvelopeSchema = z.strictObject({ format_version: z.literal(1), created_at: integer,
  installation: z.strictObject({ management_origin: text, management_bucket: text, delivery_bucket: text }), shows: z.array(showExportSchema) })
  .refine(value => new Set(value.shows.map(show => show.show_id)).size === value.shows.length, "Duplicate show ID");
export type ShowExport = z.infer<typeof showExportSchema>;
