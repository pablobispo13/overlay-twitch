import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Backend onde rodam Socket.IO, /api e /media (em dev).
const BACKEND = "http://localhost:3000";

export default defineConfig({
  root: "client",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // App multi-página: painel dos mods + overlay do OBS.
    rollupOptions: {
      input: {
        painel: path.resolve(__dirname, "client/painel.html"),
        overlay: path.resolve(__dirname, "client/overlay.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": BACKEND,
      "/media": BACKEND,
      "/socket.io": { target: BACKEND, ws: true },
    },
  },
});
