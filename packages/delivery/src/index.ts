import { WorkerEntrypoint } from "cloudflare:workers";
import { configuredHttpsOrigin } from "@castloop/domain/origin";
import { isAllowedPurgePrefix, publicShowId, serve } from "./serve";

export default class Delivery extends WorkerEntrypoint<DeliveryEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const showId = publicShowId(url.pathname);
    // Keep existing path/method validation and never ask routing about private paths.
    if (!showId || (request.method !== "GET" && request.method !== "HEAD")) return serve(request, this.env.DELIVERY_BUCKET);
    try {
      const route = await this.env.ROUTING.route(showId);
      if (route.state === "missing") return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
      if (route.state === "redirect") {
        if (!route.base) throw new Error("Missing redirect origin");
        const base = new URL(route.base);
        if (base.protocol !== "https:" || base.origin !== configuredHttpsOrigin(this.env.CUSTOM_DELIVERY_BASE) || base.username || base.password || base.pathname !== "/" || base.search || base.hash) throw new Error("Invalid redirect origin");
        return new Response(null, { status: 301, headers: { Location: `${base.origin}${url.pathname}${url.search}`, "Cache-Control": "no-store" } });
      }
      if (route.state !== "serve") throw new Error("Invalid routing response");
      return serve(request, this.env.DELIVERY_BUCKET);
    } catch {
      return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  }

  /** Called through a private service binding on this same entrypoint. */
  async purge(pathPrefixes: string[]): Promise<void> {
    if (!pathPrefixes.length || pathPrefixes.some(path => !isAllowedPurgePrefix(path))) throw new Error("Invalid delivery purge prefix");
    if (!this.ctx.cache) throw new Error("Workers Cache is unavailable on the delivery entrypoint");
    const result = await this.ctx.cache.purge({ pathPrefixes });
    if (!result.success || result.errors?.length) throw new Error(`Delivery cache purge failed: ${JSON.stringify(result.errors ?? [])}`);
  }
}
