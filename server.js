// server.js
// Simple HTTP + WebSocket server with:
// - matchmaking queue ("Play Online")
// - private rooms ("Join/Create")
// - Stockfish eval (server-side binary) broadcast as numeric only
// - chat + system feed events

import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import path from "path";
import url from "url";
import { spawn } from "child_process";

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/** ---- Room + Queue state ---- */
const rooms = new Map(); // roomId -> { id, fen, clients:Set<ws>, roles: Map<ws,"white"|"black"|"spectator">, engine, eval }
let queue = []; // ws[] waiting

function now() {
  return new Date().toISOString().slice(11, 19);
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  for (const c of room.clients) safeSend(c, obj);
}

function broadcastPresence(room) {
  const players = [...room.roles.values()].filter((r) => r === "white" || r === "black").length;
  broadcast(room, { type: "presence", players });
}

function makeRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

function initialFen() {
  // standard starting position
  return "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
}

function plyFromFen(fen) {
  try {
    const parts = fen.split(" ");
    const turn = parts[1] || "w";
    const fullmove = parseInt(parts[5] || "1", 10);
    const base = (fullmove - 1) * 2;
    return base + (turn === "b" ? 1 : 0);
  } catch {
    return 0;
  }
}

/** ---- Chat + System feed helpers ---- */
function sys(room, text) {
  broadcast(room, { type: "chat", kind: "sys", at: now(), text });
}
function say(room, fromRole, text) {
  broadcast(room, { type: "chat", kind: "user", at: now(), from: fromRole, text });
}

/** ---- Stockfish (server-side) ----
 * Your Render setup already includes stockfish in PATH (or a known location),
 * based on your prior fixes.
 *
 * This server runs ONE engine per room, and only publishes numeric score.
 */
function createEngineForRoom(room) {
  // Use environment override if you want:
  const STOCKFISH_PATH = process.env.STOCKFISH_PATH || "stockfish";

  const engine = spawn(STOCKFISH_PATH, [], { stdio: ["pipe", "pipe", "pipe"] });

  engine.on("error", (err) => {
    room.engineDead = true;
    sys(room, `engine error: ${err.code || err.message}`);
  });

  // UCI init
  engine.stdin.write("uci\n");
  engine.stdin.write("isready\n");

  let buffer = "";
  engine.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;

      // Parse numeric eval from "info ... score cp N" OR "score mate N"
      // We ONLY broadcast number, never best moves.
      if (s.startsWith("info") && s.includes(" score ")) {
        // Prefer cp if present
        const cpMatch = s.match(/score cp (-?\d+)/);
        const mateMatch = s.match(/score mate (-?\d+)/);

        if (cpMatch) {
          const cp = parseInt(cpMatch[1], 10);
          const pawns = cp / 100;
          room.lastEval = pawns;
          broadcast(room, { type: "eval", score: pawns, ply: plyFromFen(room.fen) });
        } else if (mateMatch) {
          const mate = parseInt(mateMatch[1], 10);
          // Represent mate as large magnitude (still numeric)
          const score = mate > 0 ? 99 : -99;
          room.lastEval = score;
          broadcast(room, { type: "eval", score, ply: plyFromFen(room.fen) });
        }
      }
    }
  });

  room.engine = engine;
  room.engineDead = false;
}

function requestEval(room) {
  if (!room.engine || room.engineDead) return;
  // modest depth for responsiveness
  const depth = process.env.EVAL_DEPTH ? parseInt(process.env.EVAL_DEPTH, 10) : 12;

  room.engine.stdin.write(`position fen ${room.fen}\n`);
  room.engine.stdin.write(`go depth ${depth}\n`);
}

/** ---- Room lifecycle ---- */
function createRoom(roomId) {
  const room = {
    id: roomId,
    fen: initialFen(),
    clients: new Set(),
    roles: new Map(),
    engine: null,
    engineDead: false,
    lastEval: 0,
  };
  rooms.set(roomId, room);
  createEngineForRoom(room);
  return room;
}

function joinRoom(ws, roomId) {
  if (!roomId) roomId = makeRoomId();

  let room = rooms.get(roomId);
  if (!room) room = createRoom(roomId);

  room.clients.add(ws);

  // assign role if slot free
  const existingRoles = new Set(room.roles.values());
  let role = "spectator";
  if (!existingRoles.has("white")) role = "white";
  else if (!existingRoles.has("black")) role = "black";

  room.roles.set(ws, role);
  ws.roomId = roomId;
  ws.role = role;

  safeSend(ws, { type: "joined", room: roomId, role });
  safeSend(ws, { type: "state", fen: room.fen });
  broadcastPresence(room);
  sys(room, `${role} joined`);

  // push latest eval immediately
  safeSend(ws, { type: "eval", score: room.lastEval || 0, ply: plyFromFen(room.fen) });
  requestEval(room);

  return room;
}

function leaveRoom(ws) {
  const roomId = ws.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;

  room.clients.delete(ws);
  room.roles.delete(ws);

  sys(room, `${ws.role || "player"} left`);
  broadcastPresence(room);

  ws.roomId = null;
  ws.role = null;

  // cleanup room if empty
  if (room.clients.size === 0) {
    try {
      room.engine?.stdin?.write("quit\n");
      room.engine?.kill?.();
    } catch {}
    rooms.delete(roomId);
  }
}

function removeFromQueue(ws) {
  queue = queue.filter((x) => x !== ws);
}

/** ---- Matchmaking ---- */
function tryMatchmake() {
  // pick first two in queue who are open
  while (queue.length >= 2) {
    const a = queue.shift();
    const b = queue.shift();
    if (!a || !b) continue;

    const roomId = makeRoomId();
    const room = createRoom(roomId);

    // force roles for matched players
    room.clients.add(a);
    room.clients.add(b);
    room.roles.set(a, "white");
    room.roles.set(b, "black");

    a.roomId = roomId; a.role = "white";
    b.roomId = roomId; b.role = "black";

    safeSend(a, { type: "matchFound", room: roomId, role: "white" });
    safeSend(b, { type: "matchFound", room: roomId, role: "black" });

    safeSend(a, { type: "joined", room: roomId, role: "white" });
    safeSend(b, { type: "joined", room: roomId, role: "black" });

    safeSend(a, { type: "state", fen: room.fen });
    safeSend(b, { type: "state", fen: room.fen });

    broadcastPresence(room);
    sys(room, "match started");
    requestEval(room);

    break;
  }
}

/** ---- Chess rules (very lightweight legality) ----
 * NOTE: You previously had legality enforced server-side already.
 * If you're relying on chess.js server-side elsewhere, keep it.
 *
 * For now, we trust the existing move validation that you had.
 * If your current server.js already validates moves properly, replace this
 * with that logic. This file keeps your existing behavior pattern: server
 * decides legality and broadcasts updated fen.
 */
import { Chess } from "chess.js"; // requires your package.json includes chess.js

function getGame(room) {
  if (!room._game) {
    room._game = new Chess();
    room._game.load(room.fen);
  }
  return room._game;
}

function resetGame(room) {
  room.fen = initialFen();
  room._game = new Chess();
  room._game.load(room.fen);
  room.lastEval = 0;
}

/** ---- WebSocket handling ---- */
wss.on("connection", (ws) => {
  ws.roomId = null;
  ws.role = null;

  // no automatic join; client will send join/queue
  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }

    // queue
    if (msg.type === "queue") {
      // leave current room if any
      leaveRoom(ws);
      removeFromQueue(ws);

      queue.push(ws);
      safeSend(ws, { type: "queued" });
      // matchmake now
      tryMatchmake();
      return;
    }

    if (msg.type === "cancelQueue") {
      removeFromQueue(ws);
      safeSend(ws, { type: "queueCanceled" });
      return;
    }

    // join / create
    if (msg.type === "join") {
      removeFromQueue(ws);
      leaveRoom(ws);

      const roomId = (msg.room || "").trim().toUpperCase();
      const room = joinRoom(ws, roomId);

      // system message "connected" in feed
      sys(room, "connected");
      return;
    }

    // restart
    if (msg.type === "restart") {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      // allow either player to restart (MVP)
      resetGame(room);
      broadcast(room, { type: "state", fen: room.fen });
      broadcast(room, { type: "eval", score: 0, ply: plyFromFen(room.fen) });
      sys(room, "game restarted");
      requestEval(room);
      return;
    }

    // chat
    if (msg.type === "chat") {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      const text = (msg.text || "").toString().trim();
      if (!text) return;
      if (text.length > 280) return;

      const fromRole = ws.role || "spectator";
      say(room, fromRole, text);
      return;
    }

    // move
    if (msg.type === "move") {
      const room = rooms.get(ws.roomId);
      if (!room) return;

      const role = ws.role;
      if (role !== "white" && role !== "black") {
        safeSend(ws, { type: "illegal" });
        sys(room, "illegal move (spectator)");
        return;
      }

      const game = getGame(room);
      const turn = game.turn(); // 'w' or 'b'
      if ((turn === "w" && role !== "white") || (turn === "b" && role !== "black")) {
        safeSend(ws, { type: "illegal" });
        sys(room, "illegal move (not your turn)");
        return;
      }

      const from = (msg.from || "").toString();
      const to = (msg.to || "").toString();
      const promotion = (msg.promotion || "q").toString();

      const move = game.move({ from, to, promotion });
      if (!move) {
        safeSend(ws, { type: "illegal" });
        sys(room, "illegal move");
        return;
      }

      room.fen = game.fen();
      broadcast(room, { type: "state", fen: room.fen });
      requestEval(room);
      return;
    }
  });

  ws.on("close", () => {
    removeFromQueue(ws);
    leaveRoom(ws);
  });
});

server.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});

