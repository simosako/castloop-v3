import { episodeIdPattern, objectRefSchema, parseToml, showIdPattern, showSchema, episodeSchema, type ObjectRef } from "@castloop/domain";
import { AwsClient } from "aws4fetch";
import { XMLParser, XMLValidator } from "fast-xml-parser";

type SourceOwner = { showId: string; operationId: string } & (
  | { kind: "show_toml"; episodeId?: never }
  | { kind: "cover"; episodeId?: never }
  | { kind: "episode_toml"; episodeId: string }
  | { kind: "audio"; episodeId: string }
  | { kind: "maintenance"; episodeId?: never }
);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class SourceIdentityError extends Error {}
export class SourceMetadataError extends Error {}

/** Derive ownership from the key itself, never from R2 user metadata. */
export function assertSourceOwnership(key: string, owner: SourceOwner): void {
  if (!showIdPattern.test(owner.showId) || !uuid.test(owner.operationId)) throw new SourceIdentityError("Invalid source owner");
  if (owner.episodeId && !episodeIdPattern.test(owner.episodeId)) throw new SourceIdentityError("Invalid episode ID");
  const prefix = owner.episodeId ? `${owner.showId}/${owner.episodeId}` : owner.showId;
  const root = `${prefix}/${owner.kind === "maintenance" ? "_maintenance" : "_versions"}/${owner.operationId}/`;
  if (!key.startsWith(root)) throw new SourceIdentityError("Source object owner or preparation operation does not match");
  const filename = key.slice(root.length);
  const allowed = owner.kind === "show_toml" ? filename === "show.toml"
    : owner.kind === "episode_toml" ? filename === "episode.toml"
    : owner.kind === "audio" ? filename === "audio.mp3"
    : owner.kind === "maintenance" ? filename === "restore.json"
    : /^[^/\\]+\.(?:jpe?g|png)$/i.test(filename);
  if (!allowed) throw new SourceIdentityError("Invalid source object name");
}

/** Media identity includes the digest recorded when the CLI uploaded it. */
export function mediaDigestMatches(kind: string | undefined, ref: ObjectRef, object: R2Object): boolean {
  return (kind !== "audio" && kind !== "cover") || (!!ref.sha256 && object.customMetadata?.sha256 === ref.sha256);
}

/** HEAD checks immutable object identity without downloading media bodies. */
export async function verifySourceRef(bucket: R2Bucket, input: ObjectRef, owner: SourceOwner): Promise<R2Object> {
  const ref = objectRefSchema.parse(input);
  assertSourceOwnership(ref.key, owner);
  const object = await bucket.head(ref.key);
  if (!object || object.httpEtag !== ref.etag || object.size !== ref.size) throw new SourceIdentityError("Source object is missing or its identity changed");
  if (!mediaDigestMatches(owner.kind, ref, object)) throw new SourceIdentityError("Source object digest metadata is missing or does not match");
  return object;
}

/** Read a bounded TOML body conditionally and verify its digest and embedded ID. */
export async function readMetadataSource(bucket: R2Bucket, ref: ObjectRef, owner: Extract<SourceOwner, { kind: "show_toml" | "episode_toml" }>): Promise<string> {
  objectRefSchema.parse(ref);
  assertSourceOwnership(ref.key, owner);
  if (ref.size > 256 * 1024 || !ref.sha256) throw new SourceMetadataError("Invalid TOML size or missing digest");
  const object = await bucket.get(ref.key, { onlyIf: new Headers({ "If-Match": ref.etag }) });
  if (!object || !("body" in object) || object.httpEtag !== ref.etag || object.size !== ref.size) throw new SourceIdentityError("Source object is missing or its identity changed");
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== ref.size) throw new SourceIdentityError("TOML body size mismatch");
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  if (digest !== ref.sha256) throw new SourceIdentityError("TOML digest mismatch");
  let text: string, parsed: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); parsed = parseToml(text); }
  catch (error) { throw new SourceMetadataError(`Invalid TOML: ${error instanceof Error ? error.message.slice(0, 1000) : "parse failed"}`); }
  if (owner.kind === "show_toml") {
    const result = showSchema.safeParse(parsed);
    if (!result.success) throw new SourceMetadataError(`Invalid Show TOML: ${result.error.message.slice(0, 1000)}`);
    if (result.data.id !== owner.showId) throw new SourceIdentityError("Show ID in TOML does not match source owner");
  } else {
    const result = episodeSchema.safeParse(parsed);
    if (!result.success) throw new SourceMetadataError(`Invalid Episode TOML: ${result.error.message.slice(0, 1000)}`);
    if (result.data.show_id !== owner.showId || result.data.id !== owner.episodeId) throw new SourceIdentityError("Episode identity in TOML does not match source owner");
  }
  return text;
}

export interface CopyConfiguration { accountId: string; sourceBucket: string; deliveryBucket: string; accessKeyId: string; secretAccessKey: string }
const encodeKey = (key: string) => key.split("/").map(part => encodeURIComponent(part)).join("/");

/** Promote one selected media object via a conditional R2-side CopyObject request. */
export async function copyMediaObject(config: CopyConfiguration, source: ObjectRef, targetKey: string, mime: "audio/mpeg" | "image/jpeg" | "image/png", transport: (request: Request) => Promise<Response> = request => fetch(request)): Promise<void> {
  objectRefSchema.parse(source);
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.sourceBucket) ||
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.deliveryBucket) || !config.accessKeyId || !config.secretAccessKey) throw new Error("R2 copy credentials or bucket configuration are invalid");
  const parts = targetKey.split("/");
  if (parts.length !== 3 || !showIdPattern.test(parts[0]!)) throw new Error("Invalid public media path");
  if (episodeIdPattern.test(parts[1]!) && parts[2] === "audio.mp3" && mime === "audio/mpeg") {
    const sourceParts = source.key.split("/");
    assertSourceOwnership(source.key, { kind: "audio", showId: parts[0]!, episodeId: parts[1]!, operationId: sourceParts[3] ?? "" });
  } else if (parts[1] === "covers" && /^[A-Za-z0-9_-]+\.(?:jpg|png)$/.test(parts[2]!) &&
    (mime === "image/png" ? parts[2]!.endsWith(".png") : mime === "image/jpeg" && parts[2]!.endsWith(".jpg"))) {
    const sourceParts = source.key.split("/");
    assertSourceOwnership(source.key, { kind: "cover", showId: parts[0]!, operationId: sourceParts[2] ?? "" });
  } else throw new Error("Invalid public media path or content type");
  const aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 0 });
  const url = `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.deliveryBucket)}/${encodeKey(targetKey)}`;
  const signed = await aws.sign(url, { method: "PUT", headers: {
    "x-amz-copy-source": `/${encodeURIComponent(config.sourceBucket)}/${encodeKey(source.key)}`,
    "x-amz-copy-source-if-match": source.etag,
    "x-amz-metadata-directive": "REPLACE",
    "Content-Type": mime,
    "Cache-Control": "public, max-age=0, s-maxage=2592000, must-revalidate",
  } });
  const response = await transport(signed);
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`R2 copy failed with HTTP ${response.status}`); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 65536) { await reader.cancel(); throw new Error("R2 copy response is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/<!DOCTYPE/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error("R2 copy returned invalid XML");
  const parsed = new XMLParser({ processEntities: false, removeNSPrefix: true }).parse(xml) as { CopyObjectResult?: { ETag?: unknown }; Error?: unknown };
  if (parsed.Error || typeof parsed.CopyObjectResult?.ETag !== "string" || !parsed.CopyObjectResult.ETag) throw new Error("R2 copy did not return a successful object result");
}
