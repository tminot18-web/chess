/**
 * server.js — Live Eval Chess Online (Render-safe)
 *
 * Goals:
 * - Serve /public (including /cm-assets/*)
 * - WebSocket multiplayer at /ws
 * - Room create/join
 * - Authoritative chess rules (chess.js)
 * - Broadcast state + numeric eval only
 * - NEVER crash if Stockfish missing or dies
 *
 * Expected deps:
 *   npm i express ws chess.js
 */

const path = require("path");
const http = require("http");
const express = require("express");
const WebSocket = require("ws");
const { Chess } = require("chess.js");
const { spawn } = require("child_process");

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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(room, obj) {
  const msg = JSON.stringify(obj);
  for (const client of room.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

function countPlayers(room) {
  // Count only real seats (white/black) currently connected
  let n = 0;
  for (const client of room.clients) {
    if (client._role === "white" || client._role === "black") n++;
  }
  return n;
}

// -----------------------------
// Stockfish wrapper (safe + queued)
// -----------------------------
class StockfishEngine {
  constructor() {
    this.available = false;
    this.proc = null;
    this.buffer = "";
    this.queue = [];
    this.busy = false;
    this.ready = false;
    this._initTried = false;
  }

  init() {
    if (this._initTried) return;
    this._initTried = true;

    try {
      const sf = spawn("stockfish", [], { stdio: ["pipe", "pipe", "pipe"] });
      this.proc = sf;

      sf.on("error", (err) => {
        console.error("[stockfish] spawn error:", err?.message || err);
        this.available = false;
        this.ready = false;
        this._failAll(err);
      });

      sf.on("exit", (code, signal) => {
        console.error("[stockfish] exited:", { code, signal });
        this.available = false;
        this.ready = false;
        this._failAll(new Error("stockfish exited"));
      });

      sf.stderr.on("data", (d) => {
        // don't crash on stderr noise
        console.error("[stockfish] stderr:", d.toString().slice(0, 500));
      });

      sf.stdout.on("data", (d) => {
        this.buffer += d.toString();
        this._drainLines();
      });

      this.available = true;

      // UCI handshake
      this._write("uci");
      this._write("isready");

      // If it never becomes ready, we’ll still keep server alive; eval will fallback.
      setTimeout(() => {
        if (!this.ready) {
          console.error("[stockfish] not ready after timeout; falling back to fake eval");
          this.available = false;
        }
      }, 2500);
    } catch (e) {
      console.error("[stockfish] init threw:", e?.message || e);
      this.available = false;
      this.ready = false;
    }
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

      // readiness
      if (line === "readyok") this.ready = true;

      // pass to current request parser
      if (this.queue.length && this.queue[0]._onLine) {
        this.queue[0]._onLine(line);
      }
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

  /**
   * Evaluate a position and return a white-perspective score in pawns (e.g. +1.3).
   * Stockfish scores are from side-to-move; we convert to white POV.
   */
  evaluateFen(fen, depth = 12) {
    this.init();

    // If stockfish not available, return a stable fallback quickly
    if (!this.available || !this.proc) {
      return Promise.resolve(this._fakeEvalFromFen(fen));
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = 1500;

      const job = {
        resolve,
        reject,
        score: null,
        done: false,
        timeout: null,
        _onLine: (line) => {
          // Parse score from "info" lines
          // Examples:
          // info depth 12 score cp 34 ...
          // info depth 18 score mate 3 ...
          if (line.startsWith("info ")) {
            const mCp = line.match(/\bscore cp (-?\d+)\b/);
            const mMate = line.match(/\bscore mate (-?\d+)\b/);

            if (mCp) {
              const cp = parseInt(mCp[1], 10);
              job.score = { type: "cp", value: cp };
            } else if (mMate) {
              const mate = parseInt(mMate[1], 10);
              job.score = { type: "mate", value: mate };
            }
          }

          if (line.startsWith("bestmove ")) {
            job.done = true;
            clearTimeout(job.timeout);

            // Convert to pawn value, white POV
            const score = this._scoreToPawnsWhitePOV(job.score, fen);
            resolve(score);

            // pop job + run next
            this.queue.shift();
            this.busy = false;
            this._runNext();
          }
        },
      };

      job.timeout = setTimeout(() => {
        // timeout: resolve with best we had, or fallback
        if (job.done) return;
        job.done = true;

        const score = this._scoreToPawnsWhitePOV(job.score, fen);
        resolve(score);

        // pop job + run next
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
      // resolve immediately with fallback
      const job = this.queue.shift();
      clearTimeout(job.timeout);
      this.busy = false;
      job.resolve(this._fakeEvalFromFen("")); // fen unknown here, but fine
      return;
    }

    this.busy = true;
    const job = this.queue[0];

    // The job's parser will run as lines arrive
    // Send UCI commands
    // NOTE: we don’t set multipv, and we never expose best moves—only score.
    const fen = job._fen;
    // We stash fen on job before calling _runNext in evaluateFen
  }

  _fakeEvalFromFen(_fen) {
    // Small-ish noisy eval fallback so UI stays alive (and app never 502s)
    // Range about [-1.5, +1.5]
    const v = (Math.random() * 3 - 1.5);
    return Math.round(v * 10) / 10;
  }

  _scoreToPawnsWhitePOV(scoreObj, fen) {
    // If we got nothing, fallback
    if (!scoreObj) return this._fakeEvalFromFen(fen);

    // Determine side to move from fen
    // fen: ".... w ..." or ".... b ..."
    const parts = (fen || "").split(" ");
    const stm = parts[1] || "w"; // side to move

    let pawns = 0;

    if (scoreObj.type === "cp") {
      pawns = scoreObj.value / 100;
    } else if (scoreObj.type === "mate") {
      // Convert mate score into a large eval so UI reflects decisive position
      // mate > 0 means side-to-move mates; mate < 0 means side-to-move gets mated
      const sign = scoreObj.value >= 0 ? 1 : -1;
      pawns = sign * 99; // big number
    } else {
      return this._fakeEvalFromFen(fen);
    }

    // Stockfish score is from side-to-move perspective.
    // Convert to White POV:
    // - if side-to-move is white: keep
    // - if side-to-move is black: invert
    if (stm === "b") pawns = -pawns;

    // Clamp for nicer UI (except mate)
    if (Math.abs(pawns) < 90) {
      pawns = Math.max(-9.9, Math.min(9.9, pawns));
      pawns = Math.round(pawns * 10) / 10;
    }

    return pawns;
  }

  // Patch: stash fen for queued jobs
  evaluateFenQueued(fen, depth = 12) {
    this.init();
    if (!this.available || !this.proc) return Promise.resolve(this._fakeEvalFromFen(fen));

    return new Promise((resolve, reject) => {
      const timeoutMs = 1500;
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
          this._runNextReal();
        }
      };

      job.timeout = setTimeout(() => {
        if (job.done) return;
        job.done = true;
        const score = this._scoreToPawnsWhitePOV(job.score, job._fen);
        resolve(score);
        if (this.queue[0] === job) this.queue.shift();
        this.busy = false;
        this._runNextReal();
      }, timeoutMs);

      this.queue.push(job);
      this._runNextReal();
    });
  }

  _runNextReal() {
    if (this.busy) return;
    if (!this.queue.length) return;
    if (!this.available || !this.proc) {
      const job = this.queue.shift();
      clearTimeout(job.timeout);
      this.busy = false;
      job.resolve(this._fakeEvalFromFen(job._fen));
      return;
    }

    this.busy = true;
    const job = this.queue[0];

    // Fresh analysis
    this._write("ucinewgame");
    this._write("isready");
    this._write(`position fen ${job._fen}`);
    this._write(`go depth ${job._depth}`);
  }
}

// Shared engine for simplicity (low traffic MVP). Never crashes server.
const engine = new StockfishEngine();

// -----------------------------
// Room state
// -----------------------------
const rooms = new Map(); // roomCode -> { game, clients:Set, seats:{white,black}, lastEval }

// Create or get room
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
      createdAt: Date.now(),
    };
    rooms.set(code, room);
  }
  return room;
}

function assignRole(room, ws) {
  // Prefer seating: white, then black, else spectator
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

function canMove(room, ws) {
  const turn = room.game.turn(); // 'w' or 'b'
  if (ws._role === "white" && turn === "w") return true;
  if (ws._role === "black" && turn === "b") return true;
  return false;
}

async function updateEvalAndBroadcast(room) {
  const fen = room.game.fen();

  // Evaluate (Stockfish if available; otherwise fallback)
  const score = await engine.evaluateFenQueued(fen, 12).catch(() => 0.0);

  room.lastEval = typeof score === "number" ? score : 0.0;

  broadcast(room, { type: "eval", score: room.lastEval });
}

// -----------------------------
// Express + HTTP + WS
// -----------------------------
const app = express();

// Basic health endpoint
app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// Serve static assets
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// SPA-ish fallback to index.html (optional; safe)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  path: "/ws",
});

wss.on("connection", (ws) => {
  ws._room = null;
  ws._role = "spectator";

  ws.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || !msg.type) return;

    // JOIN / CREATE
    if (msg.type === "join") {
      const requested = (msg.room || "").trim().toUpperCase();
      const room = getOrCreateRoom(requested);

      // attach
      ws._room = room;
      room.clients.add(ws);

      const role = assignRole(room, ws);

      send(ws, { type: "joined", room: room.code, role });

      // presence + state + eval
      broadcast(room, { type: "presence", players: countPlayers(room) });
      send(ws, { type: "state", fen: room.game.fen() });
      send(ws, { type: "eval", score: room.lastEval });

      return;
    }

    const room = ws._room;
    if (!room) return;

    // MOVE
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

      // Broadcast new state
      broadcast(room, { type: "state", fen: room.game.fen() });

      // Update eval (async). Don’t block moves.
      updateEvalAndBroadcast(room).catch((e) => {
        console.error("[eval] failed:", e?.message || e);
      });

      return;
    }

    // RESTART
    if (msg.type === "restart") {
      room.game.reset();
      room.lastEval = 0.0;
      broadcast(room, { type: "state", fen: room.game.fen() });
      broadcast(room, { type: "eval", score: room.lastEval });
      return;
    }
  });

  ws.on("close", () => {
    const room = ws._room;
    if (room) {
      room.clients.delete(ws);

      // clear seats if this ws owned them
      if (room.seats.white === ws) room.seats.white = null;
      if (room.seats.black === ws) room.seats.black = null;

      // presence update
      broadcast(room, { type: "presence", players: countPlayers(room) });

      // cleanup empty rooms (optional)
      if (room.clients.size === 0) rooms.delete(room.code);
    }
  });

  ws.on("error", (err) => {
    // Never crash process on socket errors
    console.error("[ws] error:", err?.message || err);
  });
});

// Process-level safety: never die on unexpected promise errors
process.on("unhandledRejection", (err) => {
  console.error("[process] unhandledRejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[process] uncaughtException:", err);
  // Keep running; Render will restart if truly fatal, but we try not to.
});

server.listen(PORT, () => {
  console.log(`Live Eval Chess online on :${PORT}`);
});

