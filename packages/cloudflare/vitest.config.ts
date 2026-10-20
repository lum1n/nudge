import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/wrangler.jsonc" } })],
  resolve: {
    conditions: ["@nudge/source"],
    alias: { undici: fileURLToPath(new URL("test/stubs/undici.ts", import.meta.url)) },
  },
  ssr: { resolve: { conditions: ["@nudge/source"] } },
  test: { include: ["test/**/*.test.ts"] },
});
