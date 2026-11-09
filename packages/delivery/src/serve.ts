const id = "[0-9abcdefghjkmnpqrstvwxyz]{8}";
const showPath = `s-${id}`;
const episodePath = `e-${id}`;
const filePath = new RegExp(`^/(${showPath})/(?:feed\\.xml|${episodePath}/audio\\.mp3|covers/[A-Za-z0-9_-]+\\.(?:jpg|png))$`);
const purgePath = new RegExp(`^/${showPath}/(?:${episodePath}/audio\\.mp3|covers/[A-Za-z0-9_-]+\\.(?:jpg|png)|feed\\.xml)?$`);
const cacheControl = "public, max-age=0, s-maxage=2592000, must-revalidate";

export function isAllowedPurgePrefix(path: string): boolean {
  return purgePath.test(path);
}

export function publicShowId(path: string): string | null {
  return filePath.exec(path)?.[1] ?? null;
}

function errorResponse(status: number, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Cache-Control", "no-store");
  return new Response(null, { status, headers: result });
}

function responseHeaders(object: R2Object, key: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", key.endsWith(".xml") ? "application/rss+xml; charset=utf-8" : key.endsWith(".mp3") ? "audio/mpeg" : key.endsWith(".png") ? "image/png" : "image/jpeg");
  headers.set("Content-Length", String(object.size));
  headers.set("ETag", object.httpEtag);
  headers.set("Last-Modified", object.uploaded.toUTCString());
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControl);
  return headers;
}

function matchesIfNoneMatch(value: string | null, etag: string): boolean {
  if (value === null) return false;
  return value.split(",").some(candidate => {
    const tag = candidate.trim();
    return tag === "*" || tag.replace(/^W\//, "") === etag;
  });
}

function notModifiedSince(value: string | null, uploaded: Date): boolean {
  if (value === null) return false;
  const since = Date.parse(value);
  return Number.isFinite(since) && Math.floor(uploaded.getTime() / 1000) <= Math.floor(since / 1000);
}

/** Serve a full representation. The Workers Cache owns cached byte ranges. */
export async function serve(request: Request, bucket: R2Bucket): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(405, { Allow: "GET, HEAD" });
  const path = new URL(request.url).pathname;
  if (!filePath.test(path)) return errorResponse(404);
  const key = path.slice(1);
  if (request.method === "HEAD") {
    const object = await bucket.head(key);
    if (!object) return errorResponse(404);
    const headers = responseHeaders(object, key);
    const ifNoneMatch = request.headers.get("If-None-Match");
    if (matchesIfNoneMatch(ifNoneMatch, object.httpEtag) || (ifNoneMatch === null && notModifiedSince(request.headers.get("If-Modified-Since"), object.uploaded))) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    return new Response(null, { status: 200, headers });
  }
  const ifNoneMatch = request.headers.get("If-None-Match");
  const conditional = new Headers();
  if (ifNoneMatch !== null) conditional.set("If-None-Match", ifNoneMatch);
  else {
    const modified = request.headers.get("If-Modified-Since");
    if (modified !== null && Number.isFinite(Date.parse(modified))) conditional.set("If-Modified-Since", modified);
  }
  const object = await bucket.get(key, { onlyIf: conditional });
  if (!object) return errorResponse(404);
  const headers = responseHeaders(object, key);
  if (!("body" in object)) {
    headers.delete("Content-Length");
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
