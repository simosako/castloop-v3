// Test-only S3 subset. Wrangler's local R2 has no S3 endpoint; requests here
// operate on the same local binding used by the unmodified management Worker.
import management, { Notifier, Routing, ShowDO as RealShowDO } from "../../src/index.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
export { Notifier, Routing };
export class LocalCopier extends WorkerEntrypoint {
  async copy(items) {
    if (!items.length || items.length > 4) throw new Error("Invalid copy group");
    for (const item of items) {
      const source = await this.env.MANAGEMENT_BUCKET.get(item.source.key);
      if (!source || source.httpEtag !== item.source.etag) throw new Error("Source changed");
      await this.env.DELIVERY_BUCKET.put(item.path, source.body, { httpMetadata: { contentType: item.mime, cacheControl: "public, max-age=0, s-maxage=2592000, must-revalidate" } });
    }
  }
}
let loseCompletionResponse = false;
let loseClaimResponse = false;
let loseOperationResponse = false;
let fixtureDeleteCount = 0;

// R2 CopyObject has no local S3 endpoint. Replace only this outbound request,
// preserving the application's signing, conditional ETag, and copy response path.
export class ShowDO extends RealShowDO {
  constructor(ctx, env) {
    super(ctx, env);
    globalThis.fetch = async input => {
      const request = input instanceof Request ? input : new Request(input);
      const url = new URL(request.url);
      if (url.hostname !== "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.r2.cloudflarestorage.com" || request.method !== "PUT") throw new Error("Unexpected outbound request in local integration fixture");
      const source = request.headers.get("x-amz-copy-source");
      if (!source?.startsWith("/test-bucket/") || !url.pathname.startsWith("/test-delivery/")) return new Response(null, { status: 400 });
      const object = await env.MANAGEMENT_BUCKET.get(decodeURIComponent(source.slice("/test-bucket/".length)));
      if (!object || object.httpEtag !== request.headers.get("x-amz-copy-source-if-match")) return new Response(null, { status: 412 });
      const target = decodeURIComponent(url.pathname.slice("/test-delivery/".length));
      const stored = await env.DELIVERY_BUCKET.put(target, object.body, { httpMetadata: { contentType: request.headers.get("content-type"), cacheControl: request.headers.get("cache-control") } });
      return new Response(`<CopyObjectResult><ETag>${stored.httpEtag}</ETag></CopyObjectResult>`, { headers: { "content-type": "application/xml" } });
    };
  }

  // Advance fixture ledger ages without sleeping for a day. Real object bodies,
  // identities, references, and all cleanup eligibility checks remain intact.
  ageFixtureAssets() {
    const sql = this.ctx.storage.sql;
    const records = sql.exec("SELECT object_key, record_json FROM source_assets").toArray();
    this.ctx.storage.transactionSync(() => {
      for (const row of records) {
        const asset = JSON.parse(row.record_json);
        asset.stored_at = Date.now() - 3 * 86400000;
        sql.exec("UPDATE source_assets SET record_json = ? WHERE object_key = ?", JSON.stringify(asset), row.object_key);
      }
    });
    return records.length;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__local-fixture/lose-completion" && request.method === "POST") {
      loseCompletionResponse = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__local-fixture/lose-claim" && request.method === "POST") {
      loseClaimResponse = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__local-fixture/lose-operation" && request.method === "POST") {
      loseOperationResponse = true;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__local-fixture/delete-count" && request.method === "GET") return Response.json({ count: fixtureDeleteCount });
    const age = /^\/__local-fixture\/age\/(s-[0-9abcdefghjkmnpqrstvwxyz]{8})$/.exec(url.pathname);
    if (age && request.method === "POST") return Response.json({ count: await env.SHOWS.getByName(age[1]).ageFixtureAssets() });
    if (url.pathname.startsWith("/public/")) {
      url.pathname = url.pathname.slice("/public".length);
      return env.DELIVERY_SERVICE.fetch(new Request(url, request));
    }
    if (!url.pathname.startsWith("/test-bucket/")) {
      const response = await management.fetch(request, env, ctx);
      if (loseOperationResponse && request.method === "POST" && /^\/v1\/shows\/s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/operations$/.test(url.pathname) && response.ok) {
        loseOperationResponse = false;
        return new Response("simulated lost accepted operation response", { status: 503 });
      }
      if (loseClaimResponse && request.method === "POST" && /^\/v1\/shows\/s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/cleanup\/claim$/.test(url.pathname) && response.ok) {
        loseClaimResponse = false;
        return new Response("simulated lost cleanup claim response", { status: 503 });
      }
      if (loseCompletionResponse && request.method === "POST" && /^\/v1\/shows\/s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/cleanup\/complete$/.test(url.pathname) && response.ok) {
        loseCompletionResponse = false;
        return new Response("simulated lost cleanup completion response", { status: 503 });
      }
      return response;
    }
    const key = decodeURIComponent(url.pathname.slice("/test-bucket/".length));
    if (!key && request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const page = await env.MANAGEMENT_BUCKET.list({ prefix: url.searchParams.get("prefix") ?? "", delimiter: url.searchParams.get("delimiter") ?? undefined, cursor: url.searchParams.get("continuation-token") ?? undefined });
      const xml = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
      const objects = page.objects.map(item => `<Contents><Key>${xml(item.key)}</Key><Size>${item.size}</Size><ETag>${xml(item.httpEtag)}</ETag></Contents>`).join("");
      const prefixes = (page.delimitedPrefixes ?? []).map(item => `<CommonPrefixes><Prefix>${xml(item)}</Prefix></CommonPrefixes>`).join("");
      return new Response(`<ListBucketResult><IsTruncated>${page.truncated}</IsTruncated>${page.truncated ? `<NextContinuationToken>${xml(page.cursor)}</NextContinuationToken>` : ""}${objects}${prefixes}</ListBucketResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (!key) return new Response("Unsupported test request", { status: 400 });
    // Minimal local-only S3 multipart adapter backed by the same emulated R2
    // bucket as the management Worker. This bridge must never be deployed.
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const upload = await env.MANAGEMENT_BUCKET.createMultipartUpload(key, { customMetadata: { sha256: request.headers.get("x-amz-meta-sha256") ?? "" }, httpMetadata: { contentType: request.headers.get("content-type") ?? "application/octet-stream" } });
      return new Response(`<InitiateMultipartUploadResult><UploadId>${upload.uploadId}</UploadId></InitiateMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (url.searchParams.has("uploadId")) {
      const upload = env.MANAGEMENT_BUCKET.resumeMultipartUpload(key, url.searchParams.get("uploadId"));
      if (request.method === "PUT" && url.searchParams.has("partNumber")) {
        const part = await upload.uploadPart(Number(url.searchParams.get("partNumber")), request.body);
        return new Response(null, { headers: { etag: part.etag } });
      }
      if (request.method === "POST") {
        const body = await request.text();
        const parts = [...body.matchAll(/<Part>([\s\S]*?)<\/Part>/g)].map(match => ({
          partNumber: Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(match[1])?.[1]),
          etag: /<ETag>([^<]+)<\/ETag>/.exec(match[1])?.[1]?.replaceAll("&quot;", '"'),
        }));
        if (!parts.length || parts.some(part => !part.partNumber || !part.etag)) return new Response("Invalid test multipart completion", { status: 400 });
        const object = await upload.complete(parts);
        return new Response(`<CompleteMultipartUploadResult><ETag>${object.httpEtag}</ETag></CompleteMultipartUploadResult>`, { headers: { "content-type": "application/xml" } });
      }
      if (request.method === "DELETE") { await upload.abort(); return new Response(null, { status: 204 }); }
    }
    if (request.method === "PUT" && request.headers.has("x-amz-copy-source")) {
      const sourcePath = request.headers.get("x-amz-copy-source");
      if (!sourcePath.startsWith("/test-bucket/") || request.headers.get("cf-copy-destination-if-none-match") !== "*") return new Response(null, { status: 400 });
      const source = await env.MANAGEMENT_BUCKET.get(decodeURIComponent(sourcePath.slice("/test-bucket/".length)));
      if (!source || source.httpEtag !== request.headers.get("x-amz-copy-source-if-match")) return new Response(null, { status: 412 });
      const object = await env.MANAGEMENT_BUCKET.put(key, source.body, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: source.customMetadata, httpMetadata: source.httpMetadata });
      if (!object) return new Response(null, { status: 412 });
      return new Response(`<CopyObjectResult><ETag>${object.httpEtag}</ETag></CopyObjectResult>`, { headers: { "content-type": "application/xml" } });
    }
    if (request.method === "PUT") {
      const metadata = { sha256: request.headers.get("x-amz-meta-sha256") ?? "" };
      const object = await env.MANAGEMENT_BUCKET.put(key, request.body, { onlyIf: { etagDoesNotMatch: "*" }, customMetadata: metadata });
      if (!object) return new Response(null, { status: 412 });
      return new Response(null, { headers: { ETag: object.httpEtag } });
    }
    if (request.method === "HEAD" || request.method === "GET") {
      const object = request.method === "HEAD" ? await env.MANAGEMENT_BUCKET.head(key) : await env.MANAGEMENT_BUCKET.get(key);
      if (!object) return new Response(null, { status: 404 });
      if (request.headers.has("if-match") && request.headers.get("if-match") !== object.httpEtag) return new Response(null, { status: 412 });
      const headers = { etag: object.httpEtag, "content-length": String(object.size), "x-amz-meta-sha256": object.customMetadata?.sha256 ?? "" };
      return new Response(request.method === "GET" ? object.body : null, { headers });
    }
    if (request.method === "DELETE") { fixtureDeleteCount++; await env.MANAGEMENT_BUCKET.delete(key); return new Response(null, { status: 204 }); }
    return new Response("Unsupported test request", { status: 405 });
  },
};
