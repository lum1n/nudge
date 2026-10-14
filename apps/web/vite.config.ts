import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

// `pnpm dev` talks to a `nudge serve` on 8787: everything is under /v1.
const server = process.env.NUDGE_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  // Workspace packages straight from their sources, as in the tests.
  resolve: { conditions: ["@nudge/source", ...defaultClientConditions] },
  server: {
    proxy: { "/v1": { target: server, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
