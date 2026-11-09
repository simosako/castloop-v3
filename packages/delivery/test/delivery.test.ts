/// <reference types="@cloudflare/vitest-plugin/types" />
import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, test } from "vitest";
import { isAllowedPurgePrefix } from "../src/serve";

const key = "s-01234567/e-01234567/audio.mp3";
const request = (path: string, options?: RequestInit) => SELF.fetch(`https://example.test${path}`, options);

test("streams published media with validators and supports HEAD and revalidation", async () => {
  await env.DELIVERY_BUCKET.put(key, "example audio");
  const get = await request(`/${key}`);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("audio/mpeg");
  expect(get.headers.get("content-length")).toBe("13");
  expect(get.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=2592000, must-revalidate");
  const etag = get.headers.get("etag");
  const modified = get.headers.get("last-modified")!;
  expect(etag).toBeTruthy();
  expect(new TextDecoder().decode(await get.arrayBuffer())).toBe("example audio");
  const head = await request(`/${key}`, { method: "HEAD" });
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("13");
  expect(await head.text()).toBe("");
  for (const method of ["GET", "HEAD"]) {
    for (const condition of [etag!, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const cached = await request(`/${key}`, { method, headers: { "If-None-Match": condition } });
      expect(cached.status).toBe(304);
      expect(await cached.text()).toBe("");
    }
    expect((await request(`/${key}`, { method, headers: { "If-Modified-Since": modified } })).status).toBe(304);
    expect((await request(`/${key}`, { method, headers: { "If-Modified-Since": "not a date" } })).status).toBe(200);
    expect((await request(`/${key}`, { method, headers: { "If-Modified-Since": "Thu, 01 Jan 1970 00:00:00 GMT" } })).status).toBe(200);
    expect((await request(`/${key}`, { method, headers: { "If-None-Match": '"different"', "If-Modified-Since": modified } })).status).toBe(200);
  }
});

test("rejects private or invalid paths and prevents caching error responses", async () => {
  for (const path of ["/s-01234567/_versions/a/show.toml", "/s-01234567/e-01234567/other.mp3", "/s-01234567/missing.xml"]) {
    const response = await request(path);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  const missing = await request("/s-01234567/feed.xml");
  expect(missing.status).toBe(404);
  expect(missing.headers.get("cache-control")).toBe("no-store");
  const badMethod = await request(`/${key}`, { method: "POST" });
  expect(badMethod.status).toBe(405);
  expect(badMethod.headers.get("allow")).toBe("GET, HEAD");
});

test("restricts internal cache purge to permitted show and media prefixes", () => {
  for (const path of ["/s-01234567/", "/s-01234567/feed.xml", `/${key}`, "/s-01234567/covers/42.jpg"]) expect(isAllowedPurgePrefix(path)).toBe(true);
  for (const path of ["/", "/s-01234567", "/s-01234567/_versions/", "https://example.test/s-01234567/", "/s-01234567/feed.xml?x=1"]) expect(isAllowedPurgePrefix(path)).toBe(false);
});

test("redirects only committed, configured show destinations and fails closed for missing or unavailable routing", async () => {
  const path = "/s-12345678/e-01234567/audio.mp3?source=app";
  const moved = await request(path, { redirect: "manual" });
  expect(moved.status).toBe(301);
  expect(moved.headers.get("location")).toBe(`https://podcasts.example.com${path}`);
  expect(moved.headers.get("cache-control")).toBe("no-store");
  for (const [showId, status] of [["s-23456789", 404], ["s-3456789a", 503], ["s-456789ab", 503]] as const) {
    const response = await request(`/${showId}/feed.xml`);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
