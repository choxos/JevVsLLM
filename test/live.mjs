/**
 * One live game against the real APIs, printed move by move. Keys come from the environment only.
 *
 *   TYPESAFE_API_KEY=... node test/live.mjs                        Jev (TypeSafe) vs random moves
 *   OPENROUTER_API_KEY=... node test/live.mjs                      Jev (OpenRouter) vs random moves
 *   OPENROUTER_API_KEY=... MODEL=some/model node test/live.mjs     Jev vs that model
 *   ENGINE=1600 ... node test/live.mjs                             Jev vs Stockfish at that Elo
 *
 * PLIES caps the game (default 200). OUT=game.json writes the game in the shape POST /api/games takes.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Chess, jevPlayer, llmPlayer, stockfishPlayer, randomPlayer, playGame, COLOR } from "../docs/chess-ai.js";

const { TYPESAFE_API_KEY: ts, OPENROUTER_API_KEY: or, MODEL, ENGINE, OUT } = process.env;
if (!ts && !or) throw new Error("Set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
const route = ts ? "typesafe" : "openrouter";
const jev = jevPlayer({ route, key: ts || or, base: "https://api.typesafe.ai" });
let opponent = randomPlayer();
let side = { kind: "engine", name: "Random moves", model: "random" };
if (ENGINE) {
  const bin = fileURLToPath(new URL("../docs/vendor/stockfish/stockfish-19-lite-single.js", import.meta.url));
  const open = () => {
    const p = spawn(process.execPath, [bin]);
    return { post: (c) => p.stdin.write(c + "\n"), listen: (fn) => readline.createInterface({ input: p.stdout }).on("line", fn), close: () => p.kill() };
  };
  opponent = stockfishPlayer({ elo: Number(ENGINE), open });
  side = { kind: "engine", name: `Stockfish ${ENGINE}`, model: `stockfish-19-elo-${ENGINE}` };
} else if (MODEL && or) {
  opponent = llmPlayer({ key: or, model: MODEL });
  side = { kind: "llm", name: MODEL, model: MODEL };
}
const totals = { w: { cost: 0, ms: 0, n: 0 }, b: { cost: 0, ms: 0, n: 0 } };
const moves = [];

const chess = new Chess();
const end = await playGame({
  chess,
  players: { w: jev, b: opponent },
  plyCap: Number(process.env.PLIES || 200),
  onWait: (color, ms, e) => console.log(`  ${COLOR[color]} waits ${ms} ms: ${e.message}`),
  onMove: (m) => {
    moves.push(m);
    Object.assign(totals[m.color], { cost: totals[m.color].cost + (m.cost || 0), ms: totals[m.color].ms + m.ms, n: totals[m.color].n + 1 });
    const extra = m.top ? `conf ${m.confidence?.toFixed(2)} eval ${m.eval} top ${m.top.map(([s, p]) => `${s} ${Math.round(p * 100)}%`).join(", ")}` : m.note || "";
    console.log(`${COLOR[m.color].padEnd(5)} ${m.san.padEnd(7)} ${String(m.ms).padStart(5)} ms  ${extra}${m.fallback ? " [random fallback]" : ""}`);
  },
});
opponent.close?.();
console.log(end, chess.pgn());
for (const c of ["w", "b"]) console.log(COLOR[c], `avg ${Math.round(totals[c].ms / totals[c].n)} ms`, `$${totals[c].cost.toFixed(5)}`);
if (OUT) {
  const jevSide = { kind: "jev", name: "Jev", model: route === "typesafe" ? "jev-1.13.0" : "typesafe/jev-1.13", route };
  fs.writeFileSync(OUT, JSON.stringify({ white: jevSide, black: side, reason: end.reason, moves }));
}
