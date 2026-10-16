import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Built into dist/ and served by viewer/server.py (SCOOTER_FILES_STATIC). The base is
// relative because the page lives under a per-conversation proxy prefix; index.html's
// asset links are rewritten to {{BASE}}/static/ (the server maps that onto dist/).
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  build: { assetsDir: "", chunkSizeWarningLimit: 4000 },
  server: { proxy: { "/api": "http://127.0.0.1:7804" } },
});
