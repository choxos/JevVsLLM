/**
 * Does a shorter wording of the moves make Jev play worse? Plays games with one wording and scores
 * every Jev move against a full strength Stockfish, so the answer does not rest on who won.
 *
 *   TYPESAFE_API_KEY=... STYLE=short GAMES=6 node test/ab.mjs
 *
 * STYLE is "full" or "short", GAMES how many to play (default 6), DEPTH the depth the judge
 * searches (default 10), ELO the opponent's strength (default 1320), PLIES the cap (default 120).
 * It prints one JSON line: the average centipawn loss of Jev's moves, its results, and what the
 * games cost. Lower loss is better play.
 */
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Chess, STYLE, jevPlayer, stockfishPlayer, playGame, gameEnd } from "../docs/chess-ai.js";

const { TYPESAFE_API_KEY: key, STYLE: style = "full", GAMES = 6, DEPTH = 10, ELO = 1320, PLIES = 120 } = process.env;
if (!key) throw new Error("Set TYPESAFE_API_KEY");
STYLE.moves = style === "short" ? "short" : "full";

const bin = fileURLToPath(new URL("../docs/vendor/stockfish/stockfish-19-lite-single.js", import.meta.url));
const open = () => {
  const p = spawn(process.execPath, [bin]);
  return { post: (c) => p.stdin.write(c + "\n"), listen: (fn) => readline.createInterface({ input: p.stdout }).on("line", fn), close: () => p.kill() };
};

/** A full strength engine that scores a position in centipawns, for the side to move. */
function judge() {
  const engine = open();
  const lines = [];
  let wake = () => {};
  engine.listen((l) => (lines.push(l), wake()));
  const take = async (prefix) => {
    for (;;) {
      const i = lines.findIndex((l) => l.startsWith(prefix));
      if (i >= 0) return lines.splice(0, i + 1);
      await new Promise((r) => (wake = r));
    }
  };
  return {
    async ready() {
      engine.post("uci");
      await take("uciok");
      engine.post("setoption name UCI_LimitStrength value false");
      engine.post("isready");
      await take("readyok");
    },
    async score(fen) {
      lines.length = 0;
      engine.post(`position fen ${fen}`);
      engine.post(`go depth ${DEPTH}`);
      let cp = 0; // the last score the search reported, for the side to move
      for (const l of await take("bestmove")) {
        const mate = /score mate (-?\d+)/.exec(l);
        const centi = /score cp (-?\d+)/.exec(l);
        if (mate) cp = Number(mate[1]) > 0 ? 10000 : -10000;
        else if (centi) cp = Number(centi[1]);
      }
      return cp;
    },
    close: () => engine.close(),
  };
}

const games = [];
for (let n = 0; n < Number(GAMES); n++) {
  const chess = new Chess();
  const jev = jevPlayer({ route: "typesafe", key, base: "https://api.typesafe.ai" });
  const engine = stockfishPlayer({ elo: Number(ELO), open });
  const moves = [];
  const end = await playGame({ chess, players: { w: jev, b: engine }, plyCap: Number(PLIES), onMove: (m) => moves.push(m) });
  engine.close();
  games.push({ end, moves, pgn: chess.pgn() });
  process.stderr.write(`game ${n + 1}: ${end.result} by ${end.reason}, ${moves.length} half-moves\n`);
}

// Every Jev move costs what a full strength engine says the position lost, capped so one blunder
// does not drown the rest
const scorer = judge();
await scorer.ready();
const losses = [];
for (const g of games) {
  const board = new Chess();
  for (const m of g.moves) {
    if (m.color !== "w") {
      board.move(m.san);
      continue;
    }
    const before = await scorer.score(board.fen());
    board.move(m.san);
    const after = -(await scorer.score(board.fen()));
    if (!gameEnd(board)) losses.push(Math.min(1000, Math.max(0, before - after)));
  }
}
scorer.close();

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const results = games.map((g) => g.end.result);
console.log(
  JSON.stringify({
    style: STYLE.moves,
    games: games.length,
    moves: losses.length,
    averageCentipawnLoss: Math.round(mean(losses)),
    blunders: losses.filter((l) => l >= 300).length,
    clean: losses.filter((l) => l <= 20).length,
    results: { jevWon: results.filter((r) => r === "1-0").length, drawn: results.filter((r) => r === "1/2-1/2").length, jevLost: results.filter((r) => r === "0-1").length },
    halfMoves: games.map((g) => g.moves.length),
    tokens: games.reduce((n, g) => n + g.moves.reduce((k, m) => k + (m.tokens || 0), 0), 0),
    cost: Number(games.reduce((n, g) => n + g.moves.reduce((k, m) => k + (m.cost || 0), 0), 0).toFixed(4)),
  }),
);
