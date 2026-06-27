import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Configuração (use variáveis de ambiente em produção) ---
const PORT = process.env.PORT || 3000;
const MOD_PASSWORD = process.env.MOD_PASSWORD || "troca-essa-senha";
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || "overlay-secreto";

const MEDIA_TYPES = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio",
};

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Memes ficam em /media
app.use("/media", express.static(path.join(__dirname, "media")));

// Frontend buildado (após `npm run build`). Em dev quem serve é o Vite (porta 5173).
const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir));
app.get("/", (_req, res) => res.redirect("/painel.html"));

app.get("/api/media", async (_req, res) => {
  try {
    const files = await readdir(path.join(__dirname, "media"));
    const items = files
      .map((name) => {
        const type = MEDIA_TYPES[path.extname(name).toLowerCase()];
        if (!type) return null;
        return { id: name, name, type, url: `/media/${encodeURIComponent(name)}` };
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(items);
  } catch (err) {
    console.error("Erro ao ler /media:", err);
    res.json([]);
  }
});

// --- Estado da cena (memes posicionados no palco) ---
// Mantido em memória para que um overlay recém-aberto receba a cena atual.
let scene = []; // [{ uid, mediaId, url, type, x, y, size }]

// --- Tempo real ---
io.use((socket, next) => {
  const { role, secret } = socket.handshake.auth || {};
  if (role === "mod" && secret === MOD_PASSWORD) { socket.data.role = "mod"; return next(); }
  if (role === "overlay" && secret === OVERLAY_TOKEN) { socket.data.role = "overlay"; return next(); }
  return next(new Error("auth_failed"));
});

io.on("connection", (socket) => {
  const isMod = socket.data.role === "mod";
  if (!isMod) socket.join("overlay");
  console.log(`${isMod ? "Mod" : "Overlay"} conectado:`, socket.id);

  // Quem entra recebe a cena atual.
  socket.emit("scene:init", scene);

  // Só mods alteram a cena.
  const guard = (fn) => (payload) => { if (isMod) fn(payload); };

  socket.on("scene:add", guard((item) => {
    if (!item?.uid) return;
    scene.push(item);
    io.emit("scene:add", item);
  }));

  socket.on("scene:update", guard(({ uid, ...patch } = {}) => {
    const it = scene.find((s) => s.uid === uid);
    if (!it) return;
    Object.assign(it, patch);
    io.emit("scene:update", { uid, ...patch });
  }));

  socket.on("scene:remove", guard((uid) => {
    scene = scene.filter((s) => s.uid !== uid);
    io.emit("scene:remove", uid);
  }));

  socket.on("scene:clear", guard(() => {
    scene = [];
    io.emit("scene:clear");
  }));

  // Sons são one-shot: tocam só no overlay (na live), não na tela do mod.
  socket.on("sfx:play", guard((payload) => {
    io.to("overlay").emit("sfx:play", payload);
  }));
});

httpServer.listen(PORT, () => {
  console.log(`\n  Overlay Live na porta ${PORT}`);
  console.log(`  DEV  -> Painel:  http://localhost:5173/painel.html`);
  console.log(`          Overlay: http://localhost:5173/overlay.html?token=${OVERLAY_TOKEN}`);
  console.log(`  PROD -> Painel:  http://localhost:${PORT}/painel.html`);
  console.log(`          Overlay: http://localhost:${PORT}/overlay.html?token=${OVERLAY_TOKEN}\n`);
});
