/**
 * Everything the players see and the game loop, with no DOM, shared by the page, the server and
 * the tests.
 *
 * Code owns the chess: chess.js lists the legal moves, and code describes each one in words
 * (captures, checks, whether the piece is safe, what it leaves hanging, whether it allows mate).
 * Jev answers one Choice over those moves; an LLM gets the same list in a prompt and names a move.
 * Both see the same facts, so the game compares judgment, not arithmetic.
 */
import { Chess } from "./vendor/chess.js";

export { Chess };

export const JEV = {
  openrouter: "typesafe/jev-1.13", // OpenRouter's Decisions API
  typesafe: "jev-1.13.0", // TypeSafe's own API, pinned like the OpenRouter copy
  pricePerToken: 0.042e-6, // input tokens only; output is free
};
export const OPENROUTER = "https://openrouter.ai";
export const PLY_CAP = 200; // 100 moves each, then the game is drawn
const LLM_TIMEOUT_MS = 120_000;
const LLM_ATTEMPTS = 3; // replies without a legal move before a random legal move is played

const NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const PLURAL = { p: "Pawns", n: "Knights", b: "Bishops", r: "Rooks", q: "Queens", k: "King" };
const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
export const COLOR = { w: "White", b: "Black" };
const other = (c) => (c === "w" ? "b" : "w");
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);
export const uci = (m) => m.from + m.to + (m.promotion || "");

// ---------------------------------------------------------------------------------------------
// Position facts, in words
// ---------------------------------------------------------------------------------------------
function squares(chess, color) {
  const out = [];
  for (const row of chess.board()) for (const p of row) if (p && (!color || p.color === color)) out.push(p);
  return out;
}

export function material(chess, color) {
  return squares(chess, color).reduce((n, p) => n + VALUES[p.type], 0);
}

function materialWords(chess, us) {
  const d = material(chess, us) - material(chess, other(us));
  if (!d) return "Material is even.";
  const n = Math.abs(d);
  return `${COLOR[us]} is ${d > 0 ? "ahead" : "behind"} by ${n} point${n > 1 ? "s" : ""} of material.`;
}

/** The square a capture empties: for en passant, the passed pawn's square, not the one moved to. */
const takenFrom = (r) => (r.flags.includes("e") ? r.to[0] + r.from[1] : r.to);

/** The legal captures of the piece on `sq`, cheapest capturing piece first. */
const takersOf = (replies, sq) => replies.filter((r) => r.captured && takenFrom(r) === sq).sort((a, b) => (VALUES[a.piece] || 99) - (VALUES[b.piece] || 99));

/** The position with the other side to move, to list its threats; null when that cannot be set up. */
function theirTurn(chess) {
  const f = chess.fen().split(" ");
  f[1] = other(f[1]);
  f[3] = "-";
  try {
    return new Chess(f.join(" "));
  } catch {
    return null;
  }
}

/**
 * Pieces of `color` (not the king) that the other side can win with a legal capture: undefended,
 * or taken by something cheaper. `replies` are the other side's legal moves in `chess`, where it is
 * the other side's turn; without them, attacks are counted as the pieces stand, pins included.
 */
function loosePieces(chess, color, replies) {
  return squares(chess, color)
    .filter((p) => p.type !== "k")
    .filter((p) => {
      if (replies) {
        const takers = takersOf(replies, p.square);
        return Boolean(takers.length) && ((VALUES[takers[0].piece] || 99) < VALUES[p.type] || !canRetake(chess, takers[0], color));
      }
      const attackers = chess.attackers(p.square, other(color));
      if (!attackers.length) return false;
      const cheapest = Math.min(...attackers.map((s) => VALUES[chess.get(s).type] || 99));
      return !chess.attackers(p.square, color).length || cheapest < VALUES[p.type];
    });
}

/**
 * Whether `color` could take back after the capture `r`, on the square the capturer lands on (en
 * passant lands off the taken pawn's square), with a legal move: a pinned piece does not defend.
 */
function canRetake(chess, r, color) {
  chess.move({ from: r.from, to: r.to, promotion: r.promotion });
  try {
    // chess.js's own _moves lists legal moves without working out check and mate for each, as
    // moves() does, which made this ten times slower. It is internal, but chess.js is vendored at
    // 1.4.0, so it cannot change under us.
    const to = (8 - Number(r.to[1])) * 16 + (r.to.charCodeAt(0) - 97); // chess.js's 0x88 square index
    return chess.attackers(r.to, color).some((sq) => chess._moves({ legal: true, square: sq }).some((x) => x.to === to));
  } finally {
    chess.undo();
  }
}

/** What one legal move does, in plain words. `chess` is left as it was. */
export function describeMove(chess, m) {
  const us = m.color;
  const them = other(us);
  const parts = [];
  if (m.flags.includes("k")) parts.push("Castles kingside.");
  else if (m.flags.includes("q")) parts.push("Castles queenside.");
  else parts.push(`${cap(NAMES[m.piece])} from ${m.from} to ${m.to}.`);
  if (m.captured) parts.push(`Captures a ${NAMES[m.captured]} (worth ${VALUES[m.captured]}).`);
  if (m.promotion) parts.push(`Promotes to a ${NAMES[m.promotion]}.`);

  chess.move(m.san);
  try {
    if (chess.isCheckmate()) return [...parts, "Checkmate: wins the game at once."].join(" ");
    if (chess.isStalemate()) parts.push("Stalemate: the game ends in a draw.");
    else if (chess.isDraw()) parts.push("The game ends in a draw.");
    if (chess.inCheck()) parts.push("Gives check.");

    // The opponent's legal answers: what it can take (en passant included) and whether it can mate
    const replies = chess.moves({ verbose: true });

    // What the move gains in material, less what it likely gives back to the cheapest recapture
    let net = (VALUES[m.captured] || 0) + (m.promotion ? VALUES[m.promotion] - 1 : 0);
    const type = m.promotion || m.piece;
    if (type !== "k") {
      const name = `The ${NAMES[type]} on ${m.to}`;
      const takers = takersOf(replies, m.to);
      const cheapest = VALUES[takers[0]?.piece] || 99;
      if (!takers.length) parts.push(`${name} cannot be taken.`);
      else if (!canRetake(chess, takers[0], us)) {
        parts.push(`${name} is attacked and undefended: it can be taken for free.`);
        net -= VALUES[type];
      } else if (cheapest < VALUES[type]) {
        parts.push(`${name} can be taken by a cheaper ${NAMES[takers[0].piece]}.`);
        net -= VALUES[type] - cheapest;
      } else parts.push(`${name} is attacked but defended.`);

      const targets = squares(chess, them).filter(
        (p) => p.type !== "k" && chess.attackers(p.square, us).includes(m.to) && (!chess.attackers(p.square, them).length || VALUES[p.type] > VALUES[type]),
      );
      if (targets.length) parts.push(`Threatens ${list(targets.map((p) => `the ${NAMES[p.type]} on ${p.square}`))}.`);
    }

    const points = (n) => `${n} point${n > 1 ? "s" : ""} of material`;
    if (net > 0) parts.push(`Likely wins ${points(net)}.`);
    else if (net < 0) parts.push(`Likely loses ${points(-net)} when the opponent takes.`);
    else if (m.captured) parts.push("An even trade.");

    const loose = loosePieces(chess, us, replies).filter((p) => p.square !== m.to);
    if (loose.length) parts.push(`Leaves ${list(loose.map((p) => `the ${NAMES[p.type]} on ${p.square}`))} open to capture.`);
    const mate = replies.find((r) => r.san.endsWith("#"));
    if (mate) parts.push(`Allows ${COLOR[them]} to checkmate at once with ${mate.san}.`);
    parts.push(materialWords(chess, us));
  } finally {
    chess.undo();
  }
  return parts.join(" ");
}

/** Every legal move with its description, in chess.js order. */
export function annotateMoves(chess) {
  return chess.moves({ verbose: true }).map((m) => ({ san: m.san, uci: uci(m), text: describeMove(chess, m) }));
}

function boardText(chess) {
  const rows = chess.board().map((row, i) => `${8 - i} | ${row.map((p) => (p ? (p.color === "w" ? p.type.toUpperCase() : p.type) : ".")).join(" ")}`);
  return [...rows, "    a b c d e f g h"].join("\n");
}

function pieceList(chess, color) {
  const by = {};
  for (const p of squares(chess, color)) (by[p.type] ||= []).push(p.square);
  return "kqrbnp"
    .split("")
    .filter((t) => by[t])
    .map((t) => `${by[t].length > 1 ? PLURAL[t] : cap(NAMES[t])} ${by[t].sort().join(", ")}`)
    .join("; ");
}

/** "1. e4 e5 2. Nf3", the last `plies` half-moves only. */
export function moveText(sans, plies = 80) {
  const start = Math.max(0, sans.length - plies);
  const out = [];
  for (let i = start; i < sans.length; i++) out.push(i % 2 === 0 ? `${i / 2 + 1}. ${sans[i]}` : i === start ? `${(i + 1) / 2}... ${sans[i]}` : sans[i]);
  return (start ? "(earlier moves omitted) " : "") + (out.join(" ") || "none yet");
}

/** The position as the player to move sees it. */
export function positionState(chess) {
  const us = chess.turn();
  const theirs = theirTurn(chess);
  const loose = theirs ? loosePieces(theirs, us, theirs.moves({ verbose: true })) : loosePieces(chess, us);
  const history = chess.history();
  return {
    game: "Chess, standard rules",
    you_play: COLOR[us],
    board: boardText(chess),
    legend: "Uppercase letters are White pieces and lowercase are Black: K king, Q queen, R rook, B bishop, N knight, P pawn. A dot is an empty square. Rank 8 is at the top and file a on the left.",
    white_pieces: pieceList(chess, "w"),
    black_pieces: pieceList(chess, "b"),
    material: materialWords(chess, us),
    in_check: chess.inCheck() ? `yes, ${COLOR[us]} is in check` : "no",
    your_pieces_under_threat: loose.length ? list(loose.map((p) => `${NAMES[p.type]} on ${p.square}`)) : "none",
    opponent_last_move: history.at(-1) || "none, this is the first move",
    moves_so_far: moveText(history),
    fen: chess.fen(),
  };
}

// ---------------------------------------------------------------------------------------------
// Jev: one request per move, a Choice over the legal moves plus a Score of the position
// ---------------------------------------------------------------------------------------------
export const EVAL_LEVELS = [
  "Black is winning: a decisive material advantage or a mating attack for Black",
  "Black is clearly better: ahead in material or with a strong attack",
  "Black is slightly better",
  "The position is roughly equal",
  "White is slightly better",
  "White is clearly better: ahead in material or with a strong attack",
  "White is winning: a decisive material advantage or a mating attack for White",
];

export function jevQuestions(chess, moves) {
  const us = COLOR[chess.turn()];
  return {
    move: {
      type: "choice",
      instructions: {
        question: `Which move should ${us} play now? Each option is a legal move, described by what it does.`,
        priorities: [
          "A move that gives checkmate wins the game: always choose it.",
          "Never choose a move that allows the opponent to checkmate at once.",
          "Do not give material away: avoid a move that likely loses material, or leaves a piece attacked and undefended or open to capture by a cheaper piece, unless it gives checkmate or stops the opponent from mating.",
          "Capture pieces that are undefended or worth more than the capturing piece.",
          "Threaten valuable enemy pieces, especially two at once, and give checks that win material.",
          "In the opening, develop knights and bishops toward the center, control the center with pawns and castle early.",
          "When ahead in material, trade pieces, push passed pawns toward promotion and avoid stalemate.",
        ],
      },
      criteria: Object.fromEntries(moves.map((m) => [m.san, m.text])),
    },
    evaluation: {
      type: "score",
      instructions: "Judging `board`, `material`, `white_pieces`, `black_pieces` and `moves_so_far`, who is better in this position?",
      criteria: EVAL_LEVELS,
    },
  };
}

export class ApiError extends Error {
  constructor(message, status, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/** Retries rate limits, server errors and dropped connections; anything else is the caller's to handle. */
export async function withRetry(fn, { tries = 5, signal, onWait } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = e.status === 429 || e.status >= 500 || (e.status === undefined && e.name === "TypeError");
      if (!retryable || i >= tries - 1 || signal?.aborted) throw e;
      const wait = Math.min(30_000, (e.retryAfter || 2 ** (i + 1)) * 1000);
      onWait?.(wait, e);
      await sleep(wait + Math.random() * 400, signal);
    }
  }
}

async function postJson(url, key, body, signal, extra = {}) {
  let r;
  try {
    r = await fetch(url, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...extra },
      body: JSON.stringify(body),
    });
  } catch (e) {
    if (e.name === "AbortError" || e.name === "TimeoutError") throw e;
    throw Object.assign(new TypeError(`Network error: ${e.message}`), { status: undefined });
  }
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { detail: text.slice(0, 200) };
  }
  const err = data?.error;
  if (!r.ok || err) {
    const message = err?.message || data?.detail?.message || (typeof data?.detail === "string" ? data.detail : "") || r.statusText;
    throw new ApiError(message || `HTTP ${r.status}`, r.ok ? Number(err?.code) || 502 : r.status, Number(r.headers.get("retry-after")) || 0);
  }
  return data;
}

/**
 * One Jev call. route "openrouter" goes to OpenRouter's Decisions API from the browser; route
 * "typesafe" goes to TypeSafe through this site's relay, because TypeSafe refuses browser pages.
 */
export async function askJev({ route, key, state, questions, signal, typesafeUrl = "/v1/systemone" }) {
  const openrouter = route === "openrouter";
  const url = openrouter ? `${OPENROUTER}/api/alpha/decisions` : typesafeUrl;
  const body = { model: openrouter ? JEV.openrouter : JEV.typesafe, state, questions };
  const data = await postJson(url, key, body, signal, openrouter ? { "X-Title": "Jev Chess" } : {});
  const tokens = data.usage?.input_tokens || 0;
  return { answers: data.answers || {}, tokens, cost: openrouter ? Number(data.usage?.cost) || 0 : tokens * JEV.pricePerToken };
}

export function jevPlayer({ route, key, typesafeUrl }) {
  return {
    async move(chess, { signal, onWait } = {}) {
      const moves = annotateMoves(chess);
      const state = positionState(chess);
      const questions = jevQuestions(chess, moves);
      const { answers, tokens, cost } = await withRetry(() => askJev({ route, key, state, questions, signal, typesafeUrl }), { signal, onWait });
      const probs = answers.move?.probabilities || {};
      const legal = new Set(moves.map((m) => m.san));
      const ranked = Object.entries(probs)
        .filter(([san]) => legal.has(san))
        .sort((a, b) => b[1] - a[1]);
      const san = legal.has(answers.move?.choice) ? answers.move.choice : ranked[0]?.[0];
      if (!san) throw new ApiError("Jev gave no move", 502);
      return {
        san,
        tokens,
        cost,
        confidence: answers.move?.confidence ?? null,
        top: ranked.slice(0, 4).map(([s, p]) => [s, Math.round(p * 1000) / 1000]),
        eval: typeof answers.evaluation?.score === "number" ? Math.round(answers.evaluation.score * 100) / 100 : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// LLMs through OpenRouter's chat completions
// ---------------------------------------------------------------------------------------------
export function llmMessages(chess, moves) {
  const s = positionState(chess);
  const system = [
    `You are playing chess as ${s.you_play} against Jev, another AI. Each turn you get the position and every legal move, with notes about what each move does that code computed for you.`,
    'Pick exactly one move from the list. Answer with one short sentence about your idea, then a last line in exactly this form: "MOVE: <move in SAN as written in the list>", for example "MOVE: Nf3".',
  ].join("\n");
  const user = [
    `You play ${s.you_play}. It is your move.`,
    `FEN: ${s.fen}`,
    `Board:\n${s.board}`,
    s.legend,
    `White pieces: ${s.white_pieces}`,
    `Black pieces: ${s.black_pieces}`,
    `Material: ${s.material}`,
    `In check: ${s.in_check}`,
    `Your pieces under threat: ${s.your_pieces_under_threat}`,
    `Moves so far: ${s.moves_so_far}`,
    "",
    "Legal moves:",
    ...moves.map((m) => `- ${m.san}: ${m.text}`),
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const normSan = (s) => s.replace(/[+#?!]/g, "").replace(/0/g, "O").replace(/^([a-h][1-8])-?([a-h][1-8])$/, "$1$2");

/** The legal move a reply names: its "MOVE:" line if it has one, else the last move-like word. */
export function parseMove(text, legal) {
  const bySan = new Map(legal.map((m) => [normSan(m.san), m]));
  const byUci = new Map(legal.map((m) => [uci(m), m]));
  const find = (raw) => {
    const t = raw.replace(/^[*`'"(]+|[*`'".,;:)]+$/g, "");
    if (!t) return null;
    return bySan.get(normSan(t)) || byUci.get(t.toLowerCase().replace(/[-=x]/g, "")) || null;
  };
  const body = String(text || "");
  const tagged = [...body.matchAll(/MOVE\s*:\s*[*`]*\s*(?:\d+\s*\.+\s*)?([^\s*`]+)/gi)].pop();
  if (tagged) return find(tagged[1]);
  const words = body.split(/[\s,;()]+/).reverse();
  for (const w of words) {
    const m = find(w);
    if (m) return m;
  }
  return null;
}

export async function askLLM({ key, model, messages, signal, reasoning }) {
  const body = { model, messages, usage: { include: true } };
  if (reasoning) body.reasoning = { effort: "low" };
  const data = await postJson(`${OPENROUTER}/api/v1/chat/completions`, key, body, signal, { "X-Title": "Jev Chess" });
  const msg = data.choices?.[0]?.message || {};
  const content = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((c) => c.text || "").join("") : "";
  return {
    content,
    tokens: (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0),
    cost: Number(data.usage?.cost) || 0,
  };
}

/** The first sentence or so of a reply, without its MOVE line, for display. */
const noteOf = (text) =>
  String(text || "")
    .replace(/MOVE\s*:.*$/gim, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);

export function llmPlayer({ key, model, reasoning = false, random = Math.random }) {
  return {
    async move(chess, { signal, onWait } = {}) {
      const legal = chess.moves({ verbose: true });
      const moves = annotateMoves(chess);
      const messages = llmMessages(chess, moves);
      let tokens = 0;
      let cost = 0;
      let note = "";
      let tries = 0;
      for (; tries < LLM_ATTEMPTS; tries++) {
        const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
        let reply;
        try {
          reply = await withRetry(() => askLLM({ key, model, messages, reasoning, signal: signal ? AbortSignal.any([signal, timeout]) : timeout }), { signal, onWait });
        } catch (e) {
          if (signal?.aborted || e.name !== "TimeoutError") throw e;
          note = "No answer within two minutes.";
          continue;
        }
        tokens += reply.tokens;
        cost += reply.cost;
        const m = parseMove(reply.content, legal);
        if (m) return { san: m.san, tokens, cost, tries: tries + 1, note: noteOf(reply.content) };
        note = reply.content ? `Unusable reply: ${noteOf(reply.content) || reply.content.slice(0, 120)}` : "Empty reply.";
        messages.push(
          { role: "assistant", content: reply.content || "(empty)" },
          { role: "user", content: 'That reply does not name a legal move. Choose one move from the "Legal moves" list and end with a line "MOVE: <move>".' },
        );
      }
      const m = legal[Math.floor(random() * legal.length)];
      return { san: m.san, tokens, cost, tries, fallback: true, note: `${note} Played a random legal move instead.`.trim() };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Stockfish, the classic chess engine, at a chosen strength
// ---------------------------------------------------------------------------------------------
export const ENGINE_ELOS = [1320, 1600, 2000, 2400, 2800, 3190]; // the engine's UCI_Elo range is 1320 to 3190
const ENGINE_MOVETIME_MS = 300;

/**
 * open() starts one engine and returns {post(command), listen(fn), close()}: a Web Worker in the
 * page, a child process in Node. Each game gets its own engine.
 */
export function stockfishPlayer({ elo, open }) {
  let engine;
  let lines = [];
  let wake = () => {};
  /** The next line starting with `prefix`; gives up when the game stops or the engine goes quiet. */
  const next = async (prefix, signal, ms) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const i = lines.findIndex((l) => l.startsWith(prefix));
      if (i >= 0) return lines.splice(0, i + 1).at(-1);
      if (Date.now() >= deadline) throw new ApiError("Stockfish stopped answering", 504);
      await new Promise((resolve) => {
        const t = setTimeout(done, deadline - Date.now());
        function done() {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        wake = done;
        signal?.addEventListener("abort", done, { once: true });
      });
    }
  };
  async function start(signal) {
    engine = open();
    engine.listen((line) => (lines.push(...String(line).split("\n").filter(Boolean)), wake()));
    engine.post("uci");
    await next("uciok", signal, 20_000); // the first start compiles the WebAssembly
    engine.post("setoption name UCI_LimitStrength value true");
    engine.post(`setoption name UCI_Elo value ${elo}`);
    engine.post("ucinewgame");
    engine.post("isready");
    await next("readyok", signal, 20_000);
  }
  return {
    async move(chess, { signal } = {}) {
      if (!engine) await start(signal);
      const stop = () => engine.post("stop");
      signal?.addEventListener("abort", stop, { once: true });
      try {
        engine.post(`position startpos moves ${chess.history({ verbose: true }).map(uci).join(" ")}`.trim());
        engine.post(`go movetime ${ENGINE_MOVETIME_MS}`);
        const best = (await next("bestmove", signal, 15_000)).split(" ")[1];
        const m = chess.moves({ verbose: true }).find((x) => uci(x) === best);
        if (!m) throw new ApiError(`Stockfish answered ${best}`, 500);
        return { san: m.san };
      } finally {
        signal?.removeEventListener("abort", stop);
      }
    },
    close: () => engine?.close(),
  };
}

export function randomPlayer(random = Math.random) {
  return {
    async move(chess) {
      const legal = chess.moves();
      return { san: legal[Math.floor(random() * legal.length)] };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Moves said aloud: an exact reading first, then Jev picks the legal move that was meant
// ---------------------------------------------------------------------------------------------
const SPOKEN_PIECES = { knight: "N", night: "N", nite: "N", knights: "N", bishop: "B", bishops: "B", rook: "R", rock: "R", rooks: "R", queen: "Q", queens: "Q", king: "K", kings: "K" };
const SPOKEN_DIGITS = { one: "1", won: "1", two: "2", too: "2", three: "3", four: "4", for: "4", fore: "4", five: "5", six: "6", seven: "7", eight: "8", ate: "8" };
const SPOKEN_FILLER = new Set(["to", "pawn", "pawns", "move", "moves", "moving", "on", "the", "my", "square", "goes", "go", "please", "and", "then", "from", "i", "play", "plays", "will", "ill", "i'll", "let's", "lets", "okay", "ok"]);

/**
 * The legal move a transcript names outright ("knight f3", "e4", "bishop takes c4", "e2 e4",
 * "castle kingside"), or null when it needs a judgment, which Jev then makes.
 */
export function spokenMove(text, legal) {
  const t = String(text || "").toLowerCase().replace(/[.,!?;:"]/g, " ").replace(/-/g, " ");
  if (/\bcastles?\b|\bcastling\b/.test(t)) {
    const long = /queen ?side|\blong\b/.test(t);
    const short = /king ?side|\bshort\b/.test(t);
    const san = long === short ? null : long ? "O-O-O" : "O-O";
    return (san && legal.find((m) => m.san.replace(/[+#]/g, "") === san)) || null;
  }
  let out = "";
  for (const w of t.split(/\s+/).filter(Boolean)) {
    if (SPOKEN_PIECES[w]) out += SPOKEN_PIECES[w];
    else if (["takes", "take", "captures", "capture", "x"].includes(w)) out += "x";
    else if (["promotes", "promote", "promoting", "equals"].includes(w)) out += "=";
    else if (/^[a-h][1-8]$/.test(w) || /^[a-h]$/.test(w)) out += w;
    else if (/^[1-8]$/.test(w) && /[a-h]$/.test(out)) out += w;
    else if (SPOKEN_DIGITS[w] && /[a-h]$/.test(out)) out += SPOKEN_DIGITS[w];
    else if (!SPOKEN_FILLER.has(w)) return null; // a word this reading does not know: Jev's turn
  }
  return out ? parseMove(`MOVE: ${out}`, legal) : null;
}

/** A legal move in plain words, as an option for Jev when it reads a spoken move. */
function plainMove(m) {
  if (m.flags.includes("k")) return "Castles kingside";
  if (m.flags.includes("q")) return "Castles queenside";
  return `${cap(NAMES[m.piece])} from ${m.from} to ${m.to}${m.captured ? `, capturing the ${NAMES[m.captured]}` : ""}${m.promotion ? `, promoting to a ${NAMES[m.promotion]}` : ""}`;
}

/** One Jev request: which legal move do these words name? `heard` lists the recognizer's guesses. */
export function voiceRequest(chess, heard) {
  const criteria = Object.fromEntries(chess.moves({ verbose: true }).map((m) => [m.san, plainMove(m)]));
  criteria.none = "The words name no legal move here, or are not about a move";
  return {
    state: { spoken: heard[0], other_hearings: heard.slice(1), player: COLOR[chess.turn()] },
    questions: {
      move: {
        type: "choice",
        instructions: {
          question: "Which of the player's legal chess moves do the words in `spoken` name?",
          notes: [
            "`spoken` comes from speech recognition, which mishears: night for knight, rock for rook, for or fore for four, to or too for two, ate for eight, and letters that sound alike (b, c, d, e, g, t, v; a and h). `other_hearings` are its other guesses for the same words.",
            "Players say moves in many ways: knight f3, knight to f3, put my knight on f3, bishop takes c4, e4, pawn to e4, queen takes on d8, castle kingside, short castle.",
            "Choose none when the words name no legal move or are not a move at all.",
          ],
        },
        criteria,
      },
    },
  };
}

/** A move as it would be said aloud: "knight f 3", "e takes d 5, check", "castles kingside". */
export function sayMove(san) {
  const tail = san.endsWith("#") ? ", checkmate" : san.endsWith("+") ? ", check" : "";
  const core = san.replace(/[+#]/g, "");
  if (core === "O-O-O") return `castles queenside${tail}`;
  if (core === "O-O") return `castles kingside${tail}`;
  const piece = { N: "knight", B: "bishop", R: "rook", Q: "queen", K: "king" };
  const [, p, body = "", promo] = /^([NBRQK]?)([a-h1-8x]*)(?:=([NBRQ]))?$/.exec(core) || [];
  const said = body.split("").map((ch) => (ch === "x" ? "takes" : ch)); // squares letter by letter: "b d 2"
  return [p && piece[p], ...said, promo && `promotes to ${piece[promo]}`].filter(Boolean).join(" ") + tail;
}

// ---------------------------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------------------------
/** Half-moves played since the standard starting position; cheaper than history(), which replays the game. */
const plies = (chess) => (chess.moveNumber() - 1) * 2 + (chess.turn() === "b" ? 1 : 0);

export function gameEnd(chess, plyCap = PLY_CAP) {
  const draw = (reason) => ({ result: "1/2-1/2", reason });
  if (chess.isCheckmate()) return { result: chess.turn() === "w" ? "0-1" : "1-0", reason: "checkmate" };
  if (chess.isStalemate()) return draw("stalemate");
  if (chess.isInsufficientMaterial()) return draw("insufficient material");
  if (chess.isThreefoldRepetition()) return draw("threefold repetition");
  if (chess.isDrawByFiftyMoves()) return draw("fifty-move rule");
  if (plies(chess) >= plyCap) return draw(`move limit (${plyCap / 2} moves each)`);
  return null;
}

/**
 * Plays until the game ends. players: {w, b}, each with move(chess, {signal}) returning {san, ...};
 * a player may try moves on `chess` but must undo them before it returns. onMove(record) follows
 * every move; pause() gives the wait before the next one, so the page can change the pace mid-game.
 */
export async function playGame({ players, chess = new Chess(), signal, onMove, onThink, onWait, pause = () => 0, plyCap = PLY_CAP }) {
  for (;;) {
    const end = gameEnd(chess, plyCap);
    if (end) return end;
    const color = chess.turn();
    onThink?.(color);
    const t0 = Date.now();
    const pick = await players[color].move(chess, { signal, onWait: (ms, e) => onWait?.(color, ms, e) });
    if (signal?.aborted) throw signal.reason; // stopped while the answer was on its way: do not play it
    const move = chess.move(pick.san);
    onMove?.({ ...pick, san: move.san, uci: uci(move), color, ms: Date.now() - t0 });
    if (gameEnd(chess, plyCap)) continue; // over: report it now, not after the pause, which Stop could cut short
    const wait = pause();
    if (wait) await sleep(wait, signal);
  }
}

/** PGN with the usual headers, for downloads. */
export function pgnOf({ white, black, sans, result, date = new Date() }) {
  const chess = new Chess();
  for (const san of sans) chess.move(san);
  chess.setHeader("Event", "Jev Chess");
  chess.setHeader("Site", "https://jevchess.xera.ac");
  chess.setHeader("Date", date.toISOString().slice(0, 10).replace(/-/g, "."));
  chess.setHeader("White", white);
  chess.setHeader("Black", black);
  chess.setHeader("Result", result);
  return chess.pgn();
}
