import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./packages/delivery/wrangler.jsonc" }, miniflare: {
    bindings: { CUSTOM_DELIVERY_BASE: "https://podcasts.example.com/" },
    workers: [{ name: "castloop-management", compatibilityDate: "2026-11-04", modules: true,
      script: 'import { WorkerEntrypoint } from "cloudflare:workers"; export class Routing extends WorkerEntrypoint { async route(id) { if (id === "s-12345678") return { state: "redirect", base: "https://podcasts.example.com" }; if (id === "s-23456789") return { state: "missing" }; if (id === "s-3456789a") throw new Error("unavailable"); if (id === "s-456789ab") return { state: "redirect", base: "https://attacker.example" }; return { state: "serve" }; } }' }],
  } })],
  test: { include: ["packages/delivery/test/**/*.test.ts"] },
});
