import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev` talks to a `nudge serve` on 8787; the API and the room streams live under /a.
const server = process.env.NUDGE_SERVER ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  server: { proxy: { "/a": { target: server, ws: true } } },
  build: { outDir: "dist", emptyOutDir: true },
});
