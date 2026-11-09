/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { assertSourceOwnership, copyMediaObject, readMetadataSource, verifySourceRef } from "../src/objects";

const showId = "s-01234567";
const operationId = "12345678-1234-4234-8234-123456789abc";
const owner = { kind: "show_toml" as const, showId, operationId };

test("checks exact owner, operation, object identity and TOML digest", async () => {
  const key = `${showId}/_versions/${operationId}/show.toml`;
  const text = `schema_version = 1\nid = "${showId}"\npublish = false\n`;
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), b => b.toString(16).padStart(2, "0")).join("");
  const object = await env.MANAGEMENT_BUCKET.put(key, text);
  const ref = { key, etag: object!.httpEtag, size: new TextEncoder().encode(text).length, sha256: hash };
  expect((await verifySourceRef(env.MANAGEMENT_BUCKET, ref, owner)).key).toBe(key);
  expect(await readMetadataSource(env.MANAGEMENT_BUCKET, ref, owner)).toBe(text);
  await expect(readMetadataSource(env.MANAGEMENT_BUCKET, { ...ref, sha256: "0".repeat(64) }, owner)).rejects.toThrow("digest");
  await expect(readMetadataSource(env.MANAGEMENT_BUCKET, { ...ref, size: ref.size + 1 }, owner)).rejects.toThrow("identity");
  await expect(verifySourceRef(env.MANAGEMENT_BUCKET, { ...ref, etag: '"wrong"' }, owner)).rejects.toThrow("identity");
  expect(() => assertSourceOwnership(key, { ...owner, showId: "s-76543210" })).toThrow();
  expect(() => assertSourceOwnership(key.replace("show.toml", "../show.toml"), owner)).toThrow();
});

test("rejects metadata whose contents name another show", async () => {
  const key = `${showId}/_versions/${operationId}/show.toml`;
  const text = 'schema_version = 1\nid = "s-76543210"\n';
  const bytes = new TextEncoder().encode(text);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
  const object = await env.MANAGEMENT_BUCKET.put(key, bytes);
  await expect(readMetadataSource(env.MANAGEMENT_BUCKET, { key, etag: object!.httpEtag, size: bytes.length, sha256 }, owner)).rejects.toThrow("Show ID");
});

test("rejects a media reference whose stored digest differs or is missing", async () => {
  const episodeId = "e-01234567", key = `${showId}/${episodeId}/_versions/${operationId}/audio.mp3`;
  const audioOwner = { kind: "audio" as const, showId, episodeId, operationId };
  const sha256 = "a".repeat(64);
  const object = await env.MANAGEMENT_BUCKET.put(key, "audio", { customMetadata: { sha256 } });
  const ref = { key, etag: object!.httpEtag, size: object!.size, sha256 };
  expect((await verifySourceRef(env.MANAGEMENT_BUCKET, ref, audioOwner)).key).toBe(key);
  await expect(verifySourceRef(env.MANAGEMENT_BUCKET, { ...ref, sha256: "b".repeat(64) }, audioOwner)).rejects.toThrow("digest");
  const withoutDigest = await env.MANAGEMENT_BUCKET.put(key, "audio");
  await expect(verifySourceRef(env.MANAGEMENT_BUCKET, { ...ref, etag: withoutDigest!.httpEtag }, audioOwner)).rejects.toThrow("digest");
});

test("media promotion signs one conditional server-side copy and validates its XML result", async () => {
  const config = { accountId: "a".repeat(32), sourceBucket: "private-bucket", deliveryBucket: "public-bucket", accessKeyId: "test", secretAccessKey: "test" };
  const key = `${showId}/e-01234567/_versions/${operationId}/audio.mp3`;
  const ref = { key, etag: '"opaque-etag"', size: 10, sha256: "a".repeat(64) };
  let count = 0;
  const success = async (request: Request) => {
    count++;
    expect(request.method).toBe("PUT");
    expect(request.body).toBeNull();
    expect(request.headers.get("x-amz-copy-source")).toBe(`/private-bucket/${key}`);
    expect(request.headers.get("x-amz-copy-source-if-match")).toBe(ref.etag);
    expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256");
    expect(request.headers.get("cache-control")).toContain("s-maxage=2592000");
    return new Response('<?xml version="1.0"?><CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>');
  };
  await copyMediaObject(config, ref, `${showId}/e-01234567/audio.mp3`, "audio/mpeg", success);
  expect(count).toBe(1);
  const failure = async () => { count++; return new Response("<Error><Code>PreconditionFailed</Code></Error>"); };
  await expect(copyMediaObject(config, ref, `${showId}/e-01234567/audio.mp3`, "audio/mpeg", failure)).rejects.toThrow("successful object result");
  expect(count).toBe(2);
  await expect(copyMediaObject(config, ref, "s-76543210/e-01234567/audio.mp3", "audio/mpeg", success)).rejects.toThrow("owner");
  expect(count).toBe(2);
});
