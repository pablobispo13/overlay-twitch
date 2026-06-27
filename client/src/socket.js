import { io } from "socket.io-client";

// Conecta no mesmo host. Em dev o Vite faz proxy de /socket.io para o backend.
export function createSocket(auth, { reconnection = true } = {}) {
  return io({ auth, reconnection });
}

// Hook simples de cena compartilhada entre painel e overlay.
// Aplica os eventos do servidor sobre um estado local de itens.
export function applySceneEvent(setItems, event, payload) {
  switch (event) {
    case "scene:init":
      setItems(payload || []);
      break;
    case "scene:add":
      setItems((prev) => (prev.some((i) => i.uid === payload.uid) ? prev : [...prev, payload]));
      break;
    case "scene:update":
      setItems((prev) => prev.map((i) => (i.uid === payload.uid ? { ...i, ...payload } : i)));
      break;
    case "scene:remove":
      setItems((prev) => prev.filter((i) => i.uid !== payload));
      break;
    case "scene:clear":
      setItems([]);
      break;
  }
}
