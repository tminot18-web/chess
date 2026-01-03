const express = require("express");
const http = require("http");
const path = require("path");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const { Chess } = require("chess.js");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.status(200).send("ok"));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

/** ---- Rooms ----
room = {
  code,
  chess,
  clients: Set<ws>,
  engine: child_process,
  engineBusy: bool,
  pendingEvalFen: string|null
}
*/
const rooms = new Map();

function makeCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of room.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

function ensureRoom(code) {
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      chess: new Chess(),
      clients: new Set(),
      engine: null,
      engineBusy: false,
      pendingEvalFen: null
    };
    rooms.set(code, room);
  }
  return room;
}

function startEngine(room) {
  if (room.engine) return;

  // Stockfish binary is installed in Dockerfile (apt-get install stockfish)
  const engine = spawn("stockfish");

  room.engine = engine;

  engine.stdin.write("uci\n");
  engine.stdin.write("setoption name Threads value 1\n");
  engine.stdin.write("setoption name Hash value 64\n");
  engine.stdin.write("isready\n");

  let buffer = "";
  engine.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) continue;

      // Parse eval
      // Examples:
      // info depth 12 ... score cp 34 ...
      // info depth 18 ... score mate -3 ...
      if (line.startsWith("info ")) {
        const cpMatch = line.match(/\bscore cp (-?\d+)\b/);
        const mateMatch = line.match(/\bscore mate (-?\d+)\b/);

        if (cpMatch) {
          const cp = parseInt(cpMatch[1], 10);
          // From side-to-move perspective; convert to White-perspective number:
          // If it's Black to move, flip sign so display is "White advantage"
          const whiteToMove = room.chess.turn() === "w";
          const whiteCp = whiteToMove ? cp : -cp;
          const score = Math.max(-9.9, Math.min(9.9, whiteCp / 100));

          broadcast(room, { type: "eval", score });
        } else if (mateMatch) {
          const mate = parseInt(mateMatch[1], 10);
          // clamp and show as big number with sign; mate>0 means side to move mates
          const whiteToMove = room.chess.turn() === "w";
          const whiteMate = whiteToMove ? mate : -mate;
          const score = whiteMate > 0 ? 9.9 : -9.9;
          broadcast(room, { type: "eval", score, mate: whiteMate });
        }
      }

      // Ignore bestmove completely. Never broadcast it.
      if (line.startsWith("bestmove")) {
        room.engineBusy = false;

        // If another eval request arrived while busy, run again on latest position.
        if (room.pendingEvalFen) {
          const fen = room.pendingEvalFen;
          room.pendingEvalFen = null;
          queueEval(room, fen);
        }
      }
    }
  });

  engine.on("exit", () => {
    room.engine = null;
    room.engineBusy = false;
    room.pendingEvalFen = null;
  });
}

function queueEval(room, fen) {
  startEngine(room);
  if (!room.engine) return;

  // If engine is mid-search, just remember the latest position and run after bestmove.
  if (room.engineBusy) {
    room.pendingEvalFen = fen;
    return;
  }

  room.engineBusy = true;

  // A fresh search from current position
  room.engine.stdin.write("ucinewgame\n");
  room.engine.stdin.write("isready\n");
  room.engine.stdin.write(`position fen ${fen}\n`);
  room.engine.stdin.write("go depth 12\n"); // tweak later (bots can use higher/lower)
}

function sendState(room) {
  broadcast(room, {
    type: "state",
    fen: room.chess.fen(),
    turn: room.chess.turn(),
    moves: room.chess.history({ verbose: true })
  });
  queueEval(room, room.chess.fen());
}

function cleanupRoomIfEmpty(room) {
  if (room.clients.size > 0) return;
  if (room.engine) {
    try { room.engine.kill(); } catch {}
  }
  rooms.delete(room.code);
}

wss.on("connection", (ws) => {
  ws.roomCode = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "join") {
      const code = (msg.room || "").toString().trim().toUpperCase();
      const roomCode = code || makeCode();

      const room = ensureRoom(roomCode);

      // simple "2 players max" for MVP (spectators later)
      const playerCount = [...room.clients].filter(c => c.isPlayer).length;
      ws.isPlayer = playerCount < 2;

      ws.roomCode = roomCode;
      room.clients.add(ws);

      ws.send(JSON.stringify({
        type: "joined",
        room: roomCode,
        role: ws.isPlayer ? (playerCount === 0 ? "white" : "black") : "spectator"
      }));

      // On first join, send initial state (and eval)
      ws.send(JSON.stringify({ type: "state", fen: room.chess.fen(), turn: room.chess.turn(), moves: [] }));
      queueEval(room, room.chess.fen());

      // Let everyone know who’s in
      broadcast(room, { type: "presence", players: [...room.clients].filter(c => c.isPlayer).length });
      return;
    }

    if (!ws.roomCode) return;
    const room = rooms.get(ws.roomCode);
    if (!room) return;

    if (msg.type === "move") {
      if (!ws.isPlayer) return;

      const { from, to, promotion } = msg;
      const move = room.chess.move({ from, to, promotion: promotion || "q" });
      if (!move) {
        ws.send(JSON.stringify({ type: "illegal" }));
        return;
      }

      sendState(room);
      return;
    }

    if (msg.type === "restart") {
      // Any player can restart for MVP; later: only room owner or both agree
      room.chess.reset();
      sendState(room);
      return;
    }
  });

  ws.on("close", () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.clients.delete(ws);
    broadcast(room, { type: "presence", players: [...room.clients].filter(c => c.isPlayer).length });
    cleanupRoomIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

