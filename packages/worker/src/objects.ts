import { objectRefSchema, parseToml, showSchema, episodeSchema, type ObjectRef } from "@castloop/domain";
import { assertSourceOwnership, SourceIdentityError, type SourceOwner } from "./source-ownership";
export { assertSourceOwnership, SourceIdentityError } from "./source-ownership";
export { copyMediaObject } from "./copy";

export class SourceMetadataError extends Error {}

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
