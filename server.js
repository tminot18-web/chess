// server.js (CommonJS) — Render-friendly + better socket diagnostics

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// ---- Static site ----
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Helpful: confirms Socket.IO endpoint is reachable
app.get("/socktest", (_req, res) =>
  res.status(200).send("If /socket.io works, socket should connect.")
);

// ---- Socket.IO ----
// IMPORTANT: allow polling fallback (Render + some networks need it)
const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["polling", "websocket"],
  allowUpgrades: true,
  pingInterval: 25000,
  pingTimeout: 20000,
});

io.engine.on("connection_error", (err) => {
  console.log("[engine] connection_error", {
    code: err.code,
    message: err.message,
    context: err.context,
  });
});

// ---- Rooms / matchmaking ----
const rooms = new Map(); // roomCode -> { players: [socketId], colorBySocket: Map(socketId -> "w"|"b") }

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function roomInfo(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return { room: roomCode, players: 0 };
  return { room: roomCode, players: r.players.length };
}

function safeEmitRoom(roomCode, event, payload) {
  io.to(roomCode).emit(event, payload);
}

function removeFromRoom(roomCode, socketId) {
  const r = rooms.get(roomCode);
  if (!r) return;

  r.players = r.players.filter((id) => id !== socketId);
  r.colorBySocket.delete(socketId);

  safeEmitRoom(roomCode, "status", { msg: "player disconnected" });
  safeEmitRoom(roomCode, "room:update", { ...roomInfo(roomCode) });

  if (r.players.length === 0) rooms.delete(roomCode);
}

io.on("connection", (socket) => {
  const transport = socket.conn?.transport?.name;
  console.log("[socket] connected", socket.id, "transport:", transport);

  socket.emit("status", { msg: "connected" });

  // Auto-join helper used by create/join
  function joinRoom(code) {
    const r = rooms.get(code);
    if (!r) return { ok: false, msg: "Room not found" };

    // prevent double-join
    if (!r.players.includes(socket.id)) {
      if (r.players.length >= 2) return { ok: false, msg: "Room is full" };
      r.players.push(socket.id);

      // assign colors: first is white, second is black
      const role = r.players.length === 1 ? "w" : "b";
      r.colorBySocket.set(socket.id, role);

      socket.join(code);

      socket.emit("room:joined", { room: code, role, ...roomInfo(code) });
      safeEmitRoom(code, "room:update", { ...roomInfo(code) });

      if (r.players.length === 2) {
        const [wId, bId] = r.players;
        io.to(wId).emit("game:start", { room: code, role: "w" });
        io.to(bId).emit("game:start", { room: code, role: "b" });
        safeEmitRoom(code, "status", { msg: "both players connected" });
      }

      return { ok: true };
    } else {
      const role = r.colorBySocket.get(socket.id) || "w";
      socket.emit("room:joined", { room: code, role, ...roomInfo(code) });
      return { ok: true };
    }
  }

  socket.on("room:create", () => {
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    rooms.set(code, { players: [], colorBySocket: new Map() });

    socket.emit("room:created", { room: code });

    // 👇 Critical: creator immediately joins as White
    joinRoom(code);
  });

  socket.on("room:join", ({ room }) => {
    if (!room || typeof room !== "string") return;
    const code = room.toUpperCase().trim();

    if (!rooms.has(code)) {
      socket.emit("room:error", { msg: "Room not found" });
      return;
    }

    const res = joinRoom(code);
    if (!res.ok) socket.emit("room:error", { msg: res.msg || "Join failed" });
  });

  // relay moves (server does NOT validate chess rules — client does)
  socket.on("move", ({ room, move, fen, pgn }) => {
    const code = String(room || "").toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return;
    if (!r.players.includes(socket.id)) return;

    socket.to(code).emit("move", { move, fen, pgn });
  });

  socket.on("chat", ({ room, text }) => {
    const code = String(room || "").toUpperCase().trim();
    if (!code) return;
    if (!rooms.has(code)) return;

    const clean = String(text || "").slice(0, 500);
    safeEmitRoom(code, "chat", { from: socket.id, text: clean });
  });

  socket.on("room:leave", ({ room }) => {
    const code = String(room || "").toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return;

    removeFromRoom(code, socket.id);
    socket.leave(code);

    safeEmitRoom(code, "status", { msg: "player left" });
  });

  socket.on("disconnect", (reason) => {
    console.log("[socket] disconnected", socket.id, "reason:", reason);

    for (const code of rooms.keys()) {
      const r = rooms.get(code);
      if (r && r.players.includes(socket.id)) removeFromRoom(code, socket.id);
    }
  });

  socket.on("error", (err) => {
    console.log("[socket] error", socket.id, err?.message || err);
  });
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

