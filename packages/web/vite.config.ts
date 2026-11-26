// In development, Vite serves the app on 5173 and passes /api, /auth and /healthz to a Sapwood server
// (SAPWOOD_SERVER, default http://127.0.0.1:8417), as if the app were served from there:
// the session cookie, and the WebSocket's Origin check, then work as in production.
import react from "@vitejs/plugin-react";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "vite";

// Glide loads its cell editor on the first key typed in a cell, from a chunk of its own. Keys
// typed before it arrives are lost, so the app loads it at start (main.tsx), by this name.
const glide = dirname(createRequire(import.meta.url).resolve("@glideapps/glide-data-grid"));
const overlayEditor = join(glide, "../esm/internal/data-grid-overlay-editor/data-grid-overlay-editor.js");

const target = process.env.SAPWOOD_SERVER ?? "http://127.0.0.1:8417";
const proxy = {
  target,
  changeOrigin: true,
  ws: true,
  // The server checks a WebSocket's Origin against itself.
  configure: (p: { on(e: "proxyReqWs", f: (req: { setHeader(k: string, v: string): void }) => void): void }) => p.on("proxyReqWs", (req) => req.setHeader("origin", new URL(target).origin)),
};

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "glide-overlay-editor": overlayEditor } },
  server: { port: 5173, strictPort: true, proxy: { "/api": proxy, "/auth": proxy, "/healthz": proxy } },
  build: {
    sourcemap: true,
    // Libraries and core in files of their own: an update to the app's own code downloads only
    // that part, and the rest stays cached (ROADMAP Phase 5, the web app's size).
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: "react", test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 3 },
            { name: "libs", test: /node_modules[\\/]/, priority: 2 },
            { name: "core", test: /packages[\\/]core[\\/]/, priority: 1 },
          ],
        },
      },
    },
  },
});
