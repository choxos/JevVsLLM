import { Chess, COLOR, EVAL_LEVELS, ENGINE_ELOS, OPENROUTER, jevPlayer, llmPlayer, stockfishPlayer, playGame, pgnOf, material } from "./chess-ai.js";
import { createBoard } from "./board.js";

const START = new Chess().fen();
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const app = $(".app");

/** Tiny element builder: h("div", {class: "x", onclick}, child, ...) */
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  el.append(...kids.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

/** replaceChildren that takes nested lists and skips null and false, like h() */
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((c) => c != null && c !== false));

const store = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(`jevchess.${k}`)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`jevchess.${k}`, JSON.stringify(v));
    } catch {}
  },
};

const S = {
  mode: "arena",
  keys: store.get("keys", { openrouter: "", typesafe: "" }),
  models: null,
  modelError: "",
  picks: new Set(store.get("picks", [])),
  elos: new Set(store.get("elos", [])),
  freeOnly: store.get("freeOnly", true),
  query: "",
  jevColor: store.get("jevColor", "w"),
  pace: store.get("pace", 700),
  humanColor: store.get("humanColor", "w"),
  showArrows: store.get("showArrows", true),
  run: null, // {games, controller, running}
  arenaShown: null,
  human: null, // {game, controller}
  saved: { list: null, query: "", game: null, error: "" },
  ply: null, // the move being viewed; null follows the game
  flipped: false, // the reader's flip on top of the automatic side
};

const shown = () => (S.mode === "arena" ? S.arenaShown : S.mode === "human" ? S.human?.game : S.saved.game);
const sideKey = (c) => (c === "w" ? "white" : "black");
const jevColorOf = (g) => (g.white.kind === "jev" ? "w" : "b");
const humanColorOf = (g) => (g.white.kind === "human" ? "w" : g.black.kind === "human" ? "b" : null);
const jevRoute = () => (S.keys.typesafe ? "typesafe" : S.keys.openrouter ? "openrouter" : null);
const fmtMs = (ms) => (ms == null ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
const fmtCost = (c) => (!c ? "free" : c < 0.01 ? `$${c.toFixed(4)}` : `$${c.toFixed(2)}`);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------
function jevSide() {
  const route = jevRoute();
  return { kind: "jev", name: "Jev", model: route === "typesafe" ? "jev-1.13.0" : "typesafe/jev-1.13", route };
}

function makeGame(white, black) {
  return { white, black, chess: new Chess(), moves: [], fens: [START], lasts: [null], status: "ready", result: "", reason: "", thinking: null, waiting: "", error: "", savedId: "" };
}

/** The squares a move touches, for highlighting and the slide: the rook too when castling. */
function lastOf(uci, san) {
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const rank = from[1];
  const rook = san.startsWith("O-O-O") ? { from: `a${rank}`, to: `d${rank}` } : san.startsWith("O-O") ? { from: `h${rank}`, to: `f${rank}` } : null;
  return { from, to, rook };
}

/** Rebuilds a game from its moves, for saved games. */
function replay(g, moves) {
  for (const m of moves) {
    const mv = g.chess.move(m.san);
    g.moves.push({ ...m, color: mv.color, uci: mv.from + mv.to + (mv.promotion || "") });
    g.fens.push(g.chess.fen());
    g.lasts.push(lastOf(mv.from + mv.to, mv.san));
  }
  return g;
}

function playerFor(side, signal, game) {
  if (side.kind === "jev") return jevPlayer({ route: side.route, key: side.route === "typesafe" ? S.keys.typesafe : S.keys.openrouter });
  if (side.kind === "llm") return llmPlayer({ key: S.keys.openrouter, model: side.model, reasoning: side.reasoning });
  if (side.kind === "engine") {
    return stockfishPlayer({
      elo: side.elo,
      open: () => {
        const w = new Worker("vendor/stockfish/stockfish-19-lite-single.js");
        return { post: (c) => w.postMessage(c), listen: (fn) => w.addEventListener("message", (e) => fn(e.data)), close: () => w.terminate() };
      },
    });
  }
  return {
    move: () =>
      new Promise((resolve, reject) => {
        game.resolve = resolve;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  };
}

let animateNext = null;
function changed(game, moved = false) {
  if (moved && game === shown() && S.ply === null) animateNext = game.lasts.at(-1);
  schedule();
}

async function runGame(game, signal) {
  const players = { w: playerFor(game.white, signal, game), b: playerFor(game.black, signal, game) };
  const human = humanColorOf(game);
  game.status = "running";
  try {
    const end = await playGame({
      players,
      chess: game.chess,
      signal,
      pause: () => (human ? 0 : S.pace),
      onThink: (color) => {
        game.thinking = { color, since: Date.now() };
        game.waiting = "";
        changed(game);
      },
      onWait: (color, ms, e) => {
        game.waiting = `${e.status === 429 ? "rate limited" : "busy"}, retrying in ${Math.round(ms / 1000)} s`;
        changed(game);
      },
      onMove: (m) => {
        game.moves.push(m);
        game.fens.push(game.chess.fen());
        game.lasts.push(lastOf(m.uci, m.san));
        game.thinking = null;
        game.waiting = "";
        changed(game, true);
      },
    });
    Object.assign(game, { status: "done", result: end.result, reason: end.reason, thinking: null });
    save(game);
  } catch (e) {
    game.thinking = null;
    game.resolve = null;
    if (game.status === "running") {
      if (signal.aborted) game.status = "stopped";
      else Object.assign(game, { status: "error", error: e.message || String(e) });
    }
  } finally {
    players.w.close?.();
    players.b.close?.();
    changed(game);
  }
}

async function save(game) {
  const side = ({ kind, name, model, route }) => ({ kind, name, model, route });
  const body = {
    white: side(game.white),
    black: side(game.black),
    reason: game.reason,
    moves: game.moves.map(({ san, ms, note, fallback, tries, confidence, top, eval: ev, cost, tokens }) => ({ san, ms, note, fallback, tries, confidence, top, eval: ev, cost, tokens })),
  };
  try {
    const r = await fetch("api/games", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    game.savedId = (await r.json()).id;
    S.saved.list = null; // refetch on the next visit
  } catch (e) {
    game.saveError = e.message;
  }
  changed(game);
}

// ---------------------------------------------------------------------------------------------
// Jev vs machines
// ---------------------------------------------------------------------------------------------
function opponents() {
  const engines = [...S.elos].sort((a, b) => a - b).map((elo) => ({ kind: "engine", name: `Stockfish ${elo}`, model: `stockfish-19-elo-${elo}`, elo }));
  const llms = [...S.picks].map((id) => {
    const m = S.models?.find((x) => x.id === id);
    return { kind: "llm", name: m?.name || id, model: id, reasoning: Boolean(m?.reasoning) };
  });
  return [...engines, ...llms];
}

function arenaProblem() {
  const opps = opponents();
  if (!opps.length) return null;
  if (!jevRoute()) return "Jev needs an OpenRouter key or a TypeSafe key.";
  if (opps.some((o) => o.kind === "llm") && !S.keys.openrouter) return "LLM opponents need an OpenRouter key.";
  return null;
}

function startArena() {
  if (S.run?.running) {
    S.run.controller.abort();
    return;
  }
  if (arenaProblem()) return openKeys();
  const colors = S.jevColor === "both" ? ["w", "b"] : [S.jevColor];
  const games = opponents().flatMap((o) => colors.map((c) => (c === "w" ? makeGame(jevSide(), o) : makeGame(o, jevSide()))));
  if (!games.length) return;
  const controller = new AbortController();
  S.run = { games, controller, running: true };
  S.arenaShown = games[0];
  S.ply = null;
  S.flipped = false;
  setPanel("info");
  schedule();
  Promise.allSettled(games.map((g) => runGame(g, controller.signal))).then(() => {
    S.run.running = false;
    schedule();
    if (games.some((g) => g.status === "done") && games.length > 1) showResults(games);
  });
}

function scoreFor(g) {
  if (g.status !== "done") return null;
  if (g.result === "1/2-1/2") return 0.5;
  return (g.result === "1-0") === (jevColorOf(g) === "w") ? 1 : 0;
}

function sideStats(g, color) {
  const ms = g.moves.filter((m) => m.color === color);
  return {
    ms: ms.length ? ms.reduce((n, m) => n + m.ms, 0) / ms.length : null,
    cost: ms.reduce((n, m) => n + (m.cost || 0), 0),
    fallbacks: ms.filter((m) => m.fallback).length,
  };
}

function showResults(games) {
  const rows = new Map();
  for (const g of games) {
    const jc = jevColorOf(g);
    const opp = g[sideKey(jc === "w" ? "b" : "w")];
    const r = rows.get(opp.name) || { opp, n: 0, w: 0, d: 0, l: 0, other: 0, jevMs: [], oppMs: [], fb: 0, cost: 0 };
    const s = scoreFor(g);
    r.n++;
    if (s === 1) r.w++;
    else if (s === 0.5) r.d++;
    else if (s === 0) r.l++;
    else r.other++;
    const js = sideStats(g, jc);
    const os = sideStats(g, jc === "w" ? "b" : "w");
    if (js.ms != null) r.jevMs.push(js.ms);
    if (os.ms != null) r.oppMs.push(os.ms);
    r.fb += os.fallbacks;
    r.cost += js.cost + os.cost;
    rows.set(opp.name, r);
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const total = games.reduce((n, g) => n + (scoreFor(g) ?? 0), 0);
  const played = games.filter((g) => g.status === "done").length;
  $("#resultsTitle").textContent = `Jev scored ${String(total).replace(".5", "½")} of ${played}`;
  fill($("#results"), 
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["Opponent", "Games", "Jev won", "Drawn", "Jev lost", "Jev / move", "Opponent / move", "Random fallbacks", "Cost"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        [...rows.values()].map((r) =>
          h(
            "tr",
            {},
            h("td", { class: "opp" }, r.opp.name),
            h("td", {}, r.other ? `${r.n} (${r.other} unfinished)` : r.n),
            h("td", {}, r.w),
            h("td", {}, r.d),
            h("td", {}, r.l),
            h("td", {}, fmtMs(avg(r.jevMs))),
            h("td", {}, fmtMs(avg(r.oppMs))),
            h("td", {}, r.opp.kind === "llm" ? r.fb : ""),
            h("td", {}, fmtCost(r.cost)),
          ),
        ),
      ),
    ),
  );
  $("#resultsDialog").showModal();
}

// ---------------------------------------------------------------------------------------------
// You vs Jev
// ---------------------------------------------------------------------------------------------
function newHumanGame() {
  if (!jevRoute()) return openKeys();
  if (S.human?.game.status === "running") S.human.controller.abort();
  const color = S.humanColor === "random" ? (Math.random() < 0.5 ? "w" : "b") : S.humanColor;
  const you = { kind: "human", name: "You" };
  const game = color === "w" ? makeGame(you, jevSide()) : makeGame(jevSide(), you);
  const controller = new AbortController();
  S.human = { game, controller };
  S.ply = null;
  S.flipped = false;
  runGame(game, controller.signal);
  schedule();
}

function resign() {
  const g = S.human?.game;
  if (!g || g.status !== "running") return;
  const human = humanColorOf(g);
  Object.assign(g, { status: "done", result: human === "w" ? "0-1" : "1-0", reason: "resignation", thinking: null });
  S.human.controller.abort();
  if (g.moves.length) save(g);
  schedule();
}

function onBoardMove(from, to, promotion) {
  const g = shown();
  if (!g?.resolve) return;
  const m = g.chess.moves({ verbose: true }).find((x) => x.from === from && x.to === to && (x.promotion || "") === (promotion || ""));
  if (!m) return;
  const resolve = g.resolve;
  g.resolve = null;
  resolve({ san: m.san });
}

// ---------------------------------------------------------------------------------------------
// Saved games
// ---------------------------------------------------------------------------------------------
async function loadSaved() {
  try {
    const r = await fetch("api/games?limit=500");
    if (!r.ok) throw new Error(r.statusText);
    S.saved.list = (await r.json()).games;
    S.saved.error = "";
  } catch {
    S.saved.list = [];
    S.saved.error = "Saved games are not available here.";
  }
  renderHistory();
}

async function openSaved(id) {
  try {
    const r = await fetch(`api/games/${id}`);
    if (!r.ok) throw new Error();
    const g = await r.json();
    const game = replay(makeGame(g.white, g.black), g.moves);
    Object.assign(game, { status: "done", result: g.result, reason: g.reason, savedId: g.id, savedAt: g.savedAt });
    S.saved.game = game;
    S.ply = null;
    S.flipped = false;
    animateNext = null;
    setPanel("info");
    schedule();
    renderHistory();
  } catch {
    toast("That game could not be loaded");
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------
const board = createBoard($("#board"), { onMove: onBoardMove });
let pending = false;
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    render();
  });
}

function autoFlip(g) {
  if (!g) return S.mode === "human" && S.humanColor === "b";
  const human = humanColorOf(g);
  return (human || jevColorOf(g)) === "b";
}
const isFlipped = (g) => autoFlip(g) !== S.flipped;
const viewPly = (g) => (S.ply == null ? g.moves.length : S.ply);

function outcome(g) {
  if (g.status === "error") return { title: "Stopped by an error", sub: g.error };
  if (g.status === "stopped") return { title: "Stopped", sub: `after ${plural(g.moves.length, "half-move")}` };
  if (g.status !== "done") return null;
  if (g.result === "1/2-1/2") return { title: "Draw", sub: `by ${g.reason}` };
  const winner = g.result === "1-0" ? g.white : g.black;
  const loser = g.result === "1-0" ? g.black : g.white;
  if (g.reason === "resignation") return { title: `${winner.name} win${winner.kind === "human" ? "" : "s"}`, sub: `${loser.name === "You" ? "you" : loser.name} resigned` };
  return { title: `${winner.name} win${winner.kind === "human" ? "" : "s"}`, sub: `by ${g.reason}` };
}

function resultBadge(g) {
  const s = scoreFor(g);
  if (s == null) return h("span", { class: "res" }, g.status === "running" ? "live" : g.status === "error" ? "error" : g.status === "stopped" ? "stopped" : "");
  return h("span", { class: `res ${s === 1 ? "win" : s === 0 ? "loss" : "draw"}`, title: "From Jev's side" }, g.result.replace("1/2", "½").replace("1/2", "½"));
}

function jevArrows(g, k) {
  if (!S.showArrows || !g || k < 1) return [];
  const m = g.moves[k - 1];
  if (!m?.top?.length || g[sideKey(m.color)].kind !== "jev") return [];
  const before = new Chess(g.fens[k - 1]);
  const byS = new Map(before.moves({ verbose: true }).map((x) => [x.san, x]));
  return m.top
    .filter(([, p]) => p >= 0.03)
    .map(([san, p]) => ({ ...byS.get(san), w: p, main: san === m.san }))
    .filter((a) => a.from);
}

function renderBoard(g) {
  const k = g ? viewPly(g) : 0;
  const fen = g ? g.fens[k] : START;
  const pos = new Chess(fen);
  let check = null;
  if (pos.inCheck()) for (const row of pos.board()) for (const p of row) if (p?.type === "k" && p.color === pos.turn()) check = p.square;
  let movable = null;
  if (g?.resolve && S.ply === null) {
    movable = new Map();
    for (const m of g.chess.moves({ verbose: true })) movable.set(m.from, [...(movable.get(m.from) || []), m]);
  }
  board.set({ fen, flip: isFlipped(g), last: g?.lasts[k] || null, check, movable, arrows: jevArrows(g, k) }, { animate: animateNext });
  animateNext = null;

  // Jev's read of the position: its latest evaluation up to this move
  const bar = $("#evalbar");
  const ev = g?.moves.slice(0, k).findLast((m) => typeof m.eval === "number")?.eval;
  bar.classList.toggle("flip", isFlipped(g));
  bar.classList.toggle("none", ev == null);
  bar.firstElementChild.style.height = `${ev == null ? 50 : Math.min(100, Math.max(0, (ev / 6) * 100))}%`;
  bar.title = ev == null ? "Jev's read of the position appears after its first move" : `Jev's read: ${EVAL_LEVELS[Math.round(ev)]}`;
  return pos;
}

function renderPlayers(g, pos) {
  const flip = isFlipped(g);
  const k = g ? viewPly(g) : 0;
  const diff = material(pos, "w") - material(pos, "b");
  for (const [el, color] of [
    [$("#playerTop"), flip ? "w" : "b"],
    [$("#playerBottom"), flip ? "b" : "w"],
  ]) {
    const p = g ? g[sideKey(color)] : color === "w" ? { kind: "jev", name: "Jev" } : { kind: "llm", name: "Opponent" };
    const stats = g ? sideStats(g, color) : { ms: null, cost: 0 };
    const lastNote = g?.moves.slice(0, k).findLast((m) => m.color === color)?.note;
    const sub =
      p.kind === "jev"
        ? `Jev 1.13 via ${p.route === "typesafe" ? "TypeSafe" : "OpenRouter"}`
        : p.kind === "engine"
          ? `Stockfish 19 lite at Elo ${p.elo || p.model.split("-").pop()}`
          : p.kind === "llm"
            ? lastNote || p.model
            : "";
    const thinking = g?.status === "running" && g.thinking?.color === color && S.ply === null;
    const adv = color === "w" ? diff : -diff;
    el.classList.toggle("turn", Boolean(thinking));
    fill(el, 
      h("div", { class: `avatar ${p.kind}` }, { jev: "J", llm: (p.name.split(":").pop().trim()[0] || "?").toUpperCase(), engine: "SF", human: "You" }[p.kind] || "?"),
      h("div", { class: "who" }, h("div", { class: "name" }, h("span", { class: `side ${color}`, title: COLOR[color] }), p.name), sub && h("div", { class: "sub", title: sub }, p.kind === "llm" && lastNote ? h("em", {}, `“${lastNote}”`) : sub)),
      h(
        "div",
        { class: "pstat" },
        thinking
          ? h("span", { class: `thinking${g.waiting ? " wait" : ""}`, "data-since": g.thinking.since }, g.waiting || (p.kind === "human" ? "your move" : "thinking"))
          : [adv > 0 && h("span", { class: "adv" }, `+${adv}`), stats.ms != null && h("span", {}, `${fmtMs(stats.ms)} avg${p.kind === "llm" || p.kind === "jev" ? ` · ${fmtCost(stats.cost)}` : ""}`)],
      ),
    );
  }
}

function renderMoves(g) {
  const box = $("#moves");
  if (!g) {
    const tips = {
      arena: ["Jev vs machines", "Pick Stockfish levels or LLMs, choose Jev's color and press Start. Every game runs at once; click a match to watch it. Finished games are saved."],
      human: ["You vs Jev", "Press New game. Jev answers in about a third of a second."],
      history: ["Saved games", "Every finished game lands here. Pick one to replay it move by move."],
    }[S.mode];
    fill(box, h("div", { class: "empty" }, h("b", {}, tips[0]), h("p", {}, tips[1])));
    return;
  }
  const k = viewPly(g);
  const grid = h("div", { class: "movegrid" });
  g.moves.forEach((m, i) => {
    if (i % 2 === 0) grid.append(h("span", { class: "no" }, `${i / 2 + 1}.`));
    grid.append(
      h(
        "button",
        { type: "button", class: `mv${m.fallback ? " fb" : ""}`, "aria-current": String(i + 1 === k), title: m.fallback ? "No legal move in the reply: a random legal move was played" : null, onclick: () => goto(i + 1) },
        m.san,
        m.ms != null && h("span", { class: "ms" }, fmtMs(m.ms)),
      ),
    );
  });
  fill(box, h("h3", { class: "label" }, "Moves"), grid);
  box.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
}

function renderDetail(g) {
  const box = $("#detail");
  const k = g ? viewPly(g) : 0;
  const m = g?.moves[k - 1];
  if (!m) return fill(box);
  const p = g[sideKey(m.color)];
  const no = `${Math.ceil(k / 2)}${m.color === "w" ? "." : "..."} ${m.san}`;
  const parts = [h("div", { class: "head" }, h("b", {}, no), h("span", {}, [p.name, fmtMs(m.ms), m.cost ? fmtCost(m.cost) : ""].filter(Boolean).join(" · ")))];
  if (p.kind === "jev" && m.top?.length) {
    parts.push(
      h(
        "div",
        { class: "bars" },
        m.top.map(([san, prob]) => h("div", { class: `bar${san === m.san ? " chosen" : ""}` }, h("b", {}, san), h("div", { class: "track" }, h("i", { style: `width:${Math.round(prob * 100)}%` })), h("span", {}, `${Math.round(prob * 100)}%`))),
      ),
    );
    if (typeof m.eval === "number") parts.push(h("p", { class: "hint", style: "margin-top:8px" }, `Jev's read: ${EVAL_LEVELS[Math.round(m.eval)]}`));
  } else if (m.fallback) parts.push(h("p", { class: "note warn" }, m.note || "No legal move in the reply; a random legal move was played."));
  else if (m.note) parts.push(h("p", { class: "note" }, `“${m.note}”`), m.tries > 1 && h("p", { class: "hint" }, `Legal on try ${m.tries}`));
  else if (p.kind === "engine") parts.push(h("p", { class: "hint" }, "Searched for 0.3 s at its set strength."));
  fill(box, ...parts);
}

function renderGamebar(g) {
  const box = $("#gamebar");
  if (!g) return fill(box);
  const o = outcome(g);
  const sans = g.moves.map((m) => m.san);
  const copyPgn = () =>
    navigator.clipboard
      .writeText(pgnOf({ white: g.white.name, black: g.black.name, sans, result: g.result || "*", date: g.savedAt ? new Date(g.savedAt) : new Date() }))
      .then(() => toast("PGN copied"), () => toast("Copy failed"));
  const copyLink = () => navigator.clipboard.writeText(`${location.origin}${location.pathname}?game=${g.savedId}`).then(() => toast("Link copied"), () => toast("Copy failed"));
  const running = g.status === "running";
  fill(box, 
    h(
      "div",
      { class: "outcome" },
      o ? [h("b", {}, o.title), h("span", {}, o.sub)] : [h("b", {}, running ? `${COLOR[g.chess.turn()]} to move` : ""), h("span", {}, `${plural(Math.ceil(g.moves.length / 2), "move")}`)],
      g.saveError && h("span", { style: "display:block;color:var(--warn)" }, "Not saved"),
    ),
    sans.length > 0 && h("button", { type: "button", class: "btn small", onclick: copyPgn }, "PGN"),
    g.savedId && h("button", { type: "button", class: "btn small", onclick: copyLink }, "Link"),
  );
}

function renderMatches() {
  const box = $("#matches");
  if (S.mode !== "arena" || !S.run) return fill(box);
  const done = S.run.games.filter((g) => g.status !== "running" && g.status !== "ready").length;
  fill(box, 
    h("h3", { class: "label" }, `Matches · ${done} of ${S.run.games.length} over`),
    S.run.games.map((g) =>
      h(
        "button",
        {
          type: "button",
          class: "match",
          "aria-current": String(g === S.arenaShown),
          onclick: () => {
            S.arenaShown = g;
            S.ply = null;
            S.flipped = false;
            animateNext = null;
            schedule();
          },
        },
        h("span", { class: `st ${g.status}` }),
        h("span", {}, h("div", { class: "title" }, `${g.white.name} vs ${g.black.name}`), h("div", { class: "meta" }, `Jev ${jevColorOf(g) === "w" ? "White" : "Black"} · ${plural(Math.ceil(g.moves.length / 2), "move")}${g.waiting ? ` · ${g.waiting}` : ""}`)),
        resultBadge(g),
      ),
    ),
  );
}

function renderNav(g) {
  const k = g ? viewPly(g) : 0;
  const n = g?.moves.length || 0;
  fill($("#navinfo"), !g ? "" : S.ply === null ? (g.status === "running" ? h("b", {}, "live") : `${plural(Math.ceil(n / 2), "move")}`) : `half-move ${k} of ${n}`);
  for (const b of $$("[data-nav]")) b.disabled = !g || (["start", "prev"].includes(b.dataset.nav) ? k === 0 : k === n);
}

function renderSetup() {
  // header and panels
  for (const b of $$(".modes button")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
  app.dataset.mode = S.mode;
  $("#keysDot").classList.toggle("ok", Boolean(S.keys.openrouter || S.keys.typesafe));
  const seg = (id, v) => $$(`#${id} button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === String(v))));
  seg("jevColor", S.jevColor);
  seg("pace", S.pace);
  seg("humanColor", S.humanColor);
  $("#showArrows").checked = S.showArrows;
  $("#freeOnly").checked = S.freeOnly;

  // arena
  const running = Boolean(S.run?.running);
  const nOpp = opponents().length;
  const nGames = nOpp * (S.jevColor === "both" ? 2 : 1);
  const start = $("#startBtn");
  start.textContent = running ? "Stop" : nGames ? `Start ${plural(nGames, "game")}` : "Start";
  start.classList.toggle("danger", running);
  start.classList.toggle("primary", !running);
  start.disabled = !running && !nGames;
  $("#pickSummary").textContent = nOpp ? `${plural(nOpp, "opponent")} picked${S.jevColor === "both" ? ", each played twice with colors swapped" : ""}.` : "Pick one or more opponents.";
  const problem = arenaProblem();
  const hint = $("#arenaHint");
  hint.hidden = !problem;
  if (problem) fill(hint, problem, " ", h("button", { type: "button", onclick: openKeys }, "Add a key"));
  for (const c of $$("#elos .chip")) c.setAttribute("aria-pressed", String(S.elos.has(Number(c.dataset.elo))));

  // human
  const hg = S.human?.game;
  $("#resignBtn").disabled = !(hg?.status === "running" && hg.moves.length);
  const hh = $("#humanHint");
  hh.hidden = Boolean(jevRoute());
  if (!jevRoute()) fill(hh, "Jev needs an OpenRouter key or a TypeSafe key.", " ", h("button", { type: "button", onclick: openKeys }, "Add a key"));
}

function render() {
  const g = shown();
  renderSetup();
  const pos = renderBoard(g);
  renderPlayers(g, pos);
  renderMatches();
  renderMoves(g);
  renderDetail(g);
  renderGamebar(g);
  renderNav(g);
}

function renderModels() {
  const box = $("#models");
  if (!S.models) return fill(box, h("p", { class: "empty" }, S.modelError || "Loading models…"));
  const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  const list = S.models
    .filter((m) => S.picks.has(m.id) || ((!S.freeOnly || m.free) && words.every((w) => m.search.includes(w))))
    .sort((a, b) => S.picks.has(b.id) - S.picks.has(a.id) || a.name.localeCompare(b.name));
  if (!list.length) return fill(box, h("p", { class: "empty" }, "No model matches."));
  fill(box, 
    ...list.map((m) =>
      h(
        "div",
        {
          class: "model",
          role: "option",
          "aria-selected": String(S.picks.has(m.id)),
          title: m.id,
          onclick: () => {
            S.picks.has(m.id) ? S.picks.delete(m.id) : S.picks.add(m.id);
            store.set("picks", [...S.picks]);
            renderModels();
            schedule();
          },
        },
        h("input", { type: "checkbox", tabindex: "-1", checked: S.picks.has(m.id) }),
        h("div", { style: "min-width:0" }, h("div", { class: "name" }, m.name), h("div", { class: "id" }, m.id)),
        m.free ? h("span", { class: "price free" }, "Free") : h("span", { class: "price", title: "Input and output price per million tokens" }, m.price),
      ),
    ),
  );
}

function renderHistory() {
  const box = $("#history");
  const list = S.saved.list;
  if (!list) return fill(box, h("p", { class: "empty" }, "Loading…"));
  const words = S.saved.query.toLowerCase().split(/\s+/).filter(Boolean);
  const games = list.filter((g) => words.every((w) => `${g.white.name} ${g.black.name} ${g.white.model} ${g.black.model}`.toLowerCase().includes(w)));
  const score = (g) => (g.result === "1/2-1/2" ? 0.5 : (g.result === "1-0") === (g.white.kind === "jev") ? 1 : 0);
  const count = (v) => games.filter((g) => score(g) === v).length;
  fill($("#record"), 
    ...[
      [games.length, "games"],
      [count(1), "Jev won"],
      [count(0.5), "drawn"],
      [count(0), "Jev lost"],
    ].map(([n, t]) => h("div", {}, h("b", {}, n), h("span", {}, t))),
  );
  if (!games.length) return fill(box, h("p", { class: "empty" }, S.saved.error || (list.length ? "No game matches." : "No games yet. Finished games appear here.")));
  fill(box, 
    ...games.map((g) => {
      const s = score(g);
      return h(
        "button",
        { type: "button", class: "hgame", "aria-current": String(S.saved.game?.savedId === g.id), onclick: () => openSaved(g.id) },
        h("span", { class: "title" }, `${g.white.name} vs ${g.black.name}`),
        h("span", { class: `res ${s === 1 ? "win" : s === 0 ? "loss" : "draw"}`, title: "From Jev's side" }, g.result.replace("1/2-1/2", "½-½")),
        h("span", { class: "meta" }, `${g.reason} · ${plural(Math.ceil(g.plies / 2), "move")} · ${new Date(g.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`),
      );
    }),
  );
}

// thinking clocks tick without a full render
setInterval(() => {
  for (const el of $$(".thinking[data-since]")) {
    if (el.classList.contains("wait")) continue;
    const s = (Date.now() - Number(el.dataset.since)) / 1000;
    const base = el.textContent.split(" ")[0] === "your" ? "your move" : "thinking";
    el.textContent = s >= 1 ? `${base} ${s.toFixed(0)} s` : base;
  }
}, 250);

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------
function setMode(mode) {
  S.mode = mode;
  S.ply = null;
  S.flipped = false;
  animateNext = null;
  if (mode === "history" && !S.saved.list) loadSaved();
  setPanel(shown() ? "info" : "setup");
  schedule();
}

function setPanel(p) {
  app.dataset.panel = p;
  for (const b of $$(".ptabs button")) b.setAttribute("aria-pressed", String(b.dataset.panel === p));
}

function goto(k) {
  const g = shown();
  if (!g) return;
  const n = g.moves.length;
  k = Math.max(0, Math.min(n, k));
  animateNext = S.ply !== null && k === (S.ply ?? n) + 1 ? g.lasts[k] : null;
  S.ply = k === n ? null : k;
  schedule();
}

function openKeys() {
  $("#orKey").value = S.keys.openrouter;
  $("#tsKey").value = S.keys.typesafe;
  $("#keysDialog").showModal();
}

$$(".modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
$$(".ptabs button").forEach((b) => b.addEventListener("click", () => setPanel(b.dataset.panel)));
$("#keysBtn").addEventListener("click", openKeys);
$("#saveKeys").addEventListener("click", () => {
  S.keys = { openrouter: $("#orKey").value.trim(), typesafe: $("#tsKey").value.trim() };
  store.set("keys", S.keys);
  toast("Keys saved in this browser");
  schedule();
});
$("#forgetKeys").addEventListener("click", () => {
  S.keys = { openrouter: "", typesafe: "" };
  store.set("keys", S.keys);
  $("#orKey").value = $("#tsKey").value = "";
  $("#keysDialog").close();
  toast("Keys removed from this browser");
  schedule();
});

const segment = (id, key, parse = (v) => v) =>
  $$(`#${id} button`).forEach((b) =>
    b.addEventListener("click", () => {
      S[key] = parse(b.dataset.v);
      store.set(key, S[key]);
      schedule();
    }),
  );
segment("jevColor", "jevColor");
segment("pace", "pace", Number);
segment("humanColor", "humanColor");

$("#elos").append(
  ...ENGINE_ELOS.map((elo) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        "data-elo": elo,
        title: elo === 3190 ? "Full strength of the lite engine" : `Plays at about Elo ${elo}`,
        onclick: () => {
          S.elos.has(elo) ? S.elos.delete(elo) : S.elos.add(elo);
          store.set("elos", [...S.elos]);
          schedule();
        },
      },
      elo === 3190 ? "Max" : elo,
    ),
  ),
);
$("#clearPicks").addEventListener("click", () => {
  S.picks.clear();
  S.elos.clear();
  store.set("picks", []);
  store.set("elos", []);
  renderModels();
  schedule();
});
$("#modelSearch").addEventListener("input", (e) => ((S.query = e.target.value), renderModels()));
$("#freeOnly").addEventListener("change", (e) => {
  S.freeOnly = e.target.checked;
  store.set("freeOnly", S.freeOnly);
  renderModels();
});
$("#startBtn").addEventListener("click", startArena);
$("#newGameBtn").addEventListener("click", newHumanGame);
$("#resignBtn").addEventListener("click", resign);
$("#showArrows").addEventListener("change", (e) => {
  S.showArrows = e.target.checked;
  store.set("showArrows", S.showArrows);
  schedule();
});
$("#historySearch").addEventListener("input", (e) => ((S.saved.query = e.target.value), renderHistory()));
$("#flipBtn").addEventListener("click", () => ((S.flipped = !S.flipped), schedule()));
$$("[data-nav]").forEach((b) =>
  b.addEventListener("click", () => {
    const g = shown();
    if (!g) return;
    const k = viewPly(g);
    goto({ start: 0, prev: k - 1, next: k + 1, end: g.moves.length }[b.dataset.nav]);
  }),
);
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
  const g = shown();
  if (e.key === "f") return (S.flipped = !S.flipped), schedule();
  if (!g) return;
  const k = viewPly(g);
  const to = { ArrowLeft: k - 1, ArrowRight: k + 1, Home: 0, End: g.moves.length }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  goto(to);
});

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------
fetch(`${OPENROUTER}/api/v1/models`)
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
  .then(({ data }) => {
    const perM = (v) => Number(v) * 1e6;
    S.models = data
      // text in, text out; music models such as Lyria answer with audio
      .filter((m) => m.architecture?.input_modalities?.includes("text") && m.architecture?.output_modalities?.includes("text") && !m.architecture.output_modalities.includes("audio"))
      .map((m) => {
        const pIn = perM(m.pricing?.prompt);
        const pOut = perM(m.pricing?.completion);
        const free = pIn === 0 && pOut === 0;
        const fmt = (v) => (v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(2));
        return {
          id: m.id,
          name: (m.name || m.id).replace(/\s*\(free\)$/i, ""),
          free,
          price: pIn < 0 || pOut < 0 ? "varies" : `$${fmt(pIn)} / $${fmt(pOut)}`,
          reasoning: (m.supported_parameters || []).includes("reasoning"),
          search: `${m.name} ${m.id}`.toLowerCase(),
        };
      });
    renderModels();
    schedule();
  })
  .catch(() => {
    S.modelError = "OpenRouter's model list did not load. Reload the page to try again.";
    renderModels();
  });

const linked = new URLSearchParams(location.search).get("game");
if (/^[0-9a-f]{12}$/.test(linked || "")) {
  setMode("history");
  openSaved(linked);
} else setMode(S.mode);
renderModels();
