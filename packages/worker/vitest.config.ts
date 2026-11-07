import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./packages/worker/wrangler.jsonc" } })],
  test: { include: ["packages/worker/test/**/*.test.ts"] },
});
