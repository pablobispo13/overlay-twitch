import React, { useEffect, useRef, useState } from "react";
import { createSocket, applySceneEvent } from "../socket.js";

const DEFAULT_SIZE = 0.15; // 15% da largura do palco
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const uid = () => crypto.randomUUID();

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
  const stageRef = useRef(null);

  // Conecta como mod e escuta a cena compartilhada.
  useEffect(() => {
    const socket = createSocket({ role: "mod", secret: password }, { reconnection: false });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      localStorage.setItem("modPwd", password);
      fetch("/api/media").then((r) => r.json()).then(setMedia);
    });
    socket.on("connect_error", onAuthFail);
    socket.on("disconnect", () => setConnected(false));

    for (const ev of ["scene:init", "scene:add", "scene:update", "scene:remove", "scene:clear"]) {
      socket.on(ev, (payload) => applySceneEvent(setItems, ev, payload));
    }
    return () => socket.close();
  }, []);

  const emit = (ev, payload) => socketRef.current?.emit(ev, payload);

  // Adiciona uma imagem na cena (posição = centro do item em x,y).
  function addImage(m, x, y) {
    const item = { uid: uid(), mediaId: m.id, url: m.url, type: "image",
      x: clamp(x - DEFAULT_SIZE / 2, 0, 1), y: clamp(y - DEFAULT_SIZE / 2, 0, 1), size: DEFAULT_SIZE };
    setItems((prev) => [...prev, item]);
    emit("scene:add", item);
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
    if (m.type === "audio") emit("sfx:play", { url: m.url, volume: 1 });
    else addImage(m, x, y);
  }

  // Clique na bandeja: imagem vai pro centro, som toca na hora.
  function clickTile(m) {
    if (m.type === "audio") emit("sfx:play", { url: m.url, volume: 1 });
    else addImage(m, 0.5, 0.5);
  }

  return (
    <div className="app">
      <div className="bar">
        <span className={`dot ${connected ? "on" : "off"}`} />
        <h1>Painel — arraste os memes pro palco</h1>
        <button className="panic" onClick={() => { setItems([]); emit("scene:clear"); }}>
          LIMPAR TUDO
        </button>
      </div>

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
        {media.length === 0 && <p style={{ opacity: 0.6 }}>Solte memes na pasta /media do servidor.</p>}
        {media.map((m) => (
          <div
            key={m.id}
            className="tile"
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/json", JSON.stringify(m))}
            onClick={() => clickTile(m)}
            title={m.name}
          >
            {m.type === "image" ? <img src={m.url} alt="" /> : <span className="ico">🔊</span>}
            <span className="label">{m.name}</span>
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
    onChange({ size: clamp(item.size * (e.deltaY < 0 ? 1.1 : 0.9), 0.03, 1) });
  }

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
      <img src={item.url} alt="" />
    </div>
  );
}
