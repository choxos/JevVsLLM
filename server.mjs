/**
 * Serves the page in docs/ (nginx does that in production), relays the model calls, and keeps
 * finished games.
 *
 *   POST /v1/systemone         Jev at TypeSafe, which refuses requests from browser pages
 *   POST /v1/openrouter/chat   an LLM's move at OpenRouter
 *   POST /v1/openrouter/jev    Jev at OpenRouter
 *   GET  /api/config           whether this site lends its own keys, and what is left today
 *   POST /api/games            store one finished game, after replaying every move with chess.js
 *   GET  /api/games            the latest games, newest first, without their moves
 *   GET  /api/games/<id>       one game with its moves
 *   GET  /api/stats            Jev's results against humans, LLMs and engines, and each opponent
 *
 * A visitor with a key of their own sends it, and it is passed on and forgotten. Without one, the
 * site lends the keys in its .env, which stay on this machine: they are never sent to the page.
 * What the site lends is capped per day and per visitor, in Jev tokens, LLM requests and dollars
 * of OpenRouter credit, and a model dearer than a set price is not lent at all.
 *
 * API keys are never stored or logged, and a saved game is rebuilt field by field from what a game
 * needs, so nothing else a page sends (a key included) can reach the disk.
 *
 * Settings come from the environment or .env beside this file (see .env.example):
 *   PORT                listening port on 127.0.0.1 (default 3141)
 *   DATA_DIR            where games are kept (default ./data)
 *   TYPESAFE_API_KEY    lent to visitors without a TypeSafe key
 *   OPENROUTER_API_KEY  lent to visitors without an OpenRouter key, for free models only
 *   DAILY_TOKEN_BUDGET  TypeSafe input tokens the site lends per UTC day (default 20 million,
 *                       about $0.84; 0 lends none)
 *   DAILY_LLM_BUDGET    OpenRouter requests the site lends per UTC day (default 3000)
 *   DAILY_LLM_SPEND     dollars of OpenRouter credit the site lends per UTC day (default 0.5)
 *   MAX_MODEL_PRICE     dearest model the site lends, in dollars per million tokens (default 0.5,
 *                       which lets a whole game fit inside one visitor's share)
 *   VISITOR_SHARE       the share of a day's lending one visitor may take (default 0.25)
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
const OPENROUTER = "https://openrouter.ai";
const UPSTREAM = {
  "/v1/systemone": TYPESAFE_URL,
  "/v1/openrouter/jev": `${OPENROUTER}/api/alpha/decisions`,
  "/v1/openrouter/chat": `${OPENROUTER}/api/v1/chat/completions`,
};
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

// ---------------------------------------------------------------------------------------------
// The keys this site lends, and what it lends them for
// ---------------------------------------------------------------------------------------------
const lending = { typesafe: "", openrouter: "" };
// price is per million tokens: at 0.5 a whole game (about 250k tokens) fits one visitor's share
const limits = { tokens: 20_000_000, requests: 3000, spend: 0.5, price: 0.5, share: 0.25 };
const used = { day: "", tokens: 0, requests: 0, spend: 0, byVisitor: new Map() };
const SALT = crypto.randomBytes(16); // visitors are counted by a hash that dies with the process
let models = { at: 0, price: null }; // what each OpenRouter model costs, refreshed hourly

export function lend({ typesafe = "", openrouter = "", tokens, requests, spend, price, share } = {}) {
  Object.assign(lending, { typesafe, openrouter });
  for (const [k, v] of Object.entries({ tokens, requests, spend, price })) if (Number.isFinite(v)) limits[k] = v;
  if (Number.isFinite(share)) limits.share = Math.min(1, Math.max(0.01, share));
}

/** Resets the day's counters at midnight UTC. */
function day() {
  const today = new Date().toISOString().slice(0, 10);
  if (used.day !== today) Object.assign(used, { day: today, tokens: 0, requests: 0, spend: 0, byVisitor: new Map() });
  return used;
}

const visitorOf = (req) => crypto.createHash("sha256").update(SALT).update(String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")).digest("hex").slice(0, 16);

/** What a million input tokens costs at each OpenRouter model, so a dear one is not played by mistake. */
async function priceList() {
  if (models.price && Date.now() - models.at < 3600_000) return models.price;
  try {
    const r = await fetch(`${OPENROUTER}/api/v1/models`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(r.statusText);
    const { data } = await r.json();
    // a model that names no price (it routes wherever it likes) keeps its -1 and is not lent
    const per = (m) => (Number(m.pricing?.prompt) < 0 || Number(m.pricing?.completion) < 0 ? -1 : Math.max(Number(m.pricing?.prompt) || 0, (Number(m.pricing?.completion) || 0) / 4) * 1e6);
    models = { at: Date.now(), price: new Map(data.map((m) => [m.id, per(m)])) };
  } catch {
    if (!models.price) models = { at: Date.now() - 3540_000, price: new Map() }; // try again in a minute
  }
  return models.price;
}

/** Whether this borrowed request may go ahead; a string says why not. */
async function borrow(visitor, pathname, body) {
  const u = day();
  const mine = u.byVisitor.get(visitor) || { tokens: 0, requests: 0 };
  u.byVisitor.set(visitor, mine);
  const typesafe = pathname === "/v1/systemone";
  if (!typesafe && pathname === "/v1/openrouter/jev" && lending.typesafe) return "Jev costs money on OpenRouter: this site plays Jev on its TypeSafe key instead.";
  if (typesafe) {
    if (u.tokens >= limits.tokens) return "The site's Jev key has done its day's work. Add your own key in API keys, or come back tomorrow.";
    if (mine.tokens >= limits.tokens * limits.share) return "You have used your share of the site's Jev key today. Add your own key in API keys to keep playing.";
    return null;
  }
  const ended = "Add your own key in API keys, or come back tomorrow.";
  if (u.requests >= limits.requests || u.spend >= limits.spend) return `The site's OpenRouter key has done its day's work. ${ended}`;
  if (mine.requests >= limits.requests * limits.share || mine.spend >= limits.spend * limits.share) return "You have used your share of the site's OpenRouter key today. Add your own key in API keys to keep playing.";
  if (pathname === "/v1/openrouter/chat") {
    let model = "";
    try {
      model = String(JSON.parse(body).model || "");
    } catch {}
    const price = (await priceList()).get(model);
    if (price === undefined) return `${model || "That model"} is not one OpenRouter lists. Pick another, or add your own key in API keys.`;
    if (price < 0) return `${model} names no price, since it routes to whichever model it likes, so it needs your own key. Add one in API keys.`;
    if (price > limits.price) return `${model} costs $${price.toFixed(2)} a million tokens, more than this site lends. Pick a cheaper model, or add your own key in API keys.`;
  }
  return null;
}

/** Counts what a borrowed answer cost, so a day's lending can end. */
function spend(pathname, out, visitor) {
  const u = day();
  const mine = u.byVisitor.get(visitor) || null;
  if (pathname === "/v1/systemone") {
    let tokens = 0;
    try {
      tokens = JSON.parse(out).usage?.input_tokens || 0;
    } catch {}
    u.tokens += tokens;
    if (mine) mine.tokens += tokens;
    return;
  }
  u.requests += 1;
  if (mine) mine.requests += 1;
  let cost = 0;
  try {
    cost = Number(JSON.parse(out).usage?.cost) || 0; // free models cost nothing and add nothing
  } catch {}
  u.spend += cost;
  if (mine) mine.spend = (mine.spend || 0) + cost;
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

    if (UPSTREAM[url.pathname]) {
      if (req.method !== "POST") return json(res, 405, { detail: "POST only" });
      const jev = url.pathname !== "/v1/openrouter/chat";
      const mine = Boolean(req.headers.authorization); // the visitor brought a key of their own
      const lent = jev && url.pathname === "/v1/systemone" ? lending.typesafe : lending.openrouter;
      if (!mine && !lent) return json(res, 401, { detail: `This site has no ${jev ? "TypeSafe" : "OpenRouter"} key to lend: add your own in API keys` });
      let body;
      try {
        body = await readBody(req);
      } catch {
        return json(res, 413, { detail: "Request too large" });
      }
      const visitor = mine ? "" : visitorOf(req);
      if (!mine) {
        const stop = await borrow(visitor, url.pathname, body);
        // 402, not 429: waiting will not help, so the page says so at once instead of retrying
        if (stop) return json(res, 402, { detail: stop });
      }
      // A page that stops a game drops its request; stop the model's too
      const gone = new AbortController();
      res.on("close", () => gone.abort());
      try {
        const r = await fetch(UPSTREAM[url.pathname], {
          method: "POST",
          headers: { Authorization: mine ? req.headers.authorization : `Bearer ${lent}`, "Content-Type": "application/json", ...(jev && url.pathname !== "/v1/systemone" ? { "X-Title": "Jev Chess" } : {}) },
          body,
          signal: AbortSignal.any([gone.signal, AbortSignal.timeout(120_000)]),
        });
        const out = Buffer.from(await r.arrayBuffer());
        if (!mine && r.ok) spend(url.pathname, out, visitor);
        const retry = r.headers.get("retry-after");
        return send(res, r.status, r.headers.get("content-type") || "application/json", out, retry ? { "Retry-After": retry } : {});
      } catch (err) {
        return json(res, 502, { detail: `The model could not be reached: ${err.message}` });
      }
    }

    if (url.pathname === "/api/config" && req.method === "GET") {
      day();
      return json(res, 200, {
        lends: { typesafe: Boolean(lending.typesafe), openrouter: Boolean(lending.openrouter) },
        left: {
          tokens: Math.max(0, limits.tokens - used.tokens),
          requests: Math.max(0, limits.requests - used.requests),
          spend: Math.round(Math.max(0, limits.spend - used.spend) * 1000) / 1000,
        },
        limits: { tokens: limits.tokens, requests: limits.requests, spend: limits.spend, price: limits.price },
      });
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
  const envFile = path.join(here, ".env"); // keys live here, never in the page or in git
  if (fs.existsSync(envFile)) {
    for (const m of fs.readFileSync(envFile, "utf8").matchAll(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/gm)) process.env[m[1]] ??= m[2];
  }
  const port = Number(process.env.PORT || 3141);
  lend({
    typesafe: process.env.TYPESAFE_API_KEY || "",
    openrouter: process.env.OPENROUTER_API_KEY || "",
    tokens: Number(process.env.DAILY_TOKEN_BUDGET ?? 20_000_000),
    requests: Number(process.env.DAILY_LLM_BUDGET ?? 3000),
    spend: Number(process.env.DAILY_LLM_SPEND ?? 0.5),
    price: Number(process.env.MAX_MODEL_PRICE ?? 0.5),
    share: Number(process.env.VISITOR_SHARE ?? 0.25),
  });
  createServer({ dataDir: process.env.DATA_DIR || undefined }).listen(port, "127.0.0.1", () => {
    console.log(`Jev Chess: http://localhost:${port}/`);
    const lends = [process.env.TYPESAFE_API_KEY && "TypeSafe", process.env.OPENROUTER_API_KEY && "OpenRouter"].filter(Boolean);
    console.log(lends.length ? `Lending its own ${lends.join(" and ")} key, capped per day` : "No key of its own: visitors bring their own");
  });
}
