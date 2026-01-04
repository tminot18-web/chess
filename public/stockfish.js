/* public/stockfish.js
 *
 * Stockfish engine bundle for browser workers.
 * We load it via importScripts from a stable CDN that actually hosts the worker file.
 *
 * NOTE: This file runs INSIDE a Worker (same-origin), so it bypasses cross-origin Worker restrictions.
 */

self.Module = self.Module || {};

// Use a known-good hosted build:
importScripts("https://unpkg.com/stockfish@16.0.0/stockfish.js");

