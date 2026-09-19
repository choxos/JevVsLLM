/**
 * Serves the page in docs/ (nginx does that in production), relays Jev calls made with a TypeSafe
 * key, and keeps finished games.
 *
 *   POST /v1/systemone    passed to TypeSafe with the visitor's own key: TypeSafe refuses
 *                         requests from browser pages, OpenRouter does not, so only this route
 *                         needs a relay
 *   POST /api/games       store one finished game, after replaying every move with chess.js
 *   GET  /api/games       the latest games, newest first, without their moves
 *   GET  /api/games/<id>  one game with its moves
 *   GET  /api/stats       Jev's results against humans, LLMs and engines, and each opponent
 *
 * API keys are never stored or logged. The relay hands the Authorization header to TypeSafe and
 * forgets it, and a saved game is rebuilt field by field from what a game needs, so nothing else
 * a page sends (a key included) can reach the disk.
 *
 *   node server.mjs            PORT (default 3141) and DATA_DIR (default ./data) from the environment
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Chess, gameEnd, PLY_CAP } from "./docs/chess-ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "docs");
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MAX_BODY = 1_000_000;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...headers });
  if (body?.pipe) body.pipe(res);
  else res.end(body);
}
const json = (res, status, data) => send(res, status, "application/json", JSON.stringify(data));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("too large")), req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------
const str = (v, n) => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : null);
const MODEL_ID = /^[\w.:/~@+-]{1,120}$/;

function side(p) {
  const kind = ["jev", "llm", "engine", "human"].includes(p?.kind) ? p.kind : null;
  return {
    kind,
    name: str(p?.name, 80) || (kind === "human" ? "You" : ""),
    model: typeof p?.model === "string" && MODEL_ID.test(p.model) ? p.model : "",
    route: kind === "jev" && ["openrouter", "typesafe"].includes(p?.route) ? p.route : "",
  };
}

function move(m) {
  const out = { san: str(m?.san, 12) };
  for (const k of ["ms", "confidence", "eval", "cost", "tokens", "tries"]) if (num(m?.[k]) !== null) out[k] = num(m[k]);
  if (m?.fallback === true) out.fallback = true;
  if (str(m?.note, 300)) out.note = str(m.note, 300);
  if (Array.isArray(m?.top)) out.top = m.top.slice(0, 4).map((t) => [str(t?.[0], 12), num(t?.[1]) ?? 0]);
  return out;
}

/**
 * A finished game rebuilt from a page's report, or {error}. Every move must be legal, and the
 * result is the one the final position gives; only a resignation (by the human) ends a game
 * early.
 */
export function cleanGame(g) {
  if (!g || typeof g !== "object") return { error: "Not a game" };
  const white = side(g.white);
  const black = side(g.black);
  if (!white.kind || !black.kind) return { error: "Unknown player" };
  if (white.kind !== "jev" && black.kind !== "jev") return { error: "Jev plays in every game" };
  const mode = white.kind === "human" || black.kind === "human" ? "human" : "arena";
  if (!Array.isArray(g.moves) || !g.moves.length || g.moves.length > PLY_CAP) return { error: "Bad move list" };

  const chess = new Chess();
  const moves = g.moves.map(move);
  for (const m of moves) {
    if (gameEnd(chess)) return { error: "Moves after the end of the game" };
    try {
      m.san = chess.move(m.san).san;
    } catch {
      return { error: `Illegal move: ${m.san}` };
    }
  }
  let end = gameEnd(chess);
  if (!end) {
    const human = white.kind === "human" ? "w" : black.kind === "human" ? "b" : "";
    if (g.reason !== "resignation" || !human) return { error: "The game is not over" };
    end = { result: human === "w" ? "0-1" : "1-0", reason: "resignation" };
  }
  return {
    game: {
      id: crypto.randomBytes(6).toString("hex"),
      savedAt: new Date().toISOString(),
      mode,
      white,
      black,
      result: end.result,
      reason: end.reason,
      plies: moves.length,
      moves,
    },
  };
}

/** Jev's results against humans, LLMs and engines, and against each opponent. */
export function stats(games) {
  const blank = () => ({ games: 0, won: 0, drawn: 0, lost: 0 });
  const groups = { human: blank(), llm: blank(), engine: blank() };
  const rows = new Map();
  for (const g of games) {
    const jev = g.white.kind === "jev" ? "w" : "b";
    const opp = jev === "w" ? g.black : g.white;
    if (!groups[opp.kind]) continue; // Jev against itself counts for neither side
    const outcome = g.result === "1/2-1/2" ? "drawn" : (g.result === "1-0") === (jev === "w") ? "won" : "lost";
    const key = opp.kind === "human" ? "human" : `${opp.kind}:${opp.model || opp.name}`;
    const row = rows.get(key) || { kind: opp.kind, name: opp.kind === "human" ? "Humans" : opp.name || opp.model, model: opp.model, ...blank() };
    for (const r of [groups[opp.kind], row]) r.games++, r[outcome]++;
    rows.set(key, row);
  }
  return { groups, opponents: [...rows.values()].sort((a, b) => b.games - a.games || a.name.localeCompare(b.name)) };
}

// ponytail: every list and lookup reads the whole file; move to SQLite once it holds tens of thousands of games.
function readGames(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function createServer({ dataDir = path.join(here, "data") } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "games.jsonl");

  return http.createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      // Hostile input must never take the process down
      if (!res.headersSent) json(res, 400, { detail: "Bad request" });
      else res.destroy();
    }
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    // Only this site's own pages may post: a foreign page's Origin names another host
    if (req.method === "POST" && req.headers.origin) {
      let host = "";
      try {
        host = new URL(req.headers.origin).host;
      } catch {}
      if (host !== req.headers.host) return json(res, 403, { detail: "Foreign origin" });
    }

    if (url.pathname === "/v1/systemone") {
      if (req.method !== "POST") return json(res, 405, { detail: "POST only" });
      if (!req.headers.authorization) return json(res, 401, { detail: "Add your TypeSafe key first" });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 413, { detail: "Request too large" });
      }
      // A page that stops a game drops its request; stop TypeSafe's too
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      try {
        const r = await fetch(TYPESAFE_URL, {
          method: "POST",
          headers: { Authorization: req.headers.authorization, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.any([gone.signal, AbortSignal.timeout(30_000)]),
        });
        const retry = r.headers.get("retry-after");
        return send(res, r.status, r.headers.get("content-type") || "application/json", Buffer.from(await r.arrayBuffer()), retry ? { "Retry-After": retry } : {});
      } catch (err) {
        return json(res, 502, { detail: `TypeSafe unreachable: ${err.message}` });
      }
    }

    if (url.pathname === "/api/games" && req.method === "POST") {
      let g;
      try {
        g = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { detail: "Send one game as JSON" });
      }
      const { game, error } = cleanGame(g);
      if (error) return json(res, 422, { detail: error });
      fs.appendFileSync(file, JSON.stringify(game) + "\n");
      return json(res, 201, { id: game.id });
    }
    if (url.pathname === "/api/games" && req.method === "GET") {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 200));
      const games = readGames(file)
        .reverse()
        .slice(0, limit)
        .map(({ moves, ...summary }) => summary);
      return json(res, 200, { games });
    }
    if (url.pathname === "/api/stats" && req.method === "GET") return json(res, 200, stats(readGames(file)));
    const one = /^\/api\/games\/([0-9a-f]{12})$/.exec(url.pathname);
    if (one && req.method === "GET") {
      const game = readGames(file).find((g) => g.id === one[1]);
      return game ? json(res, 200, game) : json(res, 404, { detail: "No such game" });
    }

    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "text/plain", "Method not allowed");
    let target;
    try {
      target = path.join(ROOT, decodeURIComponent(url.pathname));
    } catch {
      return send(res, 400, "text/plain", "Bad path");
    }
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return send(res, 403, "text/plain", "Forbidden");
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "index.html");
    if (!fs.existsSync(target)) return send(res, 404, "text/plain", "Not found");
    send(res, 200, TYPES[path.extname(target)] || "application/octet-stream", fs.createReadStream(target));
  }
}

// Start when run directly, or by pm2, which loads ES modules through its own script.
const entry = process.env.pm_exec_path || process.argv[1];
if (entry && pathToFileURL(path.resolve(entry)).href === import.meta.url) {
  const port = Number(process.env.PORT || 3141);
  createServer({ dataDir: process.env.DATA_DIR || undefined }).listen(port, "127.0.0.1", () => console.log(`Jev Chess: http://localhost:${port}/`));
}
