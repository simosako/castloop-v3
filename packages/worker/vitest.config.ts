import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./packages/worker/wrangler.jsonc" }, miniflare: {
    bindings: { ADMIN_TOKEN: "local-test-token", DELIVERY_BASE: "https://delivery.example.test/", CUSTOM_DELIVERY_BASE: "https://podcasts.example.test/", CUSTOM_ZONE_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ZONE_PURGE_TOKEN: "local-zone-token", R2_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      R2_COPY_ACCESS_KEY_ID: "test-key", R2_COPY_SECRET_ACCESS_KEY: "test-secret" },
    workers: [{ name: "castloop-delivery", compatibilityDate: "2026-11-04", modules: true,
      script: 'import { WorkerEntrypoint } from "cloudflare:workers"; const failed = new Set(); let episodePurges = 0; export default class extends WorkerEntrypoint { async purge(paths) { if (!paths.length) throw new Error("missing paths"); if (paths.includes("/s-89abcdef/e-01234567/audio.mp3") && ++episodePurges === 3) throw new Error("injected episode purge failure"); if (["/s-3456789a/", "/s-456789ab/"].includes(paths[0]) && !failed.has(paths[0])) { failed.add(paths[0]); throw new Error("injected purge failure"); } } }' }],
  } })],
  test: { include: ["packages/worker/test/**/*.test.ts"] },
});
