import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Configuração (use variáveis de ambiente em produção) ---
const PORT = process.env.PORT || 3000;
const MOD_PASSWORD = process.env.MOD_PASSWORD || "troca-essa-senha";
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || "overlay-secreto";

// Cloudinary (free tier) guarda os uploads de forma persistente.
// Defina CLOUDINARY_URL no ambiente para ativar; sem isso, upload cai na pasta local /media.
const USE_CLOUDINARY = !!process.env.CLOUDINARY_URL;
if (USE_CLOUDINARY) cloudinary.config({ secure: true });
const CLOUD_FOLDER = "overlay-live";

const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "m4a", "aac"]);
const MEDIA_TYPES = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".gif": "image", ".webp": "image",
  ".mp3": "audio", ".wav": "audio", ".ogg": "audio", ".m4a": "audio", ".aac": "audio",
  ".mp4": "video", ".webm": "video", ".mov": "video",
};

const mediaDir = path.join(__dirname, "media");
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.json());

// Memes locais ficam em /media
app.use("/media", express.static(mediaDir));

// Frontend buildado (após `npm run build`). Em dev quem serve é o Vite (porta 5173).
const distDir = path.join(__dirname, "dist");
app.use(express.static(distDir));
app.get("/", (_req, res) => res.redirect("/painel.html"));

// Lista os memes da pasta local (sempre) + do Cloudinary (se configurado).
async function listLocalMedia() {
  try {
    const files = await readdir(mediaDir);
    return files
      .map((name) => {
        const type = MEDIA_TYPES[path.extname(name).toLowerCase()];
        if (!type) return null;
        return { id: `local:${name}`, name, type, url: `/media/${encodeURIComponent(name)}` };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function listCloudinaryMedia() {
  if (!USE_CLOUDINARY) return [];
  const map = (r) => {
    const type = r.resource_type === "image" ? "image" : AUDIO_EXT.has(r.format) ? "audio" : "video";
    return { id: `cloud:${r.public_id}`, name: r.public_id.split("/").pop(), type, url: r.secure_url };
  };
  const [imgs, vids] = await Promise.all([
    cloudinary.api.resources({ type: "upload", prefix: `${CLOUD_FOLDER}/`, resource_type: "image", max_results: 200 }),
    cloudinary.api.resources({ type: "upload", prefix: `${CLOUD_FOLDER}/`, resource_type: "video", max_results: 200 }),
  ]);
  return [...imgs.resources, ...vids.resources].map(map);
}

app.get("/api/media", async (_req, res) => {
  try {
    const [local, cloud] = await Promise.all([listLocalMedia(), listCloudinaryMedia()]);
    const items = [...cloud, ...local].sort((a, b) => a.name.localeCompare(b.name));
    res.json(items);
  } catch (err) {
    console.error("Erro ao listar mídia:", err);
    res.json(await listLocalMedia());
  }
});

// --- Upload de memes (protegido pela senha de mod) ---
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (req.headers["x-mod-password"] !== MOD_PASSWORD) return res.status(401).json({ error: "auth" });
  if (!req.file) return res.status(400).json({ error: "sem arquivo" });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return res.status(400).json({ error: "tipo não suportado" });

  try {
    if (USE_CLOUDINARY) {
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const r = await cloudinary.uploader.upload(dataUri, {
        folder: CLOUD_FOLDER,
        resource_type: type === "image" ? "image" : "video", // áudio entra como "video" no Cloudinary
        use_filename: true,
        unique_filename: true,
      });
      return res.json({ id: `cloud:${r.public_id}`, name: r.public_id.split("/").pop(), type, url: r.secure_url });
    }
    // Fallback local: salva na pasta /media (ótimo para dev).
    await mkdir(mediaDir, { recursive: true });
    const safe = req.file.originalname.replace(/[^\w.\-]+/g, "_");
    await writeFile(path.join(mediaDir, safe), req.file.buffer);
    return res.json({ id: `local:${safe}`, name: safe, type, url: `/media/${encodeURIComponent(safe)}` });
  } catch (err) {
    console.error("Erro no upload:", err);
    return res.status(500).json({ error: "falha no upload" });
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
  console.log(`  Upload: ${USE_CLOUDINARY ? "Cloudinary (persistente)" : "pasta local /media (dev)"}`);
  console.log(`  DEV  -> Painel:  http://localhost:5173/painel.html`);
  console.log(`          Overlay: http://localhost:5173/overlay.html?token=${OVERLAY_TOKEN}`);
  console.log(`  PROD -> Painel:  http://localhost:${PORT}/painel.html`);
  console.log(`          Overlay: http://localhost:${PORT}/overlay.html?token=${OVERLAY_TOKEN}\n`);
});
