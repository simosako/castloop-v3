import { stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { episodeIdPattern, inspectFeedEpisode, showIdPattern } from "../packages/domain/src/index";

export interface SmokeInput { workspace: string; binary: string; show: string; episode: string; audio: string; origin: string; guid: string; releaseAt: number }

/** The acknowledgement is deliberately required even for a configured workspace. */
export function parseSmokeArgs(args: string[]): SmokeInput {
  if (args[0] !== "--disposable") throw new Error("Refusing to run: pass --disposable for a disposable installation");
  const options = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid or duplicate option");
    options.set(key, value);
  }
  const names = ["--workspace", "--binary", "--show", "--episode", "--audio", "--origin", "--guid", "--release-at"];
  if (options.size !== names.length || names.some(name => !options.has(name))) throw new Error(`Required: --disposable ${names.map(name => `${name} <value>`).join(" ")}`);
  const show = options.get("--show")!, episode = options.get("--episode")!, origin = options.get("--origin")!, guid = options.get("--guid")!;
  const releaseAt = Date.parse(options.get("--release-at")!);
  let parsed: URL;
  try { parsed = new URL(origin); } catch { throw new Error("Invalid delivery origin"); }
  if (!showIdPattern.test(show) || !episodeIdPattern.test(episode) || parsed.protocol !== "https:" || parsed.origin !== origin || !guid || !Number.isFinite(releaseAt)) throw new Error("Invalid Show, Episode, HTTPS origin, GUID or release time");
  return { workspace: resolve(options.get("--workspace")!), binary: resolve(options.get("--binary")!), audio: resolve(options.get("--audio")!), show, episode, origin, guid, releaseAt };
}

async function request(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
}

export async function verifyDelivered(origin: string, show: string, episode: string, guid: string, transport = request): Promise<{ bytes: number; cache: string[] }> {
  const audio = `${origin}/${show}/${episode}/audio.mp3`, feed = `${origin}/${show}/feed.xml`;
  const head = await transport(audio, { method: "HEAD" });
  const bytes = Number(head.headers.get("content-length"));
  if (!head.ok || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Audio HEAD failed or returned an invalid size");
  const caches: string[] = [];
  for (let i = 0; i < 2; i++) {
    const range = await transport(audio, { headers: { Range: "bytes=0-0" } });
    if (range.status !== 206 || range.headers.get("content-range") !== `bytes 0-0/${bytes}` || (await range.arrayBuffer()).byteLength !== 1) throw new Error("Audio byte range failed");
    caches.push(range.headers.get("cf-cache-status") ?? "unreported");
  }
  const response = await transport(feed);
  if (!response.ok) throw new Error(`Feed request failed: HTTP ${response.status}`);
  const xml = await response.text();
  if (!inspectFeedEpisode(xml, guid, audio)) throw new Error("Feed does not contain the expected GUID and audio URL in one Episode");
  return { bytes, cache: caches };
}

/** Record multi-range behavior separately; validate single ranges and If-Range. */
export async function probeRangeVariants(audio: string, size: number, transport = request): Promise<{ multi_status: number; multi_type: string | null; if_range: string }> {
  if (!Number.isSafeInteger(size) || size < 3) throw new Error("Audio is too small for range probes");
  const check = async (headers: Record<string, string>, status: number, contentRange?: string) => {
    const response = await transport(audio, { headers });
    const actualRange = response.headers.get("content-range");
    await response.body?.cancel();
    if (response.status !== status || (contentRange !== undefined && actualRange !== contentRange)) throw new Error(`Range ${headers.Range} returned HTTP ${response.status} and ${actualRange ?? "no Content-Range"}`);
  };
  await check({ Range: "bytes=1-" }, 206, `bytes 1-${size - 1}/${size}`);
  await check({ Range: "bytes=-1" }, 206, `bytes ${size - 1}-${size - 1}/${size}`);
  await check({ Range: `bytes=${size}-` }, 416, `bytes */${size}`);
  const head = await transport(audio, { method: "HEAD" });
  const etag = head.headers.get("etag");
  let ifRange = "not checked: no strong ETag";
  if (head.ok && etag && !etag.startsWith("W/")) {
    await check({ Range: "bytes=0-0", "If-Range": etag }, 206, `bytes 0-0/${size}`);
    await check({ Range: "bytes=0-0", "If-Range": '"castloop-nonmatching-etag"' }, 200);
    ifRange = "passed";
  }
  const multi = await transport(audio, { headers: { Range: "bytes=0-0,2-2" } });
  const result = { multi_status: multi.status, multi_type: multi.headers.get("content-type"), if_range: ifRange };
  await multi.body?.cancel();
  return result;
}

export async function runSmoke(input: SmokeInput, dependencies: {
  now?: () => number; sleep?: (ms: number) => Promise<unknown>; transport?: typeof request; upload?: (input: SmokeInput) => Promise<number>
} = {}): Promise<void> {
  const nowTime = dependencies.now ?? Date.now, sleep = dependencies.sleep ?? Bun.sleep, transport = dependencies.transport ?? request;
  const now = nowTime();
  if (input.releaseAt < now + 30_000 || input.releaseAt > now + 30 * 60_000) throw new Error("Release must be 30 seconds to 30 minutes in the future");
  const size = (await stat(input.audio)).size;
  if (size < 50 * 1024 * 1024) throw new Error("Use a representative MP3 of at least 50 MiB");
  const sourceHash = createHash("sha256");
  for await (const chunk of createReadStream(input.audio)) sourceHash.update(chunk);
  const expectedHash = sourceHash.digest("hex");
  const audio = `${input.origin}/${input.show}/${input.episode}/audio.mp3`;
  const initial = await transport(audio, { method: "HEAD" });
  if (initial.status !== 404) throw new Error(`Disposable Episode must not already have public audio: HTTP ${initial.status}`);
  const started = performance.now();
  console.log(`Disposable smoke: ${input.show}/${input.episode}; upload ${size} bytes; release ${new Date(input.releaseAt).toISOString()}`);
  const upload = dependencies.upload ?? (async (item: SmokeInput) => Bun.spawn([item.binary, "episode", "upload-audio", item.show, item.episode, item.audio], { cwd: item.workspace, stdout: "inherit", stderr: "inherit" }).exited);
  if (await upload(input) !== 0) throw new Error("CLI upload or acceptance failed; inspect the disposable installation");
  const deadline = input.releaseAt + 3 * 60_000;
  if (nowTime() >= input.releaseAt) throw new Error("Upload finished after the release time; schedule a new disposable Episode to verify the pre-release state");
  const before = await transport(audio, { method: "HEAD" });
  if (before.status !== 404) throw new Error(`Scheduled audio unexpectedly accessible before release: HTTP ${before.status}`);
  const pendingFeed = await transport(`${input.origin}/${input.show}/feed.xml`);
  if (!pendingFeed.ok || inspectFeedEpisode(await pendingFeed.text(), input.guid)) throw new Error("Scheduled Episode is already in the feed or the feed is unavailable");
  let lastError = "not yet checked";
  while (nowTime() < deadline) {
    if (nowTime() >= input.releaseAt) {
      let result: Awaited<ReturnType<typeof verifyDelivered>> | undefined;
      try {
        result = await verifyDelivered(input.origin, input.show, input.episode, input.guid, transport);
      } catch (error) { lastError = error instanceof Error ? error.message : String(error); }
      if (result) {
        const observedAt = nowTime();
        if (result.bytes !== size) throw new Error(`Audio size mismatch: ${result.bytes} != ${size}`);
        const full = await transport(audio, { signal: AbortSignal.timeout(10 * 60_000) });
        if (!full.ok || !full.body) throw new Error(`Full audio request failed: HTTP ${full.status}`);
        const hash = createHash("sha256");
        for await (const chunk of full.body) hash.update(chunk);
        if (hash.digest("hex") !== expectedHash) throw new Error("Delivered audio checksum does not match the uploaded file");
        const ranges = await probeRangeVariants(audio, size, transport);
        console.log(JSON.stringify({ result: "passed", bytes: size, cache: result.cache, ranges, release_delay_ms: observedAt - input.releaseAt, elapsed_ms: Math.round(performance.now() - started), cpu_ms: "not measured", memory_bytes: "not measured", r2_operations: "not measured" }));
        return;
      }
    }
    await sleep(5_000);
  }
  throw new Error(`Scheduled delivery did not become ready before deadline: ${lastError}`);
}

if (import.meta.main) {
  try { await runSmoke(parseSmokeArgs(process.argv.slice(2))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
