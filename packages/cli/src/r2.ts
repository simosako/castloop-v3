import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Transform } from "node:stream";
import { CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { showIdPattern, type ObjectRef } from "@castloop/domain";

export interface R2Connection { accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string; endpoint?: string }

export function createR2Client(config: R2Connection): S3Client {
  if (!/^[a-f0-9]{32}$/.test(config.accountId)) throw new Error("Invalid Cloudflare account ID");
  if (!config.bucket || !config.accessKeyId || !config.secretAccessKey) throw new Error("R2 bucket and credentials are required");
  const endpoint = new URL(config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`);
  if (endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash ||
    (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
    throw new Error("R2 endpoint must be an HTTPS origin or local HTTP origin");
  }
  return new S3Client({ endpoint: endpoint.origin, region: "auto", forcePathStyle: true, maxAttempts: 3,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
}

/** Download one bounded metadata object directly through the S3-compatible API. */
async function readR2Bounded(client: S3Client, bucket: string, ref: ObjectRef, limit: number): Promise<{ bytes: Uint8Array; etag: string }> {
  if (!bucket || ref.size > limit || ref.size < 0 || !Number.isSafeInteger(ref.size)) throw new Error("Invalid metadata object size or bucket");
  const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: ref.key, IfMatch: ref.etag }));
  if (!result.Body || !result.ETag || result.ETag !== ref.etag || result.ContentLength !== ref.size) {
    result.Body?.transformToWebStream().cancel().catch(() => {});
    throw new Error("R2 object identity or size mismatch");
  }
  const reader = result.Body.transformToWebStream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit || length > ref.size) { await reader.cancel(); throw new Error("R2 object exceeds expected size"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== ref.size) throw new Error("R2 object was truncated");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  if (ref.sha256 && createHash("sha256").update(bytes).digest("hex") !== ref.sha256) throw new Error("R2 metadata digest mismatch");
  return { bytes, etag: result.ETag };
}

export async function readR2Metadata(client: S3Client, bucket: string, ref: ObjectRef): Promise<{ bytes: Uint8Array; etag: string }> {
  return readR2Bounded(client, bucket, ref, 256 * 1024);
}

/** Discover candidates; DO state still decides whether each show exists. */
export async function listCandidateShows(client: S3Client, bucket: string): Promise<string[]> {
  const result = new Set<string>();
  const seen = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Delimiter: "/", ContinuationToken: token }));
    for (const entry of page.CommonPrefixes ?? []) {
      const prefix = entry.Prefix;
      if (prefix?.endsWith("/") && showIdPattern.test(prefix.slice(0, -1))) result.add(prefix.slice(0, -1));
    }
    const next = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!next || seen.has(next))) throw new Error("R2 listing pagination did not advance");
    if (next) seen.add(next);
    token = next;
  } while (token);
  return [...result].sort();
}

/** Prepare one immutable TOML object; a retry can reuse only an identical body. */
async function putR2Bytes(client: S3Client, bucket: string, key: string, bytes: Uint8Array, contentType: string, limit: number): Promise<ObjectRef> {
  if (!bucket || !key || bytes.length > limit) throw new Error("Invalid object size, key or bucket");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let alreadyExisted = false;
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentLength: bytes.length,
      ContentType: contentType, IfNoneMatch: "*", Metadata: { sha256 } }));
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412) throw error;
    alreadyExisted = true;
  }
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!head.ETag || head.ContentLength !== bytes.length || head.Metadata?.sha256 !== sha256) throw new Error("Existing metadata key has different identity or digest");
  const ref: ObjectRef = { key, etag: head.ETag, size: bytes.length, sha256 };
  if (alreadyExisted) {
    const existing = await readR2Bounded(client, bucket, ref, limit);
    if (createHash("sha256").update(existing.bytes).digest("hex") !== sha256) throw new Error("Existing metadata body has different digest");
  }
  return ref;
}

export async function putR2Metadata(client: S3Client, bucket: string, key: string, bytes: Uint8Array): Promise<ObjectRef> {
  return putR2Bytes(client, bucket, key, bytes, "application/toml", 256 * 1024);
}

export async function putR2Cover(client: S3Client, bucket: string, key: string, bytes: Uint8Array, mime: "image/jpeg" | "image/png"): Promise<ObjectRef> {
  if (!bytes.length) throw new Error("Cover is empty");
  return putR2Bytes(client, bucket, key, bytes, mime, 20 * 1024 * 1024);
}

export async function putR2RestoreEnvelope(client: S3Client, bucket: string, key: string, bytes: Uint8Array): Promise<ObjectRef> {
  if (!bytes.length) throw new Error("Restore envelope is empty");
  return putR2Bytes(client, bucket, key, bytes, "application/json", 16 * 1024 * 1024);
}

/** Stream a create-only audio object, binding the request body to the inspected digest. */
export async function putR2Audio(client: S3Client, bucket: string, key: string, path: string, inspected: { size: number; sha256: string }): Promise<ObjectRef> {
  if (!bucket || !key || !Number.isSafeInteger(inspected.size) || inspected.size <= 0 || inspected.size > 1024 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(inspected.sha256)) throw new Error("Invalid audio object identity");
  if (inspected.size > 16 * 1024 * 1024) return putMultipartAudio(client, bucket, key, path, inspected);
  const body = createReadStream(path);
  try {
    await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: inspected.size,
      ContentType: "audio/mpeg", IfNoneMatch: "*", ChecksumSHA256: Buffer.from(inspected.sha256, "hex").toString("base64"), Metadata: { sha256: inspected.sha256 } }));
  } finally { body.destroy(); }
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!head.ETag || head.ContentLength !== inspected.size || head.Metadata?.sha256 !== inspected.sha256) throw new Error("Uploaded audio identity or digest does not match inspection");
  return { key, etag: head.ETag, size: inspected.size, sha256: inspected.sha256 };
}

/** Upload to an attributable unique staging key, then create the selected key conditionally. */
async function putMultipartAudio(client: S3Client, bucket: string, key: string, path: string, inspected: { size: number; sha256: string }): Promise<ObjectRef> {
  const match = /^(s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/e-[0-9abcdefghjkmnpqrstvwxyz]{8}\/_versions\/)[0-9a-f-]{36}\/audio\.mp3$/.exec(key);
  if (!match) throw new Error("Invalid audio preparation key");
  const stagingKey = `${match[1]}${randomUUID()}/audio.mp3`;
  const hash = createHash("sha256");
  let consumed = 0;
  const source = createReadStream(path);
  const hashing = new Transform({ transform(chunk: Buffer, _encoding, callback) { consumed += chunk.length; hash.update(chunk); callback(null, chunk); } });
  source.on("error", error => hashing.destroy(error));
  source.pipe(hashing);
  const upload = new Upload({ client, queueSize: 2, partSize: 16 * 1024 * 1024, leavePartsOnError: false,
    params: { Bucket: bucket, Key: stagingKey, Body: hashing, ContentLength: inspected.size, ContentType: "audio/mpeg", Metadata: { sha256: inspected.sha256 } } });
  let interrupted = false;
  const interrupt = () => {
    if (interrupted) return;
    interrupted = true;
    // A caught interruption attempts the SDK's multipart abort. A hard kill or
    // an unavailable R2 endpoint can still leave parts for the bucket lifecycle.
    void upload.abort().catch(() => {});
    source.destroy();
    hashing.destroy();
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    await upload.done();
    if (interrupted) throw new Error("Audio upload interrupted; incomplete multipart parts are handled by the R2 lifecycle policy");
  } catch (error) {
    if (interrupted) throw new Error("Audio upload interrupted; incomplete multipart parts are handled by the R2 lifecycle policy");
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    source.destroy(); hashing.destroy();
  }
  if (consumed !== inspected.size || hash.digest("hex") !== inspected.sha256) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).catch(() => {});
    throw new Error("Audio changed after inspection; staged upload was not selected");
  }
  const staged = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: stagingKey }));
  if (!staged.ETag || staged.ContentLength !== inspected.size || staged.Metadata?.sha256 !== inspected.sha256) throw new Error("Staged audio identity does not match inspection");
  const encodedSource = `/${encodeURIComponent(bucket)}/${stagingKey.split("/").map(encodeURIComponent).join("/")}`;
  const copy = new CopyObjectCommand({ Bucket: bucket, Key: key, CopySource: encodedSource, CopySourceIfMatch: staged.ETag });
  copy.middlewareStack.add(next => async args => {
    const request = args.request as { headers: Record<string, string> };
    request.headers["cf-copy-destination-if-none-match"] = "*";
    return next(args);
  }, { step: "build", name: "castloopCreateOnlyCopy" });
  // Keep the staging object when copy outcome is uncertain, so inventory can inspect it.
  await client.send(copy);
  const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  if (!head.ETag || head.ContentLength !== inspected.size || head.Metadata?.sha256 !== inspected.sha256) throw new Error("Copied audio identity does not match inspection");
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: stagingKey })).catch(() => {});
  return { key, etag: head.ETag, size: inspected.size, sha256: inspected.sha256 };
}

/** Discover and identify every object under a Show prefix, without reading bodies. */
export async function listR2ShowObjects(client: S3Client, bucket: string, showId: string): Promise<{ refs: ObjectRef[]; skipped: { key: string; reason: string }[] }> {
  if (!bucket || !showIdPattern.test(showId)) throw new Error("Invalid inventory bucket or Show ID");
  const prefix = `${showId}/`, refs: ObjectRef[] = [], skipped: { key: string; reason: string }[] = [];
  const seen = new Set<string>(), cursors = new Set<string>();
  let token: string | undefined;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const item of page.Contents ?? []) {
      const key = item.Key;
      if (!key || !key.startsWith(prefix) || seen.has(key)) throw new Error("R2 listing returned invalid or duplicate object keys");
      seen.add(key);
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const sha = head.Metadata?.sha256 ?? null;
        if (!head.ETag || !Number.isSafeInteger(head.ContentLength) || (head.ContentLength ?? -1) < 0 || (sha !== null && !/^[a-f0-9]{64}$/.test(sha))) throw new Error("Object identity or SHA-256 metadata is invalid");
        refs.push({ key, etag: head.ETag, size: head.ContentLength!, sha256: sha });
      } catch (error) { skipped.push({ key, reason: error instanceof Error ? error.message : "Object inspection failed" }); }
    }
    const next = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!next || cursors.has(next))) throw new Error("R2 listing cursor did not advance");
    if (next) cursors.add(next);
    token = next;
  } while (token);
  return { refs, skipped };
}

/** Delete only after a fresh identity check; an already absent claimed key is complete. */
export async function deleteClaimedR2Object(client: S3Client, bucket: string, ref: ObjectRef): Promise<void> {
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: ref.key }));
    if (head.ETag !== ref.etag || head.ContentLength !== ref.size || (head.Metadata?.sha256 ?? null) !== ref.sha256) throw new Error("Claimed object identity changed; refusing deletion");
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return;
    throw error;
  }
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: ref.key }));
}
