import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: { port: 5180, strictPort: true },
  build: {
    rollupOptions: { input: { index: "index.html", glide: "glide.html", univer: "univer.html" } },
    chunkSizeWarningLimit: 10_000,
  },
});
