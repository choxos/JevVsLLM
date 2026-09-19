import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Chess, annotateMoves, parseMove, jevPlayer, llmPlayer, stockfishPlayer, randomPlayer, playGame, gameEnd, pgnOf, JEV } from "../docs/chess-ai.js";
import { cleanGame } from "../server.mjs";

const play = (...sans) => {
  const c = new Chess();
  for (const s of sans) c.move(s);
  return c;
};
const textOf = (chess, san) => annotateMoves(chess).find((m) => m.san === san).text;

// A seeded generator, so random games are the same on every run
function rng(seed) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

test("describes mate, forks, blunders and threats in words", () => {
  const scholar = play("e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6");
  assert.match(textOf(scholar, "Qxf7#"), /Checkmate: wins the game at once/);

  const fork = play("e4", "e5", "Nf3", "Nc6", "Bc4", "Nd4", "Nxe5", "Qg5");
  assert.match(textOf(fork, "Nxf7"), /Captures a pawn .* Threatens the rook on h8 and the queen on g5/);
  assert.match(textOf(fork, "Qh5"), /queen on h5 is attacked and undefended.* Likely loses 9 points of material/);
  assert.match(textOf(fork, "Nxf7"), /Likely wins 1 point of material/);
  // the queen for a knight, as Jev once played it
  assert.match(textOf(play("e4", "e5", "Qf3", "Nf6", "Bc4", "Be7"), "Qxf6"), /Captures a knight .* undefended.* Likely loses 6 points of material/);

  const fool = play("f3", "e5");
  assert.match(textOf(fool, "g4"), /Allows Black to checkmate at once with Qh4#/);

  const start = new Chess();
  assert.equal(annotateMoves(start).length, 20);
  const fen = fork.fen();
  annotateMoves(fork);
  assert.equal(fork.fen(), fen); // every tried move is taken back
});

test("reads a move out of a reply", () => {
  const legal = play("e4", "e5", "Nf3", "Nc6", "Bc4", "Nf6").moves({ verbose: true });
  const cases = {
    "Develop and castle.\nMOVE: O-O": "O-O",
    "MOVE: **0-0**": "O-O",
    "MOVE: 4. Ng5": "Ng5",
    "MOVE: e1g1": "O-O",
    "I like d4 here.": "d4",
    "MOVE: Qxf7": null, // tagged but illegal: no guessing from the rest
    "": null,
  };
  for (const [reply, san] of Object.entries(cases)) assert.equal(parseMove(reply, legal)?.san ?? null, san, reply);
});

test("random games end by the rules or the move limit", async () => {
  for (let seed = 1; seed <= 6; seed++) {
    const r = rng(seed);
    const chess = new Chess();
    const end = await playGame({ players: { w: randomPlayer(r), b: randomPlayer(r) }, chess, plyCap: 120 });
    assert.deepEqual(end, gameEnd(chess, 120));
    assert.ok(chess.history().length <= 120);
    assert.match(pgnOf({ white: "a", black: "b", sans: chess.history(), result: end.result }), /\[White "a"\]/);
  }
});

function fakeFetch(replies, seen) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const reply = replies.shift();
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  };
}

test("Jev asks one Choice over the legal moves and plays its answer", async (t) => {
  const seen = [];
  t.mock.method(globalThis, "fetch", fakeFetch([{ answers: { move: { choice: "Nf3", probabilities: { Nf3: 0.7, e4: 0.2, d4: 0.1 }, confidence: 0.6 }, evaluation: { score: 3.2 } }, usage: { input_tokens: 1000, cost: 0.000042 } }], seen));
  const out = await jevPlayer({ route: "openrouter", key: "k" }).move(new Chess());
  assert.equal(out.san, "Nf3");
  assert.deepEqual(out.top[0], ["Nf3", 0.7]);
  assert.equal(out.eval, 3.2);
  assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(seen[0].body.model, JEV.openrouter);
  assert.equal(Object.keys(seen[0].body.questions.move.criteria).length, 20);
  assert.equal(seen[0].headers.Authorization, "Bearer k");

  t.mock.method(globalThis, "fetch", fakeFetch([{ answers: { move: { choice: "Ke2", probabilities: { Ke2: 0.9, e4: 0.1 } } }, usage: { input_tokens: 1000 } }], seen));
  const fallback = await jevPlayer({ route: "typesafe", key: "k" }).move(new Chess());
  assert.equal(fallback.san, "e4"); // an illegal choice falls back to the likeliest legal move
  assert.equal(seen[1].url, "/v1/systemone");
  assert.equal(seen[1].body.model, JEV.typesafe);
  assert.equal(fallback.cost, 1000 * JEV.pricePerToken);
});

test("an LLM gets a second chance, then a random legal move", async (t) => {
  const chat = (content) => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 } });
  const seen = [];
  t.mock.method(globalThis, "fetch", fakeFetch([chat("I will attack.\nMOVE: Qh5"), chat("Fine.\nMOVE: e4")], seen));
  const out = await llmPlayer({ key: "k", model: "x/y" }).move(new Chess());
  assert.deepEqual([out.san, out.tries, out.fallback, out.note], ["e4", 2, undefined, "Fine."]);
  assert.equal(seen[1].body.messages.length, 4); // the bad reply and the correction were sent back

  t.mock.method(globalThis, "fetch", fakeFetch([chat("hmm"), chat(""), chat("MOVE: Ke2")], []));
  const random = await llmPlayer({ key: "k", model: "x/y", random: () => 0 }).move(new Chess());
  assert.equal(random.fallback, true);
  assert.equal(random.san, new Chess().moves()[0]);
  assert.ok(Math.abs(random.cost - 0.003) < 1e-9);
});

test("Stockfish finds the mate", async () => {
  const bin = fileURLToPath(new URL("../docs/vendor/stockfish/stockfish-19-lite-single.js", import.meta.url));
  const open = () => {
    const p = spawn(process.execPath, [bin]);
    return { post: (cmd) => p.stdin.write(cmd + "\n"), listen: (fn) => readline.createInterface({ input: p.stdout }).on("line", fn), close: () => p.kill() };
  };
  const engine = stockfishPlayer({ elo: 1600, open });
  try {
    const out = await engine.move(play("e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6"));
    assert.equal(out.san, "Qxf7#");
  } finally {
    engine.close();
  }
});

test("a saved game is replayed and keeps only what a game needs", () => {
  const sans = ["f3", "e5", "g4", "Qh4#"];
  const { game } = cleanGame({
    white: { kind: "llm", name: "Some model", model: "x/some-model", apiKey: "sk-secret" },
    black: { kind: "jev", name: "Jev", route: "openrouter", key: "sk-secret" },
    moves: sans.map((san, i) => ({ san, ms: 200 + i, note: "idea", authorization: "Bearer sk-secret" })),
    result: "1-0", // wrong: the server works it out
    key: "sk-secret",
  });
  assert.equal(game.result, "0-1");
  assert.equal(game.reason, "checkmate");
  assert.equal(game.moves[3].san, "Qh4#");
  assert.doesNotMatch(JSON.stringify(game), /secret/);

  assert.match(cleanGame({ white: { kind: "jev" }, black: { kind: "llm" }, moves: [{ san: "e5" }] }).error, /Illegal/);
  assert.match(cleanGame({ white: { kind: "jev" }, black: { kind: "llm" }, moves: [{ san: "e4" }] }).error, /not over/);
  assert.match(cleanGame({ white: { kind: "llm" }, black: { kind: "llm" }, moves: [{ san: "e4" }] }).error, /Jev/);
  const resigned = cleanGame({ white: { kind: "human" }, black: { kind: "jev" }, moves: [{ san: "e4" }], reason: "resignation" }).game;
  assert.deepEqual([resigned.result, resigned.white.name], ["0-1", "You"]);
});

test("only legal captures count: pins hold, en passant takes", () => {
  // the knight on c6 is pinned to its king, so b4 does not hang the pawn
  assert.doesNotMatch(textOf(play("e4", "e5", "Nf3", "Nc6", "Bb5", "d6"), "b4"), /pawn on b4 is attacked and undefended/);
  // after e5, d5 can be taken en passant
  assert.match(textOf(play("e4", "a6", "e5"), "d5"), /pawn on d5 is attacked but defended/);
});

test("a game that ends is reported before the pause", async () => {
  const controller = new AbortController();
  const moves = { w: ["f3", "g4"], b: ["e5", "Qh4#"] };
  const scripted = (c) => ({ async move() { return { san: moves[c].shift() }; } });
  const end = await playGame({ players: { w: scripted("w"), b: scripted("b") }, signal: controller.signal, pause: () => (moves.b.length ? 0 : 60_000), onMove: (m) => m.san === "Qh4#" && controller.abort() });
  assert.deepEqual(end, { result: "0-1", reason: "checkmate" });
});
