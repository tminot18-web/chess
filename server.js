// Live Eval Chess — Express + Socket.IO + matchmaking queue + rooms + spectators + vendored Stockfish assets

const path = require("path");
const fs = require("fs");
const fsp = fs.promises;
const https = require("https");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");

const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

// ---------- Stockfish vendoring ----------
const ENGINE_DIR = path.join(__dirname, "public", "engine");
const STOCKFISH_BASE = "https://cdn.jsdelivr.net/npm/stockfish.wasm@0.10.0";

const STOCKFISH_FILES = [
  { name: "stockfish.worker.js", url: `${STOCKFISH_BASE}/stockfish.worker.js` },
  { name: "stockfish.js", url: `${STOCKFISH_BASE}/stockfish.js` },
  { name: "stockfish.wasm", url: `${STOCKFISH_BASE}/stockfish.wasm` },
];

function download(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => resolve(Buffer.concat(chunks)));
      })
      .on("error", reject);
  });
}

async function ensureStockfishAssets() {
  await fsp.mkdir(ENGINE_DIR, { recursive: true });
  for (const f of STOCKFISH_FILES) {
    const outPath = path.join(ENGINE_DIR, f.name);
    try {
      await fsp.access(outPath, fs.constants.R_OK);
      // exists
    } catch {
      console.log(`[engine] downloading ${f.name}…`);
      const buf = await download(f.url);
      await fsp.writeFile(outPath, buf);
      console.log(`[engine] wrote ${outPath}`);
    }
  }
}

// ---------- Express static ----------
app.use(express.static(path.join(__dirname, "public")));

// ---------- Matchmaking + rooms ----------
const queue = []; // socket.id[]

// roomCode -> {
//   players: { w: socketId|null, b: socketId|null },
//   spectators: Set<socketId>,
//   game: Chess,
//   moveNumber: number
// }
const rooms = new Map();

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function safeEmit(socket, event, payload) {
  try {
    socket.emit(event, payload);
  } catch {}
}

function broadcastChat(room, msg) {
  io.to(room).emit("chat", msg);
}

function sys(room, text) {
  broadcastChat(room, { kind: "sys", at: new Date().toTimeString().slice(0, 8), text });
}

function removeFromQueue(socketId) {
  const idx = queue.indexOf(socketId);
  if (idx >= 0) queue.splice(idx, 1);
}

function leaveAllRooms(socket) {
  for (const r of socket.rooms) {
    if (r !== socket.id) socket.leave(r);
  }
}

function cleanupRoom(room) {
  const info = rooms.get(room);
  if (!info) return;
  const { w, b } = info.players;
  const specCount = info.spectators ? info.spectators.size : 0;
  if (!w && !b && specCount === 0) rooms.delete(room);
}

function getRoomForSocket(socket) {
  for (const r of socket.rooms) {
    if (r !== socket.id && rooms.has(r)) return r;
  }
  return null;
}

function roleForSocket(room, socketId) {
  const info = rooms.get(room);
  if (!info) return null;
  if (info.players.w === socketId) return "w";
  if (info.players.b === socketId) return "b";
  return null; // spectators have no move role
}

function countsForRoom(room) {
  const info = rooms.get(room);
  if (!info) return { players: 0, spectators: 0 };
  const players = (info.players.w ? 1 : 0) + (info.players.b ? 1 : 0);
  const spectators = info.spectators ? info.spectators.size : 0;
  return { players, spectators };
}

function emitRoomUpdate(room) {
  const info = rooms.get(room);
  if (!info) return;
  const { players, spectators } = countsForRoom(room);
  io.to(room).emit("room:update", { room, players, spectators });
}

function roomSnapshot(room) {
  const info = rooms.get(room);
  if (!info) return null;

  const { players, spectators } = countsForRoom(room);

  return {
    room,
    fen: info.game.fen(),
    pgn: info.game.pgn(),
    moveNumber: info.moveNumber,
    turn: info.game.turn(),
    players: info.players,
    spectators,
    playersCount: players,
  };
}

function ensureRoomStruct(code) {
  let info = rooms.get(code);
  if (!info) {
    info = {
      players: { w: null, b: null },
      spectators: new Set(),
      game: new Chess(),
      moveNumber: 0,
    };
    rooms.set(code, info);
  } else {
    if (!info.spectators) info.spectators = new Set();
  }
  return info;
}

function tryMatchmake() {
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    const sa = io.sockets.sockets.get(a);
    const sb = io.sockets.sockets.get(b);
    if (!sa || !sb) continue;

    const room = makeRoomCode();
    rooms.set(room, {
      players: { w: a, b: b },
      spectators: new Set(),
      game: new Chess(),
      moveNumber: 0,
    });

    sa.join(room);
    sb.join(room);

    safeEmit(sa, "queue:status", { state: "idle" });
    safeEmit(sb, "queue:status", { state: "idle" });

    // ✅ IMPORTANT: black role is "b" (not "w"/"b" mixed)
    safeEmit(sa, "match:found", { room, role: "w" });
    safeEmit(sb, "match:found", { room, role: "b" });

    sys(room, `match found: ${room}`);
    emitRoomUpdate(room);
    io.to(room).emit("state:sync", roomSnapshot(room));
  }
}

// ---------- Socket.IO ----------
io.on("connection", (socket) => {
  socket.emit("chat", { kind: "sys", at: new Date().toTimeString().slice(0, 8), text: "connected" });

  socket.on("queue:join", () => {
    removeFromQueue(socket.id);
    leaveAllRooms(socket);

    queue.push(socket.id);
    socket.emit("queue:status", { state: "searching" });

    tryMatchmake();
  });

  socket.on("queue:cancel", () => {
    removeFromQueue(socket.id);
    socket.emit("queue:status", { state: "idle" });
  });

  socket.on("room:create", () => {
    removeFromQueue(socket.id);
    leaveAllRooms(socket);

    let room = makeRoomCode();
    while (rooms.has(room)) room = makeRoomCode();

    rooms.set(room, {
      players: { w: socket.id, b: null },
      spectators: new Set(),
      game: new Chess(),
      moveNumber: 0,
    });

    socket.join(room);

    socket.emit("room:created", { room });
    sys(room, `room created: ${room}`);
    emitRoomUpdate(room);
    io.to(room).emit("state:sync", roomSnapshot(room));
  });

  socket.on("room:join", ({ room }) => {
    const code = String(room || "").trim().toUpperCase();
    if (!code) return;

    removeFromQueue(socket.id);
    leaveAllRooms(socket);

    const info = ensureRoomStruct(code);

    // ✅ assign seat if available, otherwise join as spectator
    let role = null;

    if (!info.players.w) {
      info.players.w = socket.id;
      role = "w";
    } else if (!info.players.b) {
      info.players.b = socket.id;
      role = "b";
    } else {
      // spectator
      info.spectators.add(socket.id);
      role = "s";
    }

    socket.join(code);

    const { players, spectators } = countsForRoom(code);

    socket.emit("room:joined", { room: code, role, players, spectators });

    if (role === "s") sys(code, "spectator joined");
    else sys(code, `player joined as ${role}`);

    emitRoomUpdate(code);
    io.to(code).emit("state:sync", roomSnapshot(code));
  });

  socket.on("state:request", ({ room }) => {
    const code = String(room || "").trim().toUpperCase();
    if (!code) return;
    const snap = roomSnapshot(code);
    if (!snap) return;
    socket.emit("state:sync", snap);
  });

  socket.on("move:submit", ({ room, move, clientMoveNumber }) => {
    const code = String(room || "").trim().toUpperCase();
    if (!code) return;

    const info = rooms.get(code);
    if (!info) return;

    const role = roleForSocket(code, socket.id); // "w" | "b" | null
    if (!role) {
      socket.emit("move:rejected", { reason: "not_a_player", ...roomSnapshot(code) });
      return;
    }

    // enforce turn
    if (info.game.turn() !== role) {
      socket.emit("move:rejected", { reason: "not_your_turn", ...roomSnapshot(code) });
      return;
    }

    // resync if client is behind/ahead
    if (typeof clientMoveNumber === "number" && clientMoveNumber !== info.moveNumber) {
      socket.emit("move:rejected", { reason: "out_of_sync", ...roomSnapshot(code) });
      return;
    }

    const result = info.game.move(move);
    if (!result) {
      socket.emit("move:rejected", { reason: "illegal_move", ...roomSnapshot(code) });
      return;
    }

    info.moveNumber += 1;

    const payload = {
      room: code,
      fen: info.game.fen(),
      pgn: info.game.pgn(),
      moveNumber: info.moveNumber,
      move: result,
    };

    io.to(code).emit("move:accepted", payload);
  });

  socket.on("chat:send", ({ text }) => {
    const room = getRoomForSocket(socket);
    if (!room) return;

    const role = roleForSocket(room, socket.id);
    const label = role ? role : "s"; // spectators show as "s" in chat

    const msg = {
      kind: "user",
      at: new Date().toTimeString().slice(0, 8),
      from: label,
      text: String(text || "").slice(0, 500),
    };
    broadcastChat(room, msg);
  });

  socket.on("disconnect", () => {
    removeFromQueue(socket.id);

    const room = getRoomForSocket(socket);
    if (room) {
      const info = rooms.get(room);
      if (info) {
        // players
        if (info.players.w === socket.id) info.players.w = null;
        if (info.players.b === socket.id) info.players.b = null;

        // spectators
        if (info.spectators) info.spectators.delete(socket.id);

        socket.to(room).emit("opponent:left");
        sys(room, "a user left");
        emitRoomUpdate(room);
        cleanupRoom(room);
      }
    }
  });
});

// ---------- Boot ----------
(async () => {
  try {
    await ensureStockfishAssets();
    console.log("[engine] ready at /engine/");
  } catch (e) {
    console.error("[engine] failed to prepare stockfish assets:", e);
  }

  server.listen(PORT, HOST, () => {
    console.log(`listening on http://${HOST}:${PORT}`);
  });
})();

