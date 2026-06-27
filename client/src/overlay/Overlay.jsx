import React, { useEffect, useRef, useState } from "react";
import { createSocket, applySceneEvent } from "../socket.js";

const token = new URLSearchParams(location.search).get("token") || "";

export default function Overlay() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("conectando…");
  const socketRef = useRef(null);

  useEffect(() => {
    const socket = createSocket({ role: "overlay", secret: token });
    socketRef.current = socket;

    socket.on("connect", () => setStatus("online"));
    socket.on("connect_error", () => setStatus("erro de auth — confira o ?token="));
    socket.on("disconnect", () => setStatus("desconectado"));

    for (const ev of ["scene:init", "scene:add", "scene:update", "scene:remove", "scene:clear"]) {
      socket.on(ev, (payload) => applySceneEvent(setItems, ev, payload));
    }

    socket.on("sfx:play", ({ url, volume = 1 }) => {
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.play().catch((e) => console.warn("autoplay bloqueado:", e));
    });

    return () => socket.close();
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, pointerEvents: "none" }}>
      {items.map((it) =>
        it.type === "image" ? (
          <img
            key={it.uid}
            src={it.url}
            alt=""
            style={{
              position: "absolute",
              left: `${it.x * 100}%`,
              top: `${it.y * 100}%`,
              width: `${it.size * 100}%`,
              filter: "drop-shadow(0 8px 24px rgba(0,0,0,.5))",
            }}
          />
        ) : null
      )}
      {status !== "online" && (
        <div style={{ position: "fixed", left: 8, bottom: 6, font: "12px monospace", color: "#f55", opacity: 0.7 }}>
          overlay: {status}
        </div>
      )}
    </div>
  );
}
