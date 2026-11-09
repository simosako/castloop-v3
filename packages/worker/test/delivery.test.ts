import { expect, test } from "vitest";
import { configuredRestoreOrigins, probeCustomDelivery, purgeZonePaths } from "../src/delivery";

test("restored active shows only resume with configured HTTPS delivery origins", () => {
  const workers = "https://delivery.example.test", custom = "https://podcasts.example.test";
  expect(configuredRestoreOrigins(workers, null, workers, custom)).toBe(true);
  expect(configuredRestoreOrigins(workers, custom, workers, custom)).toBe(true);
  expect(configuredRestoreOrigins(workers, custom, `${workers}/`, `${custom}/`)).toBe(true);
  expect(configuredRestoreOrigins(workers, null, `${workers}/path`, custom)).toBe(false);
  expect(configuredRestoreOrigins(custom, null, workers, "")).toBe(false);
  expect(configuredRestoreOrigins(workers, "https://other.example.test", workers, custom)).toBe(false);
  expect(configuredRestoreOrigins("http://delivery.example.test", null, "http://delivery.example.test", custom)).toBe(false);
  expect(configuredRestoreOrigins(`${workers}/path`, null, workers, custom)).toBe(false);
});

const config = { base: "https://podcasts.example.com", configuredBase: "https://podcasts.example.com", zoneId: "a".repeat(32), token: "private-token" };
const feed = "/s-01234567/feed.xml";

test("zone purge sends only allowed prefixes in batches without query strings", async () => {
  const calls: { url: string; headers: Headers; prefixes: string[] }[] = [];
  const transport = async (input: string, init: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), prefixes: (JSON.parse(String(init?.body)) as { prefixes: string[] }).prefixes });
    return Response.json({ success: true, errors: [] });
  };
  const paths = [feed, ...Array.from({ length: 100 }, (_, i) => `/s-01234567/covers/${i}.jpg`)];
  await purgeZonePaths(config, paths, transport);
  expect(calls.map(call => call.prefixes.length)).toEqual([100, 1]);
  expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`);
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer private-token");
  expect(calls[0]!.prefixes[0]).toBe("podcasts.example.com/s-01234567/feed.xml");
});

test("zone purge refuses unexpected origins and paths, and reports rejected responses without leaking tokens", async () => {
  let calls = 0;
  const transport = async () => { calls++; return Response.json({ success: false, errors: [{ message: "sensitive" }] }); };
  for (const [changed, path] of [[{ ...config, base: "https://attacker.example" }, feed], [config, `${feed}?key=x`], [config, "/s-01234567/_versions/private"]] as const) {
    await expect(purgeZonePaths(changed, [path], transport)).rejects.toThrow("invalid");
  }
  expect(calls).toBe(0);
  await expect(purgeZonePaths(config, [feed], transport)).rejects.toThrow("not accepted");
  expect(calls).toBe(1);
});

test("custom-domain preflight requires an existing cached audio object with a working range", async () => {
  const path = "/s-01234567/e-01234567/audio.mp3";
  let calls = 0;
  const transport = async (_url: string, init: RequestInit) => {
    calls++;
    if (init.method === "HEAD") return new Response(null, { headers: { "content-length": "10", "cf-cache-status": "HIT" } });
    expect(new Headers(init.headers).get("range")).toBe("bytes=0-0");
    return new Response("a", { status: 206, headers: { "content-range": "bytes 0-0/10" } });
  };
  await probeCustomDelivery(config.base, config.configuredBase, path, transport);
  expect(calls).toBe(2);
  await probeCustomDelivery(config.base, `${config.configuredBase}/`, path, transport);
  expect(calls).toBe(4);
  await expect(probeCustomDelivery("https://untrusted.example", config.configuredBase, path, transport)).rejects.toThrow("Invalid");
  await expect(probeCustomDelivery(config.base, config.configuredBase, path, async () => new Response(null, { headers: { "content-length": "10", "cf-cache-status": "BYPASS" } }))).rejects.toThrow("cache verification");
  expect(calls).toBe(4);
  for (const body of [null, "ab"]) {
    await expect(probeCustomDelivery(config.base, config.configuredBase, path, async (_url, init) => init.method === "HEAD"
      ? new Response(null, { headers: { "content-length": "10", "cf-cache-status": "HIT" } })
      : new Response(body, { status: 206, headers: { "content-range": "bytes 0-0/10" } }))).rejects.toThrow("range verification");
  }
});
