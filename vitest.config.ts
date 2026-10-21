import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@nudge/source"] },
  ssr: { resolve: { conditions: ["@nudge/source"] } },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "extensions/*/test/**/*.test.ts",
      "apps/*/test/**/*.test.ts",
    ],
    // Runs on workerd, from its own config.
    exclude: ["packages/cloudflare/**", "**/node_modules/**"],
  },
});
