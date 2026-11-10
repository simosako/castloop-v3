import { configuredHttpsOrigin } from "@castloop/domain";

const pathPattern = /^\/s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/(?:e-[0-9abcdefghjkmnpqrstvwxyz]{8}\/audio\.mp3|covers\/[A-Za-z0-9_-]+\.(?:jpg|png)|feed\.xml)?$/;
const audioPath = /^\/s-[0-9abcdefghjkmnpqrstvwxyz]{8}\/e-[0-9abcdefghjkmnpqrstvwxyz]{8}\/audio\.mp3$/;

/** A restored active show may use only origins configured in this installation. */
export function configuredRestoreOrigins(current: string, pending: string | null, workersOrigin: string, customOrigin: string): boolean {
  const allowed = new Set([configuredHttpsOrigin(workersOrigin), configuredHttpsOrigin(customOrigin)]);
  return [current, ...(pending ? [pending] : [])].every(base => {
    try {
      const url = new URL(base);
      return url.protocol === "https:" && url.origin === base && allowed.has(base);
    } catch { return false; }
  });
}

/** Confirm that a configured custom domain serves an existing audio object via its cache. */
export async function probeCustomDelivery(base: string, configuredBase: string, path: string,
  transport: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): Promise<void> {
  let origin: URL;
  try { origin = new URL(base); } catch { throw new Error("Invalid custom delivery origin"); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash ||
      origin.origin !== configuredHttpsOrigin(configuredBase) || !audioPath.test(path)) throw new Error("Invalid custom-domain probe");
  const url = `${origin.origin}${path}`;
  const head = await transport(url, { method: "HEAD", redirect: "manual" });
  const size = Number(head.headers.get("content-length"));
  if (!head.ok || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error("Custom-domain HEAD verification failed");
  }
  const range = await transport(url, { method: "GET", headers: { Range: "bytes=0-0" }, redirect: "manual" });
  const cache = range.headers.get("cf-cache-status")?.toUpperCase();
  if (range.status !== 206 || range.headers.get("content-range") !== `bytes 0-0/${size}` || !range.body || !cache || !["HIT", "MISS", "EXPIRED", "REVALIDATED", "UPDATING"].includes(cache)) {
    await range.body?.cancel();
    throw new Error("Custom-domain audio range verification failed");
  }
  const reader = range.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1) throw new Error("Custom-domain audio range verification failed");
    }
    if (bytes !== 1) throw new Error("Custom-domain audio range verification failed");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Purge only configured custom-domain paths; errors are surfaced for manual recovery. */
export async function purgeZonePaths(config: { base: string; configuredBase: string; zoneId: string; token: string }, paths: string[],
  transport: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init)): Promise<void> {
  let base: URL;
  try { base = new URL(config.base); } catch { throw new Error("Invalid custom delivery origin"); }
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/" || base.search || base.hash ||
      base.origin !== configuredHttpsOrigin(config.configuredBase) || !/^[a-f0-9]{32}$/.test(config.zoneId) || !config.token || !paths.length ||
      paths.some(path => !pathPattern.test(path))) throw new Error("Custom-domain purge configuration or path is invalid");
  const prefixes = [...new Set(paths)].map(path => `${base.host}${path}`);
  for (let start = 0; start < prefixes.length; start += 100) {
    const response = await transport(`https://api.cloudflare.com/client/v4/zones/${config.zoneId}/purge_cache`, {
      method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prefixes: prefixes.slice(start, start + 100) }), redirect: "manual",
    });
    if (!response.ok) throw new Error(`Custom-domain purge failed (HTTP ${response.status})`);
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error("Invalid custom-domain purge response"); }
    if (!body || typeof body !== "object" || (body as { success?: unknown }).success !== true ||
      !Array.isArray((body as { errors?: unknown }).errors) || (body as { errors: unknown[] }).errors.length) throw new Error("Custom-domain purge was not accepted");
  }
}
