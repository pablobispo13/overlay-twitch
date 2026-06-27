import React, { useEffect, useRef, useState } from "react";
import { createSocket, applySceneEvent } from "../socket.js";

const DEFAULT_SIZE = 0.15; // 15% da largura do palco
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const uid = () => crypto.randomUUID();

const ROLE_LABELS = { admin: "Admin", supermod: "Super moderador", mod: "Moderador", overlay: "Overlay" };
const roleLabel = (r) => ROLE_LABELS[r] || r;
const sinceLabel = (ts) => {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}min`;
  return `${Math.floor(s / 3600)}h`;
};

export default function Painel() {
  const [password, setPassword] = useState(localStorage.getItem("modPwd") || "");
  const [connected, setConnected] = useState(false);
  const [loginErr, setLoginErr] = useState("");
  const [tryLogin, setTryLogin] = useState(!!localStorage.getItem("modPwd"));
  const socketRef = useRef(null);

  if (!connected && !tryLogin) {
    return (
      <Login
        password={password}
        setPassword={setPassword}
        err={loginErr}
        onSubmit={() => { setLoginErr(""); setTryLogin(true); }}
      />
    );
  }
  return (
    <Board
      password={password}
      socketRef={socketRef}
      connected={connected}
      setConnected={setConnected}
      onAuthFail={() => {
        setTryLogin(false);
        setLoginErr("Senha incorreta ou servidor offline.");
        localStorage.removeItem("modPwd");
      }}
    />
  );
}

function Login({ password, setPassword, err, onSubmit }) {
  return (
    <div className="login">
      <h2>Painel dos Mods</h2>
      <input
        type="password"
        placeholder="Senha"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        autoFocus
      />
      <button onClick={onSubmit}>Entrar</button>
      <div className="err">{err}</div>
    </div>
  );
}

function Board({ password, socketRef, connected, setConnected, onAuthFail }) {
  const [items, setItems] = useState([]);
  const [media, setMedia] = useState([]);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [role, setRole] = useState(null);
  const [myId, setMyId] = useState(null);
  const [users, setUsers] = useState([]);
  const [showMod, setShowMod] = useState(false);
  const stageRef = useRef(null);

  const canManage = role === "admin" || role === "supermod"; // envia/deleta memes
  const isAdmin = role === "admin"; // painel de moderação

  // Conecta como mod e escuta a cena compartilhada.
  useEffect(() => {
    const socket = createSocket({ kind: "mod", secret: password }, { reconnection: false });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      localStorage.setItem("modPwd", password);
      fetch("/api/media").then((r) => r.json()).then(setMedia);
    });
    socket.on("welcome", ({ role, id }) => { setRole(role); setMyId(id); });
    socket.on("users:list", setUsers);
    socket.on("kicked", () => { localStorage.removeItem("modPwd"); alert("Você foi desconectado por um admin."); });
    socket.on("connect_error", onAuthFail);
    socket.on("disconnect", () => setConnected(false));

    for (const ev of ["scene:init", "scene:add", "scene:update", "scene:remove", "scene:clear"]) {
      socket.on(ev, (payload) => applySceneEvent(setItems, ev, payload));
    }

    // Bandeja sincronizada entre todos os mods.
    socket.on("media:add", (m) => setMedia((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev])));
    socket.on("media:remove", (id) => setMedia((prev) => prev.filter((x) => x.id !== id)));
    socket.on("media:volume", ({ id, volume }) =>
      setMedia((prev) => prev.map((x) => (x.id === id ? { ...x, volume } : x))));

    return () => socket.close();
  }, []);

  const emit = (ev, payload) => socketRef.current?.emit(ev, payload);

  // Adiciona imagem ou vídeo na cena (posição = centro do item em x,y).
  function addPlaced(m, x, y) {
    const item = { uid: uid(), mediaId: m.id, url: m.url, type: m.type,
      x: clamp(x - DEFAULT_SIZE / 2, 0, 1), y: clamp(y - DEFAULT_SIZE / 2, 0, 1), size: DEFAULT_SIZE,
      volume: m.volume ?? 1 };
    setItems((prev) => [...prev, item]);
    emit("scene:add", item);
  }

  // Ajusta o volume de um meme (admin/supermod). Reflete em todos os mods.
  function setVolume(m, volume) {
    setMedia((prev) => prev.map((x) => (x.id === m.id ? { ...x, volume } : x)));
    emit("media:volume", { id: m.id, volume });
  }

  function updateItem(uid, patch) {
    setItems((prev) => prev.map((i) => (i.uid === uid ? { ...i, ...patch } : i)));
    emit("scene:update", { uid, ...patch });
  }

  function removeItem(uid) {
    setItems((prev) => prev.filter((i) => i.uid !== uid));
    emit("scene:remove", uid);
  }

  function dropOnStage(e) {
    e.preventDefault();
    setOver(false);
    const raw = e.dataTransfer.getData("application/json");
    if (!raw) return;
    const m = JSON.parse(raw);
    const rect = stageRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (m.type === "audio") emit("sfx:play", { url: m.url, volume: m.volume ?? 1 });
    else addPlaced(m, x, y);
  }

  // Clique na bandeja: imagem/vídeo vai pro centro, som toca na hora.
  function clickTile(m) {
    if (m.type === "audio") emit("sfx:play", { url: m.url, volume: m.volume ?? 1 });
    else addPlaced(m, 0.5, 0.5);
  }

  // Upload de memes (imagem/som/vídeo) direto pelo painel.
  async function uploadFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setUploading(true);
    for (const file of files) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        // A bandeja atualiza via evento "media:add" (reflete em todos os mods).
        const r = await fetch("/api/upload", { method: "POST", headers: { "x-mod-password": password }, body: fd });
        if (!r.ok) console.warn("upload falhou:", file.name, r.status);
      } catch (e) {
        console.warn("erro no upload:", e);
      }
    }
    setUploading(false);
  }

  function kickUser(u) {
    if (u.id === myId) return;
    if (!confirm(`Expulsar este ${roleLabel(u.role)} (${u.ip})?`)) return;
    emit("users:kick", u.id);
  }

  // Deleta o meme do storage (some da bandeja de todos os mods e do palco).
  async function deleteMedia(m) {
    if (!confirm(`Remover "${m.name}" definitivamente?`)) return;
    try {
      await fetch("/api/media/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-mod-password": password },
        body: JSON.stringify({ id: m.id, type: m.type }),
      });
      // A remoção da bandeja/palco chega via "media:remove" e "scene:remove".
    } catch (e) {
      console.warn("erro ao deletar:", e);
    }
  }

  return (
    <div className="app">
      <div className="bar">
        <span className={`dot ${connected ? "on" : "off"}`} />
        <h1>Painel — arraste os memes pro palco</h1>
        {role && <span className={`badge ${role}`}>{roleLabel(role)}</span>}
        {isAdmin && (
          <button className="ghost" onClick={() => setShowMod(true)}>
            🛡️ Moderação{users.length ? ` (${users.length})` : ""}
          </button>
        )}
        {canManage && (
          <label className="upload">
            {uploading ? "Enviando…" : "+ Enviar meme"}
            <input
              type="file"
              accept="image/*,audio/*,video/*"
              multiple
              hidden
              disabled={uploading}
              onChange={(e) => { uploadFiles(e.target.files); e.target.value = ""; }}
            />
          </label>
        )}
        <button className="panic" onClick={() => { setItems([]); emit("scene:clear"); }}>
          LIMPAR TUDO
        </button>
      </div>

      {showMod && isAdmin && (
        <ModerationModal users={users} myId={myId} onKick={kickUser} onClose={() => setShowMod(false)} />
      )}

      <div
        ref={stageRef}
        className={`stage ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={dropOnStage}
      >
        {items.map((it) => (
          <PlacedItem key={it.uid} item={it} stageRef={stageRef}
            onChange={(patch) => updateItem(it.uid, patch)} onRemove={() => removeItem(it.uid)} />
        ))}
      </div>
      <p className="hint">
        Arraste da bandeja pro palco • arraste o meme pra reposicionar • scroll do mouse redimensiona • passe o mouse e clique no ✕ pra remover • sons tocam ao soltar
      </p>

      <div className="tray">
        {media.length === 0 && <p style={{ opacity: 0.6 }}>Envie memes no "+ Enviar meme" ou solte arquivos na pasta /media.</p>}
        {media.map((m) => (
          <div
            key={m.id}
            className="tile"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/json", JSON.stringify(m))}
            onClick={() => clickTile(m)}
            title={m.name}
          >
            {canManage && (
              <button
                className="rm"
                draggable={false}
                onClick={(e) => { e.stopPropagation(); deleteMedia(m); }}
                title="Remover meme"
              >✕</button>
            )}
            {m.type === "image" && <img src={m.url} alt="" />}
            {m.type === "video" && <video src={m.url} muted preload="metadata" />}
            {m.type === "audio" && <span className="ico">🔊</span>}
            <span className="label">{m.name}</span>
            {canManage && (m.type === "audio" || m.type === "video") && (
              <input
                className="vol"
                type="range" min="0" max="1" step="0.05"
                value={m.volume ?? 1}
                title={`Volume: ${Math.round((m.volume ?? 1) * 100)}%`}
                draggable={false}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => e.stopPropagation()}
                onChange={(e) => setVolume(m, Number(e.target.value))}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PlacedItem({ item, stageRef, onChange, onRemove }) {
  const dragging = useRef(false);
  const grab = useRef({ dx: 0, dy: 0 });

  function onPointerDown(e) {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    grab.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    dragging.current = true;
  }
  function onPointerMove(e) {
    if (!dragging.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const x = clamp((e.clientX - grab.current.dx - rect.left) / rect.width, 0, 1);
    const y = clamp((e.clientY - grab.current.dy - rect.top) / rect.height, 0, 1);
    onChange({ x, y });
  }
  function onPointerUp() { dragging.current = false; }
  function onWheel(e) {
    e.preventDefault();
    // Passo maior = mais fácil aumentar rápido.
    onChange({ size: clamp(item.size * (e.deltaY < 0 ? 1.25 : 0.8), 0.03, 1.5) });
  }

  // Alça de redimensionar: arrastar o canto define a largura diretamente.
  const resizing = useRef(false);
  function onResizeDown(e) {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizing.current = true;
  }
  function onResizeMove(e) {
    if (!resizing.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const right = (e.clientX - rect.left) / rect.width;
    onChange({ size: clamp(right - item.x, 0.03, 1.5) });
  }
  function onResizeUp() { resizing.current = false; }

  return (
    <div
      className="placed"
      style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, width: `${item.size * 100}%` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onWheel={onWheel}
    >
      <button className="rm" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove}>✕</button>
      {item.type === "video"
        ? <video src={item.url} muted loop autoPlay playsInline />
        : <img src={item.url} alt="" />}
      <span
        className="resize"
        title="Arraste para redimensionar"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
      />
    </div>
  );
}

function ModerationModal({ users, myId, onKick, onClose }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🛡️ Moderação — {users.length} conectado(s)</h2>
          <button className="ghost" onClick={onClose}>Fechar</button>
        </div>
        <table className="users">
          <thead>
            <tr><th>Papel</th><th>IP</th><th>Conectado há</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.id === myId ? "me" : ""}>
                <td><span className={`badge ${u.role}`}>{roleLabel(u.role)}</span></td>
                <td className="ip">{u.ip}</td>
                <td>{sinceLabel(u.since)}</td>
                <td>
                  {u.id === myId
                    ? <span className="muted">você</span>
                    : <button className="kick" onClick={() => onKick(u)}>Expulsar</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
