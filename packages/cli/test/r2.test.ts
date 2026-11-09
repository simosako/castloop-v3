import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createR2Client, deleteClaimedR2Object, listCandidateShows, putR2Audio, putR2Metadata, readR2Metadata } from "../src/r2";

test("reads metadata directly over S3 with the opaque ETag condition", async () => {
  let conditional = "";
  let signed = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    conditional = request.headers.get("if-match") ?? "";
    signed = (request.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256 ");
    if (conditional !== '"opaque-etag"') return new Response(null, { status: 412 });
    return new Response("test", { headers: { etag: '"opaque-etag"', "content-length": "4" } });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  const ref = { key: "s-01234567/_versions/x/show.toml", etag: '"opaque-etag"', size: 4, sha256: null };
  try {
    expect(new TextDecoder().decode((await readR2Metadata(client, "bucket", ref)).bytes)).toBe("test");
    expect(conditional).toBe(ref.etag);
    expect(signed).toBe(true);
    await expect(readR2Metadata(client, "bucket", { ...ref, size: 5 })).rejects.toThrow("identity or size mismatch");
    await expect(readR2Metadata(client, "bucket", { ...ref, etag: '"wrong"' })).rejects.toThrow();
  } finally { client.destroy(); server.stop(true); }
});

test("discovers and paginates candidate show prefixes", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const page = new URL(request.url).searchParams.get("continuation-token");
    const body = page
      ? '<ListBucketResult><IsTruncated>false</IsTruncated><CommonPrefixes><Prefix>s-76543210/</Prefix></CommonPrefixes></ListBucketResult>'
      : '<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next</NextContinuationToken><CommonPrefixes><Prefix>s-01234567/</Prefix></CommonPrefixes><CommonPrefixes><Prefix>unrelated/</Prefix></CommonPrefixes></ListBucketResult>';
    return new Response(body, { headers: { "content-type": "application/xml" } });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  try { expect(await listCandidateShows(client, "bucket")).toEqual(["s-01234567", "s-76543210"]); }
  finally { client.destroy(); server.stop(true); }
});

test("rejects insecure nonlocal endpoints and oversized TOML", async () => {
  const credentials = { accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test" };
  expect(() => createR2Client({ ...credentials, endpoint: "http://example.com" })).toThrow();
  expect(() => createR2Client({ ...credentials, endpoint: "https://user:pass@example.com" })).toThrow();
  const client = createR2Client(credentials);
  try { await expect(readR2Metadata(client, "bucket", { key: "key", etag: '"etag"', size: 256 * 1024 + 1, sha256: null })).rejects.toThrow(); }
  finally { client.destroy(); }
});

test("metadata upload uses create-only writes and reuses only identical existing content", async () => {
  let stored: Uint8Array<ArrayBuffer> | undefined;
  let storedDigest = "";
  let conditional = "";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "PUT") {
      conditional = request.headers.get("if-none-match") ?? "";
      if (stored) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412, headers: { "content-type": "application/xml" } });
      stored = new Uint8Array(await request.arrayBuffer());
      storedDigest = request.headers.get("x-amz-meta-sha256") ?? "";
      return new Response(null, { status: 200, headers: { etag: '"opaque"' } });
    }
    if (!stored) return new Response(null, { status: 404 });
    const headers = { etag: '"opaque"', "content-length": String(stored.length), "x-amz-meta-sha256": storedDigest };
    return new Response(request.method === "HEAD" ? null : stored, { headers });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  try {
    const bytes = new TextEncoder().encode("schema_version = 1\n");
    const first = await putR2Metadata(client, "bucket", "show.toml", bytes);
    expect(conditional).toBe("*");
    expect(first.size).toBe(bytes.length);
    expect(await putR2Metadata(client, "bucket", "show.toml", bytes)).toEqual(first);
    await expect(putR2Metadata(client, "bucket", "show.toml", new TextEncoder().encode("changed"))).rejects.toThrow("different identity or digest");
    expect(new TextDecoder().decode(stored)).toBe("schema_version = 1\n");
  } finally { client.destroy(); server.stop(true); }
});

test("audio upload streams a conditional checksum-bound object and rejects changed bodies or existing keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-audio-put-"));
  const path = join(root, "audio.mp3");
  const bytes = Buffer.from("audio fixture");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let stored: Buffer | undefined;
  let digest = "";
  let bodyRequests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "PUT") {
      bodyRequests++;
      if (stored) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412, headers: { "content-type": "application/xml" } });
      if (request.headers.get("if-none-match") !== "*") return new Response(null, { status: 400 });
      const body = Buffer.from(await request.arrayBuffer());
      if (createHash("sha256").update(body).digest("base64") !== request.headers.get("x-amz-checksum-sha256")) return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400, headers: { "content-type": "application/xml" } });
      stored = body; digest = request.headers.get("x-amz-meta-sha256") ?? "";
      return new Response(null, { headers: { etag: '"audio-etag"' } });
    }
    return stored ? new Response(null, { headers: { etag: '"audio-etag"', "content-length": String(stored.length), "x-amz-meta-sha256": digest } }) : new Response(null, { status: 404 });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  try {
    await writeFile(path, Buffer.alloc(bytes.length, 1));
    await expect(putR2Audio(client, "bucket", "audio.mp3", path, { size: bytes.length, sha256 })).rejects.toThrow();
    expect(stored).toBeUndefined();
    await writeFile(path, bytes);
    expect(await putR2Audio(client, "bucket", "audio.mp3", path, { size: bytes.length, sha256 })).toMatchObject({ key: "audio.mp3", etag: '"audio-etag"', sha256 });
    await expect(putR2Audio(client, "bucket", "audio.mp3", path, { size: bytes.length, sha256 })).rejects.toThrow();
    expect(stored).toEqual(bytes);
    expect(bodyRequests).toBe(3);
  } finally { client.destroy(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test("50 MiB audio uses multipart staging and conditional copy, rejects changed content and never overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-multipart-"));
  const path = join(root, "audio.mp3"), bytes = Buffer.alloc(50 * 1024 * 1024 + 11, 42);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const key = "s-01234567/e-01234567/_versions/12345678-1234-4234-8234-123456789abc/audio.mp3";
  const objects = new Map<string, { size: number; sha256: string }>();
  const uploads = new Map<string, { sha256: string; sizes: number[] }>();
  let copyAttempts = 0, parts = 0, maxConcurrent = 0, concurrent = 0, aborts = 0, rejectPart = false, loseCopyResponse = false, interruptPart = false, signalled = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), objectKey = decodeURIComponent(url.pathname.slice("/bucket/".length));
    const params = url.searchParams;
    if (request.method === "POST" && params.has("uploads")) {
      uploads.set(objectKey, { sha256: request.headers.get("x-amz-meta-sha256") ?? "", sizes: [] });
      return new Response('<InitiateMultipartUploadResult><UploadId>upload-id</UploadId></InitiateMultipartUploadResult>', { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "PUT" && params.has("partNumber")) {
      if (rejectPart) return new Response('<Error><Code>InvalidRequest</Code></Error>', { status: 400, headers: { "content-type": "application/xml" } });
      if (interruptPart && !signalled) { signalled = true; process.emit("SIGINT"); }
      concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
      const size = (await request.arrayBuffer()).byteLength;
      uploads.get(objectKey)!.sizes[Number(params.get("partNumber")) - 1] = size;
      parts++; concurrent--;
      return new Response(null, { headers: { etag: `"part-${params.get("partNumber")}"` } });
    }
    if (request.method === "POST" && params.has("uploadId")) {
      const upload = uploads.get(objectKey)!;
      objects.set(objectKey, { size: upload.sizes.reduce((a, b) => a + b, 0), sha256: upload.sha256 });
      return new Response('<CompleteMultipartUploadResult><ETag>"stage"</ETag></CompleteMultipartUploadResult>', { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) {
      copyAttempts++;
      expect(request.headers.get("cf-copy-destination-if-none-match")).toBe("*");
      expect(request.headers.get("x-amz-copy-source-if-match")).toBe('"stage"');
      expect(request.headers.get("authorization")).toContain("cf-copy-destination-if-none-match");
      if (objects.has(objectKey)) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412, headers: { "content-type": "application/xml" } });
      const source = decodeURIComponent(request.headers.get("x-amz-copy-source")!.slice("/bucket/".length));
      objects.set(objectKey, objects.get(source)!);
      if (loseCopyResponse) return new Response('<Error><Code>InternalError</Code></Error>', { status: 503, headers: { "content-type": "application/xml" } });
      return new Response('<CopyObjectResult><ETag>"stage"</ETag></CopyObjectResult>', { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "HEAD") {
      const object = objects.get(objectKey);
      return object ? new Response(null, { headers: { etag: '"stage"', "content-length": String(object.size), "x-amz-meta-sha256": object.sha256 } }) : new Response(null, { status: 404 });
    }
    if (request.method === "DELETE") { if (params.has("uploadId")) aborts++; objects.delete(objectKey); return new Response(null, { status: 204 }); }
    return new Response(null, { status: 500 });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  try {
    await writeFile(path, Buffer.alloc(bytes.length, 1));
    await expect(putR2Audio(client, "bucket", key, path, { size: bytes.length, sha256 })).rejects.toThrow("changed after inspection");
    expect(copyAttempts).toBe(0);
    await writeFile(path, bytes);
    expect(await putR2Audio(client, "bucket", key, path, { size: bytes.length, sha256 })).toMatchObject({ key, size: bytes.length, sha256 });
    expect(objects.get(key)).toEqual({ size: bytes.length, sha256 });
    expect(parts).toBe(8);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    await expect(putR2Audio(client, "bucket", key, path, { size: bytes.length, sha256 })).rejects.toThrow();
    expect(objects.get(key)).toEqual({ size: bytes.length, sha256 });
    const retainedAfterConflict = [...objects.keys()].filter(objectKey => objectKey !== key);
    expect(retainedAfterConflict).toHaveLength(1);
    expect(objects.get(retainedAfterConflict[0]!)).toEqual({ size: bytes.length, sha256 });
    loseCopyResponse = true;
    const uncertainKey = key.replace("12345678-", "32345678-");
    await expect(putR2Audio(client, "bucket", uncertainKey, path, { size: bytes.length, sha256 })).rejects.toThrow();
    expect(objects.get(uncertainKey)).toEqual({ size: bytes.length, sha256 });
    expect([...objects.keys()].filter(objectKey => objectKey !== key && objectKey !== uncertainKey)).toHaveLength(2);
    loseCopyResponse = false;
    rejectPart = true;
    const otherKey = key.replace("12345678-", "22345678-");
    await expect(putR2Audio(client, "bucket", otherKey, path, { size: bytes.length, sha256 })).rejects.toThrow();
    expect(aborts).toBe(1);
    expect(objects.has(otherKey)).toBe(false);
    rejectPart = false; interruptPart = true;
    const signalCount = process.listenerCount("SIGINT"), attemptsBeforeInterrupt = copyAttempts;
    const interruptedKey = key.replace("12345678-", "42345678-");
    await expect(putR2Audio(client, "bucket", interruptedKey, path, { size: bytes.length, sha256 })).rejects.toThrow("incomplete multipart parts are handled by the R2 lifecycle policy");
    expect(signalled).toBe(true);
    expect(process.listenerCount("SIGINT")).toBe(signalCount);
    expect(copyAttempts).toBe(attemptsBeforeInterrupt);
    expect(objects.has(interruptedKey)).toBe(false);
  } finally { client.destroy(); server.stop(true); await rm(root, { recursive: true, force: true }); }
});

test.skipIf(process.platform === "win32")("OS SIGINT and SIGTERM interrupt multipart uploads before promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-os-signal-")), path = join(root, "audio.mp3");
  const bytes = Buffer.alloc(17 * 1024 * 1024, 3), sha256 = createHash("sha256").update(bytes).digest("hex");
  let signal: (() => void) | undefined, signalled = false, copies = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.searchParams.has("uploads")) return new Response('<InitiateMultipartUploadResult><UploadId>signal-upload</UploadId></InitiateMultipartUploadResult>', { headers: { "content-type": "application/xml" } });
    if (request.method === "PUT" && url.searchParams.has("partNumber")) {
      if (!signalled) { signalled = true; signal?.(); }
      return new Response(null, { headers: { etag: '"part"' } });
    }
    if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) copies++;
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    return new Response(null, { status: 500 });
  } });
  try {
    await writeFile(path, bytes);
    const moduleUrl = pathToFileURL(resolve(import.meta.dir, "../src/r2.ts")).href;
    const script = `import { createR2Client, putR2Audio } from ${JSON.stringify(moduleUrl)};
      const client = createR2Client({ accountId: ${JSON.stringify("a".repeat(32))}, bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: ${JSON.stringify(server.url.origin)} });
      try { await putR2Audio(client, "bucket", "s-01234567/e-01234567/_versions/12345678-1234-4234-8234-123456789abc/audio.mp3", ${JSON.stringify(path)}, { size: ${bytes.length}, sha256: ${JSON.stringify(sha256)} }); }
      catch (error) { console.error(error.message); process.exitCode = 1; } finally { client.destroy(); }`;
    for (const signalName of ["SIGINT", "SIGTERM"] as const) {
      signalled = false;
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      signal = () => { child.kill(signalName); };
      const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(signalled).toBe(true);
      expect(code).toBe(1);
      expect(error).toContain("Audio upload interrupted; incomplete multipart parts are handled by the R2 lifecycle policy");
      expect(copies).toBe(0);
    }
  } finally { server.stop(true); await rm(root, { recursive: true, force: true }); }
}, 20_000);

test("cleanup refuses deletion if a claimed object's current identity differs", async () => {
  let deleted = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    if (request.method === "DELETE") { deleted = true; return new Response(null, { status: 204 }); }
    return new Response(null, { headers: { etag: '"different"', "content-length": "5", "x-amz-meta-sha256": "a".repeat(64) } });
  } });
  const client = createR2Client({ accountId: "a".repeat(32), bucket: "bucket", accessKeyId: "test", secretAccessKey: "test", endpoint: server.url.origin });
  try {
    await expect(deleteClaimedR2Object(client, "bucket", { key: "key", etag: '"old"', size: 5, sha256: "a".repeat(64) })).rejects.toThrow("identity changed");
    expect(deleted).toBe(false);
  } finally { client.destroy(); server.stop(true); }
});
