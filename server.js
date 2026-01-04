// server.js (CommonJS) — Matchmaking queue + rooms + chat + move relay
// Render-friendly. No room creation until 2 players are searching.

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
  transports: ["polling", "websocket"],
  allowUpgrades: true,
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ---- Static site ----
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/", (_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ---- Helpers ----
function now() {
  return new Date().toTimeString().slice(0, 8);
}

function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---- State ----
/**
 * rooms: roomCode -> {
 *   players: [socketIdWhite, socketIdBlack] (max 2)
 *   colorBySocket: Map(socketId -> "w"|"b")
 * }
 */
const rooms = new Map();

/**
 * queue: array of socket ids waiting for a match
 * We store socket ids to avoid keeping dead socket references.
 */
let queue = [];

/**
 * reverse lookup: socketId -> roomCode (if joined)
 */
const socketRoom = new Map();

// ---- Chat helpers ----
function emitSys(room, text) {
  io.to(room).emit("chat", { kind: "sys", at: now(), text });
}
function emitUser(room, fromRole, text) {
  io.to(room).emit("chat", { kind: "user", at: now(), from: fromRole, text });
}

function roomInfo(roomCode) {
  const r = rooms.get(roomCode);
  return { room: roomCode, players: r ? r.players.length : 0 };
}

function removeFromQueue(socketId) {
  const idx = queue.indexOf(socketId);
  if (idx !== -1) queue.splice(idx, 1);
}

function cleanupRoomIfEmpty(roomCode) {
  const r = rooms.get(roomCode);
  if (!r) return;
  if (!r.players || r.players.length === 0) {
    rooms.delete(roomCode);
  }
}

function leaveRoom(socket) {
  const socketId = socket.id;
  const roomCode = socketRoom.get(socketId);
  if (!roomCode) return;

  const r = rooms.get(roomCode);
  socketRoom.delete(socketId);

  try {
    socket.leave(roomCode);
  } catch {}

  if (r) {
    r.players = r.players.filter((id) => id !== socketId);
    r.colorBySocket.delete(socketId);

    io.to(roomCode).emit("room:update", roomInfo(roomCode));
    emitSys(roomCode, "player left");

    // if one player remains, notify them
    if (r.players.length === 1) {
      const remaining = r.players[0];
      io.to(remaining).emit("opponent:left");
    }

    cleanupRoomIfEmpty(roomCode);
  }
}

function joinRoomAs(socket, roomCode, role /* "w"|"b" */) {
  // create room if needed
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, { players: [], colorBySocket: new Map() });
  }
  const r = rooms.get(roomCode);

  // prevent duplicates
  if (!r.players.includes(socket.id)) {
    if (r.players.length >= 2) {
      socket.emit("room:error", { msg: "Room full" });
      return false;
    }
    r.players.push(socket.id);
  }
  r.colorBySocket.set(socket.id, role);

  socket.join(roomCode);
  socketRoom.set(socket.id, roomCode);

  socket.emit("room:joined", {
    room: roomCode,
    role,
    players: r.players.length,
  });

  io.to(roomCode).emit("room:update", roomInfo(roomCode));
  return true;
}

// ---- Matchmaking ----
function tryMatchmake() {
  // drop any stale ids (sockets that no longer exist)
  queue = queue.filter((id) => io.sockets.sockets.get(id));

  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (!a || !b) continue;

    const sa = io.sockets.sockets.get(a);
    const sb = io.sockets.sockets.get(b);
    if (!sa || !sb) continue;

    // ensure they aren't already in rooms
    leaveRoom(sa);
    leaveRoom(sb);

    const room = makeRoomCode();
    rooms.set(room, { players: [], colorBySocket: new Map() });

    // join + assign roles
    joinRoomAs(sa, room, "w");
    joinRoomAs(sb, room, "b");

    // tell them match found + game start
    sa.emit("match:found", { room, role: "w" });
    sb.emit("match:found", { room, role: "b" });

    emitSys(room, "match found");
    emitSys(room, "game started");

    // done
    return;
  }
}

// ---- Socket events ----
io.on("connection", (socket) => {
  const transport = socket.conn?.transport?.name;
  console.log("[socket] connected", socket.id, "transport:", transport);

  socket.emit("status", { msg: "connected" });

  // ---- Queue ----
  socket.on("queue:join", () => {
    // remove from existing room
    leaveRoom(socket);

    // already queued?
    if (queue.includes(socket.id)) {
      socket.emit("queue:status", { state: "searching" });
      return;
    }

    queue.push(socket.id);
    socket.emit("queue:status", { state: "searching" });
    socket.emit("chat", { kind: "sys", at: now(), text: "searching for opponent…" });

    tryMatchmake();
  });

  socket.on("queue:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("queue:status", { state: "idle" });
    socket.emit("chat", { kind: "sys", at: now(), text: "search canceled" });
  });

  // ---- Manual rooms (still useful for friend links) ----
  socket.on("room:create", () => {
    // leave queue + existing room
    removeFromQueue(socket.id);
    leaveRoom(socket);

    let code = makeRoomCode();
    while (rooms.has(code)) code = makeRoomCode();

    rooms.set(code, { players: [], colorBySocket: new Map() });

    // creator joins as white
    joinRoomAs(socket, code, "w");
    socket.emit("room:created", { room: code });

    emitSys(code, "room created");
  });

  socket.on("room:join", ({ room }) => {
    removeFromQueue(socket.id);
    leaveRoom(socket);

    const code = String(room || "").toUpperCase().trim();
    if (!code) return;

    if (!rooms.has(code)) {
      socket.emit("room:error", { msg: "Room not found" });
      return;
    }

    const r = rooms.get(code);
    if (r.players.length >= 2) {
      socket.emit("room:error", { msg: "Room is full" });
      return;
    }

    const role = r.players.length === 0 ? "w" : "b";
    joinRoomAs(socket, code, role);

    emitSys(code, "player joined");
    if (r.players.length === 2) {
      emitSys(code, "game started");
      io.to(code).emit("game:start", { room: code });
    }
  });

  socket.on("room:leave", () => {
    removeFromQueue(socket.id);
    leaveRoom(socket);
  });

  // ---- Chat ----
  socket.on("chat:send", ({ text }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;

    const r = rooms.get(roomCode);
    if (!r) return;

    const clean = String(text || "").trim().slice(0, 300);
    if (!clean) return;

    const role = r.colorBySocket.get(socket.id) === "w" ? "white" : "black";
    emitUser(roomCode, role, clean);
  });

  // ---- Move relay (client validates legality with chess.js) ----
  socket.on("move", ({ move, fen, pgn }) => {
    const roomCode = socketRoom.get(socket.id);
    if (!roomCode) return;

    const r = rooms.get(roomCode);
    if (!r) return;

    if (!r.players.includes(socket.id)) return;

    // send to opponent only
    socket.to(roomCode).emit("move", { move, fen, pgn });
  });

  // ---- Disconnect ----
  socket.on("disconnect", (reason) => {
    console.log("[socket] disconnected", socket.id, "reason:", reason);

    removeFromQueue(socket.id);
    leaveRoom(socket);
  });

  socket.on("connect_error", (err) => {
    console.log("[socket] connect_error", socket.id, err?.message || err);
  });
});

// ---- Start ----
const PORT = process.env.PORT || 10000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

