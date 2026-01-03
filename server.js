/**
 * server.js — Live Eval Chess Online
 *
 * Features:
 * - Serve /public (incl /cm-assets)
 * - WebSocket multiplayer at /ws
 * - Private rooms (join by code / link)
 * - Global matchmaking queue: "Find Match" -> auto room + auto seats
 * - Authoritative chess rules (chess.js)
 * - Broadcast state (fen) + numeric eval ONLY
 * - Stockfish eval if available; deterministic material fallback
 * - Never crashes if Stockfish missing/dies
 */

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { Chess } = require("chess.js");
const { spawn } = require("child_process");
const fs = require("fs");

const PORT = process.env.PORT || 10000;

// -----------------------------
// Helpers
// -----------------------------
function genRoomCode(len = 5) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function countPlayers(room) {
  let n = 0;
  for (const client of room.clients) {
    if (client._role === "white" || client._role === "black") n++;
  }
  return n;
}

function plyFromFen(fen) {
  const parts = (fen || "").split(" ");
  const turn = parts[1] || "w";
  const fullmove = parseInt(parts[5] || "1", 10);
  const base = (fullmove - 1) * 2;
  return base + (turn === "b" ? 1 : 0);
}

function materialEvalFromFen(fen) {
  const boardPart = (fen || "").split(" ")[0] || "";
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  let score = 0;

  for (const c of boardPart) {
    if (c === "/" || (c >= "1" && c <= "8")) continue;
    const lower = c.toLowerCase();
    if (!val[lower]) continue;
    score += c === lower ? -val[lower] : val[lower];
  }

  score = Math.max(-9.9, Math.min(9.9, score));
  return Math.round(score * 10) / 10;
}

// -----------------------------
// Stockfish (path-safe, queued, safe)
// -----------------------------
class StockfishEngine {
  constructor() {
    this.available = false;
    this.ready = false;
    this.proc = null;
    this.buffer = "";
    this.queue = [];
    this.busy = false;
    this._initTried = false;
    this._binary = null;
  }

  _candidateBinaries() {
    return [
      process.env.STOCKFISH_PATH,
      "/usr/games/stockfish",
      "/usr/bin/stockfish",
      "stockfish",
    ].filter(Boolean);
  }

  _fileExists(p) {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }

  init() {
    if (this._initTried) return;
    this._initTried = true;

    const candidates = this._candidateBinaries();
    let lastErr = null;

    for (const cmd of candidates) {
      try {
        if (cmd.startsWith("/") && !this._fileExists(cmd)) continue;

        const sf = spawn(cmd, [], { stdio: ["pipe", "pipe", "pipe"] });
        this.proc = sf;
        this._binary = cmd;

        sf.on("error", (err) => {
          console.error(`[stockfish] spawn error (${this._binary}):`, err?.message || err);
          this.available = false;
          this.ready = false;
          this._failAll(err);
        });

        sf.on("exit", (code, signal) => {
          console.error(`[stockfish] exited (${this._binary}):`, { code, signal });
          this.available = false;
          this.ready = false;
          this._failAll(new Error("stockfish exited"));
        });

        sf.stderr.on("data", (d) => {
          console.error(`[stockfish] stderr (${this._binary}):`, d.toString().slice(0, 400));
        });

        sf.stdout.on("data", (d) => {
          this.buffer += d.toString();
          this._drainLines();
        });

        this.available = true;
        console.log(`[stockfish] started: ${this._binary}`);

        this._write("uci");
        this._write("isready");

        setTimeout(() => {
          if (!this.ready) {
            console.error("[stockfish] not ready after timeout; falling back to deterministic eval");
            this.available = false;
          }
        }, 3000);

        return;
      } catch (e) {
        lastErr = e;
      }
    }

    console.error("[stockfish] could not start from candidates:", candidates);
    if (lastErr) console.error("[stockfish] last error:", lastErr?.message || lastErr);

    this.available = false;
    this.ready = false;
    this.proc = null;
  }

  _write(cmd) {
    try {
      if (this.proc && this.proc.stdin && !this.proc.stdin.destroyed) {
        this.proc.stdin.write(cmd + "\n");
      }
    } catch (e) {
      console.error("[stockfish] write failed:", e?.message || e);
    }
  }

  _drainLines() {
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      if (line === "readyok") this.ready = true;

      const job = this.queue[0];
      if (job && job._onLine) job._onLine(line);
    }
  }

  _failAll(err) {
    while (this.queue.length) {
      const job = this.queue.shift();
      try {
        job.reject(err);
      } catch {}
    }
    this.busy = false;
  }

  _scoreToPawnsWhitePOV(scoreObj, fen) {
    if (!scoreObj) return materialEvalFromFen(fen);

    const parts = (fen || "").split(" ");
    const stm = parts[1] || "w";

    let pawns = 0;
    if (scoreObj.type === "cp") pawns = scoreObj.value / 100;
    else if (scoreObj.type === "mate") pawns = (scoreObj.value >= 0 ? 1 : -1) * 99;
    else return materialEvalFromFen(fen);

    // convert from side-to-move to white POV
    if (stm === "b") pawns = -pawns;

    if (Math.abs(pawns) < 90) {
      pawns = Math.max(-9.9, Math.min(9.9, pawns));
      pawns = Math.round(pawns * 10) / 10;
    }

    return pawns;
  }

  evaluateFenQueued(fen, depth = 12) {
    this.init();

    if (!this.available || !this.proc) return Promise.resolve(materialEvalFromFen(fen));

    return new Promise((resolve, reject) => {
      const timeoutMs = 1600;

      const job = {
        _fen: fen,
        _depth: depth,
        resolve,
        reject,
        score: null,
        done: false,
        timeout: null,
        _onLine: null,
      };

      job._onLine = (line) => {
        if (line.startsWith("info ")) {
          const mCp = line.match(/\bscore cp (-?\d+)\b/);
          const mMate = line.match(/\bscore mate (-?\d+)\b/);
          if (mCp) job.score = { type: "cp", value: parseInt(mCp[1], 10) };
          else if (mMate) job.score = { type: "mate", value: parseInt(mMate[1], 10) };
        }

        if (line.startsWith("bestmove ")) {
          job.done = true;
          clearTimeout(job.timeout);

          const score = this._scoreToPawnsWhitePOV(job.score, job._fen);
          resolve(score);

          this.queue.shift();
          this.busy = false;
          this._runNext();
        }
      };

      job.timeout = setTimeout(() => {
        if (job.done) return;
        job.done = true;

        const score = this._scoreToPawnsWhitePOV(job.score, job._fen);
        resolve(score);

        if (this.queue[0] === job) this.queue.shift();
        this.busy = false;
        this._runNext();
      }, timeoutMs);

      this.queue.push(job);
      this._runNext();
    });
  }

  _runNext() {
    if (this.busy) return;
    if (!this.queue.length) return;

    if (!this.available || !this.proc) {
      const job = this.queue.shift();
      clearTimeout(job.timeout);
      this.busy = false;
      job.resolve(materialEvalFromFen(job._fen));
      return;
    }

    this.busy = true;
    const job = this.queue[0];

    this._write("ucinewgame");
    this._write("isready");
    this._write(`position fen ${job._fen}`);
    this._write(`go depth ${job._depth}`);
  }
}

const engine = new StockfishEngine();

// -----------------------------
// Rooms + Matchmaking Queue
// -----------------------------
const rooms = new Map(); // code -> room
let waiting = null;      // { ws, ts } single-slot queue (MVP)

function getOrCreateRoom(code) {
  if (!code) code = genRoomCode();
  let room = rooms.get(code);
  if (!room) {
    room = {
      code,
      game: new Chess(),
      clients: new Set(),
      seats: { white: null, black: null },
      lastEval: 0.0,
      lastEvalPly: 0,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
  }
  return room;
}

function leaveRoom(ws) {
  const room = ws._room;
  if (!room) return;

  room.clients.delete(ws);
  if (room.seats.white === ws) room.seats.white = null;
  if (room.seats.black === ws) room.seats.black = null;

  ws._room = null;
  ws._role = "spectator";

  broadcast(room, { type: "presence", players: countPlayers(room) });

  if (room.clients.size === 0) rooms.delete(room.code);
}

function assignRole(room, ws) {
  if (!room.seats.white || room.seats.white.readyState !== WebSocket.OPEN) {
    room.seats.white = ws;
    ws._role = "white";
    return "white";
  }
  if (!room.seats.black || room.seats.black.readyState !== WebSocket.OPEN) {
    room.seats.black = ws;
    ws._role = "black";
    return "black";
  }
  ws._role = "spectator";
  return "spectator";
}

function seatExplicit(room, ws, role) {
  if (role === "white") room.seats.white = ws;
  if (role === "black") room.seats.black = ws;
  ws._role = role;
}

function canMove(room, ws) {
  const turn = room.game.turn();
  if (ws._role === "white" && turn === "w") return true;
  if (ws._role === "black" && turn === "b") return true;
  return false;
}

async function updateEvalAndBroadcast(room) {
  const fen = room.game.fen();
  const ply = plyFromFen(fen);

  const score = await engine.evaluateFenQueued(fen, 12).catch(() => materialEvalFromFen(fen));

  if (ply < room.lastEvalPly) return;

  room.lastEval = typeof score === "number" ? score : 0.0;
  room.lastEvalPly = ply;

  broadcast(room, { type: "eval", score: room.lastEval, ply });
}

function isWsAlive(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function clearWaitingIf(ws) {
  if (waiting && waiting.ws === ws) waiting = null;
}

function startMatch(wsA, wsB) {
  // Ensure both are not in rooms
  leaveRoom(wsA);
  leaveRoom(wsB);

  const room = getOrCreateRoom("");
  room.game.reset();
  room.lastEval = 0.0;
  room.lastEvalPly = 0;

  // Randomize colors
  const aWhite = Math.random() < 0.5;
  const white = aWhite ? wsA : wsB;
  const black = aWhite ? wsB : wsA;

  // Attach + seat
  room.clients.add(white);
  room.clients.add(black);
  white._room = room;
  black._room = room;

  seatExplicit(room, white, "white");
  seatExplicit(room, black, "black");

  // Tell both clients a match was found (so they can update UI instantly)
  send(white, { type: "matchFound", room: room.code, role: "white" });
  send(black, { type: "matchFound", room: room.code, role: "black" });

  // Then send normal joined/state/eval/presence
  send(white, { type: "joined", room: room.code, role: "white" });
  send(black, { type: "joined", room: room.code, role: "black" });

  broadcast(room, { type: "presence", players: 2 });
  broadcast(room, { type: "state", fen: room.game.fen() });
  broadcast(room, { type: "eval", score: room.lastEval, ply: room.lastEvalPly });
}

// -----------------------------
// Express + HTTP + WS
// -----------------------------
const app = express();

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: "/ws" });

wss.on("connection", (ws) => {
  ws._room = null;
  ws._role = "spectator";

  ws.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || !msg.type) return;

    // ---- Matchmaking ----
    if (msg.type === "queue") {
      // Must be connected but not already playing
      clearWaitingIf(ws);

      // If you're in a room as a player, don't queue
      if (ws._room && (ws._role === "white" || ws._role === "black")) {
        send(ws, { type: "queueError", message: "Leave current game first" });
        return;
      }

      // If no one waiting, enqueue
      if (!waiting || !isWsAlive(waiting.ws)) {
        waiting = { ws, ts: Date.now() };
        send(ws, { type: "queued" });
        return;
      }

      // If waiting is this same ws, ignore
      if (waiting.ws === ws) {
        send(ws, { type: "queued" });
        return;
      }

      // Match!
      const other = waiting.ws;
      waiting = null;

      if (!isWsAlive(other)) {
        // race: other died, enqueue this ws
        waiting = { ws, ts: Date.now() };
        send(ws, { type: "queued" });
        return;
      }

      startMatch(other, ws);
      return;
    }

    if (msg.type === "cancelQueue") {
      clearWaitingIf(ws);
      send(ws, { type: "queueCanceled" });
      return;
    }

    // ---- Private rooms ----
    if (msg.type === "join") {
      clearWaitingIf(ws);

      const requested = (msg.room || "").trim().toUpperCase();

      // If already in a room, leave it (so switching rooms works cleanly)
      if (ws._room) leaveRoom(ws);

      const room = getOrCreateRoom(requested);

      ws._room = room;
      room.clients.add(ws);

      const role = assignRole(room, ws);

      send(ws, { type: "joined", room: room.code, role });
      broadcast(room, { type: "presence", players: countPlayers(room) });

      send(ws, { type: "state", fen: room.game.fen() });
      send(ws, { type: "eval", score: room.lastEval, ply: room.lastEvalPly });

      return;
    }

    const room = ws._room;
    if (!room) return;

    // ---- Moves ----
    if (msg.type === "move") {
      if (!canMove(room, ws)) {
        send(ws, { type: "illegal" });
        return;
      }

      const from = msg.from;
      const to = msg.to;
      const promotion = msg.promotion || "q";

      const move = room.game.move({ from, to, promotion });
      if (!move) {
        send(ws, { type: "illegal" });
        return;
      }

      broadcast(room, { type: "state", fen: room.game.fen() });

      updateEvalAndBroadcast(room).catch((e) => {
        console.error("[eval] failed:", e?.message || e);
      });

      return;
    }

    // ---- Restart ----
    if (msg.type === "restart") {
      room.game.reset();
      room.lastEval = 0.0;
      room.lastEvalPly = 0;

      broadcast(room, { type: "state", fen: room.game.fen() });
      broadcast(room, { type: "eval", score: room.lastEval, ply: room.lastEvalPly });
      return;
    }

    // ---- Leave (optional) ----
    if (msg.type === "leave") {
      leaveRoom(ws);
      send(ws, { type: "left" });
      return;
    }
  });

  ws.on("close", () => {
    clearWaitingIf(ws);
    leaveRoom(ws);
  });

  ws.on("error", (err) => {
    console.error("[ws] error:", err?.message || err);
  });
});

process.on("unhandledRejection", (err) => console.error("[process] unhandledRejection:", err));
process.on("uncaughtException", (err) => console.error("[process] uncaughtException:", err));

server.listen(PORT, () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

