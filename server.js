// server.js (CommonJS) — works on Render without "type": "module"

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Socket.io (Render-friendly)
const io = new Server(server, {
  cors: { origin: "*" },
});

// ---- Static site ----
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Simple health check
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

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

io.on("connection", (socket) => {
  socket.emit("status", { msg: "connected" });

  socket.on("room:create", () => {
    // create room, join as white by default
    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    rooms.set(code, {
      players: [],
      colorBySocket: new Map(),
    });

    socket.emit("room:created", { room: code });
  });

  socket.on("room:join", ({ room }) => {
    if (!room || typeof room !== "string") return;
    const code = room.toUpperCase().trim();

    if (!rooms.has(code)) {
      socket.emit("room:error", { msg: "Room not found" });
      return;
    }

    const r = rooms.get(code);

    // prevent double-join
    if (r.players.includes(socket.id)) {
      socket.emit("room:joined", { room: code, role: r.colorBySocket.get(socket.id) || "w", ...roomInfo(code) });
      return;
    }

    if (r.players.length >= 2) {
      socket.emit("room:error", { msg: "Room is full" });
      return;
    }

    r.players.push(socket.id);

    // assign colors: first is white, second is black
    const role = r.players.length === 1 ? "w" : "b";
    r.colorBySocket.set(socket.id, role);

    socket.join(code);

    socket.emit("room:joined", { room: code, role, ...roomInfo(code) });
    safeEmitRoom(code, "room:update", { ...roomInfo(code) });

    // if both connected, tell both clients to start
    if (r.players.length === 2) {
      const [wId, bId] = r.players;
      io.to(wId).emit("game:start", { room: code, role: "w" });
      io.to(bId).emit("game:start", { room: code, role: "b" });
      safeEmitRoom(code, "status", { msg: "both players connected" });
    }
  });

  // relay moves (server does NOT validate chess rules — client does)
  socket.on("move", ({ room, move, fen, pgn }) => {
    if (!room) return;
    const code = String(room).toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return;
    if (!r.players.includes(socket.id)) return;

    // send to opponent only
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

    r.players = r.players.filter((id) => id !== socket.id);
    r.colorBySocket.delete(socket.id);
    socket.leave(code);

    safeEmitRoom(code, "status", { msg: "player left" });
    safeEmitRoom(code, "room:update", { ...roomInfo(code) });

    if (r.players.length === 0) rooms.delete(code);
  });

  socket.on("disconnect", () => {
    // remove from any room
    for (const [code, r] of rooms.entries()) {
      if (r.players.includes(socket.id)) {
        r.players = r.players.filter((id) => id !== socket.id);
        r.colorBySocket.delete(socket.id);
        safeEmitRoom(code, "status", { msg: "player disconnected" });
        safeEmitRoom(code, "room:update", { ...roomInfo(code) });
        if (r.players.length === 0) rooms.delete(code);
      }
    }
  });
});

// ---- Start server ----
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

