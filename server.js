import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { readdir, writeFile, readFile, mkdir, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Configuração (use variáveis de ambiente em produção) ---
// Três níveis de acesso, do mais forte ao mais fraco:
//  admin    -> usa memes + envia/deleta + painel de moderação (expulsar conectados)
//  supermod -> usa memes + envia/deleta
//  mod      -> só usa memes no overlay
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || process.env.MOD_PASSWORD || "troca-essa-senha";
const SUPERMOD_PASSWORD = process.env.SUPERMOD_PASSWORD || "supermoderador";
const MODERATOR_PASSWORD = process.env.MODERATOR_PASSWORD || "moderador";
const OVERLAY_TOKEN = process.env.OVERLAY_TOKEN || "overlay-secreto";

// Resolve o papel a partir da senha digitada (null = senha inválida).
function roleFromSecret(secret) {
  if (secret === ADMIN_PASSWORD) return "admin";
  if (secret === SUPERMOD_PASSWORD) return "supermod";
  if (secret === MODERATOR_PASSWORD) return "mod";
  return null;
}
const canManageMedia = (role) => role === "admin" || role === "supermod";

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

// Volume por meme (0..1), gerido por admin/supermod. Persiste em volumes.json.
const volumesFile = path.join(__dirname, "volumes.json");
let volumes = {};
try { volumes = JSON.parse(await readFile(volumesFile, "utf8")); } catch { volumes = {}; }
const saveVolumes = () => writeFile(volumesFile, JSON.stringify(volumes)).catch(() => {});
const volOf = (id) => (typeof volumes[id] === "number" ? volumes[id] : 1);

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
        const id = `local:${name}`;
        return { id, name, type, url: `/media/${encodeURIComponent(name)}`, volume: volOf(id) };
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
    const id = `cloud:${r.public_id}`;
    return { id, name: r.public_id.split("/").pop(), type, url: r.secure_url, volume: volOf(id) };
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

// --- Upload de memes (apenas admin/supermod) ---
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!canManageMedia(roleFromSecret(req.headers["x-mod-password"]))) return res.status(401).json({ error: "auth" });
  if (!req.file) return res.status(400).json({ error: "sem arquivo" });

  const ext = path.extname(req.file.originalname).toLowerCase();
  const type = MEDIA_TYPES[ext];
  if (!type) return res.status(400).json({ error: "tipo não suportado" });

  try {
    let item;
    if (USE_CLOUDINARY) {
      const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
      const r = await cloudinary.uploader.upload(dataUri, {
        folder: CLOUD_FOLDER,
        resource_type: type === "image" ? "image" : "video", // áudio entra como "video" no Cloudinary
        use_filename: true,
        unique_filename: true,
      });
      item = { id: `cloud:${r.public_id}`, name: r.public_id.split("/").pop(), type, url: r.secure_url };
    } else {
      // Fallback local: salva na pasta /media (ótimo para dev).
      await mkdir(mediaDir, { recursive: true });
      const safe = req.file.originalname.replace(/[^\w.\-]+/g, "_");
      await writeFile(path.join(mediaDir, safe), req.file.buffer);
      item = { id: `local:${safe}`, name: safe, type, url: `/media/${encodeURIComponent(safe)}` };
    }
    io.to("mods").emit("media:add", item); // reflete na bandeja de todos os mods
    return res.json(item);
  } catch (err) {
    console.error("Erro no upload:", err);
    return res.status(500).json({ error: "falha no upload" });
  }
});

// --- Deletar meme do storage (protegido pela senha de mod) ---
app.post("/api/media/delete", async (req, res) => {
  if (!canManageMedia(roleFromSecret(req.headers["x-mod-password"]))) return res.status(401).json({ error: "auth" });
  const { id, type } = req.body || {};
  if (!id) return res.status(400).json({ error: "sem id" });

  try {
    if (id.startsWith("cloud:")) {
      const publicId = id.slice("cloud:".length);
      await cloudinary.uploader.destroy(publicId, { resource_type: type === "image" ? "image" : "video" });
    } else if (id.startsWith("local:")) {
      const name = path.basename(id.slice("local:".length)); // evita path traversal
      await unlink(path.join(mediaDir, name)).catch(() => {});
    }

    if (id in volumes) { delete volumes[id]; saveVolumes(); }
    io.to("mods").emit("media:remove", id); // tira da bandeja de todos os mods

    // Remove do palco os itens que usavam esse meme (em todos: mods e overlay).
    const removed = scene.filter((s) => s.mediaId === id);
    if (removed.length) {
      scene = scene.filter((s) => s.mediaId !== id);
      for (const it of removed) io.emit("scene:remove", it.uid);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erro ao deletar:", err);
    return res.status(500).json({ error: "falha ao deletar" });
  }
});

// --- Estado da cena (memes posicionados no palco) ---
// Mantido em memória para que um overlay recém-aberto receba a cena atual.
let scene = []; // [{ uid, mediaId, url, type, x, y, size }]

// --- Tempo real ---
io.use((socket, next) => {
  const { kind, secret, name } = socket.handshake.auth || {};
  if (kind === "overlay" && secret === OVERLAY_TOKEN) {
    socket.data.role = "overlay";
    return next();
  }
  if (kind === "mod") {
    const role = roleFromSecret(secret);
    if (role) {
      socket.data.role = role;
      socket.data.name = (typeof name === "string" && name.trim().slice(0, 24)) || role;
      return next();
    }
  }
  return next(new Error("auth_failed"));
});

// IP real do cliente (atrás do proxy do Render/Railway vem no x-forwarded-for).
function clientIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return socket.handshake.address;
}

// Lista de conectados (para o painel de moderação do admin).
function usersList() {
  const out = [];
  for (const [id, s] of io.sockets.sockets) {
    out.push({ id, role: s.data.role, name: s.data.name || s.data.role, since: s.data.since, ip: clientIp(s) });
  }
  return out.sort((a, b) => a.since - b.since);
}
const broadcastUsers = () => io.to("admins").emit("users:list", usersList());

io.on("connection", (socket) => {
  const role = socket.data.role; // admin | supermod | mod | overlay
  socket.data.since = Date.now();
  const isMod = role !== "overlay";

  socket.join(isMod ? "mods" : "overlay");
  if (role === "admin") socket.join("admins");
  console.log(`${role} conectado:`, socket.id);

  socket.emit("welcome", { role, id: socket.id });
  socket.emit("scene:init", scene);
  broadcastUsers();

  // Permissões por papel.
  const guard = (allowed, fn) => (payload) => { if (allowed.includes(role)) fn(payload); };
  const sceneRoles = ["admin", "supermod", "mod"]; // todos usam memes

  socket.on("scene:add", guard(sceneRoles, (item) => {
    if (!item?.uid) return;
    scene.push(item);
    io.emit("scene:add", item);
  }));

  socket.on("scene:update", guard(sceneRoles, ({ uid, ...patch } = {}) => {
    const it = scene.find((s) => s.uid === uid);
    if (!it) return;
    Object.assign(it, patch);
    io.emit("scene:update", { uid, ...patch });
  }));

  socket.on("scene:remove", guard(sceneRoles, (uid) => {
    scene = scene.filter((s) => s.uid !== uid);
    io.emit("scene:remove", uid);
  }));

  socket.on("scene:clear", guard(sceneRoles, () => {
    scene = [];
    io.emit("scene:clear");
  }));

  // Sons são one-shot: tocam só no overlay (na live), não na tela do mod.
  socket.on("sfx:play", guard(sceneRoles, (payload) => {
    io.to("overlay").emit("sfx:play", payload);
  }));

  // Volume por meme: só admin/supermod ajustam; reflete na bandeja de todos os mods.
  socket.on("media:volume", guard(["admin", "supermod"], ({ id, volume } = {}) => {
    if (!id || typeof volume !== "number") return;
    volumes[id] = Math.max(0, Math.min(1, volume));
    saveVolumes();
    io.to("mods").emit("media:volume", { id, volume: volumes[id] });
  }));

  // Moderação: só admin expulsa conectados.
  socket.on("users:kick", guard(["admin"], (id) => {
    const target = io.sockets.sockets.get(id);
    if (target && id !== socket.id) {
      target.emit("kicked");
      target.disconnect(true);
    }
  }));

  socket.on("disconnect", () => broadcastUsers());
});

httpServer.listen(PORT, () => {
  console.log(`\n  Overlay Live na porta ${PORT}`);
  console.log(`  Upload: ${USE_CLOUDINARY ? "Cloudinary (persistente)" : "pasta local /media (dev)"}`);
  console.log(`  Acessos: admin / supermod / mod (3 senhas)`);
  console.log(`  DEV  -> Painel:  http://localhost:5173/painel.html`);
  console.log(`          Overlay: http://localhost:5173/overlay.html?token=${OVERLAY_TOKEN}`);
  console.log(`  PROD -> Painel:  http://localhost:${PORT}/painel.html`);
  console.log(`          Overlay: http://localhost:${PORT}/overlay.html?token=${OVERLAY_TOKEN}\n`);
});
