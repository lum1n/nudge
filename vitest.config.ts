import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@nudge/source"] },
  ssr: { resolve: { conditions: ["@nudge/source"] } },
  test: {
    include: ["packages/*/test/**/*.test.ts", "extensions/*/test/**/*.test.ts"],
  },
});
