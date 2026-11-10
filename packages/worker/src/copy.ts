import { episodeIdPattern, showIdPattern } from "@castloop/domain/identity";
import { objectRefSchema, type ObjectRef } from "@castloop/domain/contracts";
import { AwsClient } from "aws4fetch";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { assertSourceOwnership } from "./source-ownership";

export interface CopyConfiguration { accountId: string; sourceBucket: string; deliveryBucket: string; accessKeyId: string; secretAccessKey: string }
const encodeKey = (key: string) => key.split("/").map(part => encodeURIComponent(part)).join("/");

/** Promote one selected media object via a conditional R2-side CopyObject request. */
export async function copyMediaObject(config: CopyConfiguration, source: ObjectRef, targetKey: string, mime: "audio/mpeg" | "image/jpeg" | "image/png", transport: (request: Request) => Promise<Response> = request => fetch(request), signer?: AwsClient): Promise<void> {
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
  const aws = signer ?? new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: "s3", region: "auto", retries: 0 });
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
