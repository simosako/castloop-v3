import { expect, test } from "bun:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSmokeArgs, probeRangeVariants, runSmoke, verifyDelivered } from "../../../scripts/deployed-smoke";

test("deployed smoke requires explicit disposable acknowledgement and all parameters", () => {
  const args = ["--workspace", ".", "--binary", "./dist/castloop", "--show", "s-01234567", "--episode", "e-01234567", "--audio", "./audio.mp3", "--origin", "https://delivery.example.test", "--guid", "urn:uuid:test", "--release-at", "2030-01-01T00:00:00Z"];
  expect(() => parseSmokeArgs(args)).toThrow("--disposable");
  expect(parseSmokeArgs(["--disposable", ...args])).toMatchObject({ show: "s-01234567", episode: "e-01234567" });
  expect(() => parseSmokeArgs(["--disposable", ...args, "--show", "s-01234567"])).toThrow("duplicate");
  const invalid = [...args]; invalid[invalid.indexOf("--origin") + 1] = "http://example.test";
  expect(() => parseSmokeArgs(["--disposable", ...invalid])).toThrow("HTTPS");
});

test("smoke drives a scheduled upload and verifies the complete delivered body", async () => {
  const root = await mkdtemp(join(tmpdir(), "castloop-smoke-"));
  const path = join(root, "audio.mp3"), size = 50 * 1024 * 1024;
  try {
    const file = await open(path, "w");
    try { await file.truncate(size); } finally { await file.close(); }
    let now = 1_000_000, uploads = 0;
    const releaseAt = now + 30_000;
    const input = { workspace: root, binary: "/unused", audio: path, show: "s-01234567", episode: "e-01234567", origin: "https://delivery.example.test", guid: "urn:uuid:test", releaseAt };
    const audio = `${input.origin}/${input.show}/${input.episode}/audio.mp3`;
    await runSmoke(input, {
      now: () => now, sleep: async ms => { now += ms; }, upload: async () => { uploads++; return 0; },
      transport: async (url, init = {}) => {
        if (url.endsWith("feed.xml")) return new Response(now >= releaseAt ? `<rss><channel><item><guid>${input.guid}</guid><enclosure url="${audio}"/></item></channel></rss>` : "<rss><channel/></rss>");
        if (now < releaseAt) return new Response(null, { status: 404 });
        if (init.method === "HEAD") return new Response(null, { headers: { "content-length": String(size) } });
        if (init.headers) {
          const range = new Headers(init.headers).get("range");
          if (range === `bytes=${size}-`) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
          if (range === "bytes=0-0,2-2") return new Response(null, { status: 200 });
          const contentRange = range === "bytes=1-" ? `bytes 1-${size - 1}/${size}` : range === "bytes=-1" ? `bytes ${size - 1}-${size - 1}/${size}` : `bytes 0-0/${size}`;
          return new Response(new Uint8Array(1), { status: 206, headers: { "content-range": contentRange } });
        }
        return new Response(new Uint8Array(size));
      },
    });
    expect(uploads).toBe(1);
    expect(now).toBe(releaseAt);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("range probes check HTTP validators and report multi-range behavior", async () => {
  const audio = "https://delivery.example.test/audio.mp3", size = 100;
  const transport = async (_url: string, init: RequestInit = {}) => {
    if (init.method === "HEAD") return new Response(null, { headers: { etag: '"valid"' } });
    const headers = new Headers(init.headers), range = headers.get("range");
    if (headers.get("if-range") === '"castloop-nonmatching-etag"') return new Response(null, { status: 200 });
    if (range === "bytes=100-") return new Response(null, { status: 416, headers: { "content-range": "bytes */100" } });
    if (range === "bytes=0-0,2-2") return new Response(null, { status: 200, headers: { "content-type": "audio/mpeg" } });
    const value = range === "bytes=1-" ? "bytes 1-99/100" : range === "bytes=-1" ? "bytes 99-99/100" : "bytes 0-0/100";
    return new Response("x", { status: 206, headers: { "content-range": value } });
  };
  expect(await probeRangeVariants(audio, size, transport)).toEqual({ multi_status: 200, multi_type: "audio/mpeg", if_range: "passed" });
  await expect(probeRangeVariants(audio, size, async () => new Response("wrong"))).rejects.toThrow("Range bytes=1-");
});

test("delivery smoke verifies HEAD, actual range bodies and the feed", async () => {
  const origin = "https://delivery.example.test", show = "s-01234567", episode = "e-01234567", guid = "urn:uuid:test";
  const audio = `${origin}/${show}/${episode}/audio.mp3`;
  const transport = async (url: string, init: RequestInit = {}) => {
    if (url.endsWith("feed.xml")) return new Response(`<rss><channel><item><guid isPermaLink="false">${guid}</guid><enclosure url="${audio}"/></item></channel></rss>`);
    if (init.method === "HEAD") return new Response(null, { headers: { "content-length": "100" } });
    return new Response("a", { status: 206, headers: { "content-range": "bytes 0-0/100", "cf-cache-status": "HIT" } });
  };
  expect(await verifyDelivered(origin, show, episode, guid, transport)).toEqual({ bytes: 100, cache: ["HIT", "HIT"] });
  await expect(verifyDelivered(origin, show, episode, guid, async (url, init) => url.endsWith("feed.xml") ? new Response("<rss/>") : transport(url, init))).rejects.toThrow("Feed does not contain");
  await expect(verifyDelivered(origin, show, episode, guid, async (url, init) => url.endsWith("feed.xml") ? new Response(`<rss><channel><item><guid>${guid}</guid></item><item><enclosure url="${audio}"/></item></channel></rss>`) : transport(url, init))).rejects.toThrow("one Episode");
  await expect(verifyDelivered(origin, show, episode, guid, async (url, init) => init?.method === "HEAD" ? transport(url, init) : new Response("wrong", { status: 200 }))).rejects.toThrow("byte range");
});
