import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./packages/worker/wrangler.jsonc" }, miniflare: {
    bindings: { ADMIN_TOKEN: "local-test-token", DELIVERY_BASE: "https://delivery.example.test/", CUSTOM_DELIVERY_BASE: "https://podcasts.example.test/", CUSTOM_ZONE_ID: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ZONE_PURGE_TOKEN: "local-zone-token", R2_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      CASTLOOP_WORKER_R2_ACCESS_KEY_ID: "test-key", CASTLOOP_WORKER_R2_SECRET_ACCESS_KEY: "test-secret" },
    workers: [{ name: "castloop-copier", compatibilityDate: "2026-11-04", modules: true,
      script: 'import { WorkerEntrypoint } from "cloudflare:workers"; let paths = [], failure = ""; export default class extends WorkerEntrypoint { async copy(items) { if (!items.length || items.length > 4) throw new Error("invalid group"); for (const item of items) { paths.push("/" + item.path); if (failure && item.path.includes(failure)) throw new Error("injected copy failure"); } } async history() { return paths; } async setFailure(path) { failure = path; } async reset() { paths = []; failure = ""; } }' },
    { name: "castloop-delivery", compatibilityDate: "2026-11-04", modules: true,
      script: 'import { WorkerEntrypoint } from "cloudflare:workers"; const failed = new Set(); let episodePurges = 0; export default class extends WorkerEntrypoint { async purge(paths) { if (!paths.length) throw new Error("missing paths"); if (paths.includes("/s-89abcdef/e-01234567/audio.mp3") && ++episodePurges === 3) throw new Error("injected episode purge failure"); if (["/s-3456789a/", "/s-456789ab/"].includes(paths[0]) && !failed.has(paths[0])) { failed.add(paths[0]); throw new Error("injected purge failure"); } } }' }],
  } })],
  test: { include: ["packages/worker/test/**/*.test.ts"] },
});
