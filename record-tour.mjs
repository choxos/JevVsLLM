// Records the tour of Jev Chess that the README embeds.
//
// Playwright drives the real app against the real APIs: Jev on a TypeSafe key, Mercury 2.5 through
// OpenRouter, and Stockfish in the page, so every move, probability and result in the video is what
// a visitor gets. The video is silent; captions carry the story. Long waits are cut out and the
// caption says so.
//
// Usage, with the app served (npm start, or the live site), keys from the environment only:
//   OPENROUTER_API_KEY=... TYPESAFE_API_KEY=... node record-tour.mjs [http://localhost:3141/]
//
// It writes documentation/tour.mp4 (1920 by 1080), documentation/tour.gif and
// documentation/screenshot.jpg, needs Google Chrome and ffmpeg, plays two full games and a few
// moves against you (a few cents), and saves the two games on the server it runs against.
import { execFileSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const { OPENROUTER_API_KEY: openrouter, TYPESAFE_API_KEY: typesafe } = process.env;
if (!openrouter || !typesafe) throw new Error("record-tour: set OPENROUTER_API_KEY and TYPESAFE_API_KEY");
const OPPONENT = { search: "mercury 2.5", name: "Inception: Mercury 2.5" };
const ELO = 1320;

const dir = dirname(fileURLToPath(import.meta.url));
const url = process.argv[2] || "http://localhost:3141/";
const outDir = resolve(dir, "documentation");
const raw = resolve(dir, "build/tour");
const frames = resolve(raw, "frames");
const mp4 = resolve(outDir, "tour.mp4");
const gif = resolve(outDir, "tour.gif");
const still = resolve(outDir, "screenshot.jpg");
await rm(raw, { recursive: true, force: true });
await mkdir(frames, { recursive: true });
await mkdir(outDir, { recursive: true });

// Headless recordings have no pointer, so the page gets a drawn pointer and a caption line. Both
// are manual popovers in the top layer, above the app's dialogs, and ignore events.
function overlays() {
  addEventListener("DOMContentLoaded", () => {
    const dot = document.createElement("div");
    dot.popover = "manual";
    dot.style.cssText = "position:fixed;inset:auto;left:-40px;top:-40px;width:18px;height:18px;margin:-9px 0 0 -9px;padding:0;border-radius:50%;background:rgba(21,24,33,.45);border:2px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,.4);pointer-events:none;overflow:visible;transition:transform .12s";
    const cap = document.createElement("div");
    cap.popover = "manual";
    cap.style.cssText = "position:fixed;inset:auto;left:50%;bottom:14px;transform:translateX(-50%);margin:0;border:0;width:max-content;max-width:min(760px,70vw);padding:11px 18px;border-radius:14px;background:rgba(21,24,33,.92);color:#f4f5f8;font:500 17px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.28);opacity:0;transition:opacity .3s;pointer-events:none";
    document.documentElement.append(dot, cap);
    const raise = () => {
      for (const el of [cap, dot]) {
        if (el.matches(":popover-open")) el.hidePopover();
        el.showPopover();
      }
    };
    raise();
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function () {
      showModal.call(this);
      raise(); // a dialog opened later would otherwise cover the pointer and the caption
    };
    addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", () => { dot.style.transform = "scale(.65)"; }, true);
    addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
    window.__caption = (text) => { if (text) cap.textContent = text; cap.style.opacity = text ? "1" : "0"; };
    window.__overlays = (on) => { dot.style.visibility = cap.style.visibility = on ? "" : "hidden"; };
  });
}

// A 1280 by 720 layout drawn at device scale 1.5 is 1920 by 1080 real pixels, and a screencast
// keeps them, where Playwright's own recorder would scale CSS pixels up and blur every label.
const browser = await chromium.launch({ channel: "chrome", args: ["--force-device-scale-factor=1.5", "--window-size=1280,807"] });
const context = await browser.newContext({ viewport: null, colorScheme: "light" });
await context.addInitScript(overlays);
// The keys go into this throwaway profile's storage before the app starts, so the tour never shows them
await context.addInitScript(({ or, ts }) => {
  try {
    localStorage.setItem("jevchess.keys", JSON.stringify({ openrouter: or, typesafe: ts }));
  } catch {}
}, { or: openrouter, ts: typesafe });

try {
  const page = await context.newPage();
  const beat = (ms) => page.waitForTimeout(ms);
  const warnings = [];
  const warn = (message) => { warnings.push(message); console.warn(`record-tour: WARNING ${message}`); };
  await page.goto(url);
  await page.locator("#models .model").first().waitFor({ timeout: 30000 }); // OpenRouter's model list is in
  await page.locator("#statsBtn:not([hidden])").waitFor({ timeout: 10000 }).catch(() => warn("the win rate summary is hidden: no saved games?"));
  await beat(600);
  const size = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio].join(" "));
  if (size !== "1280 720 1.5") throw new Error(`record-tour: the page is ${size} (width, height, scale), not 1280 720 1.5; adjust --window-size`);

  // Chrome sends a frame whenever the page repaints, stamped with the time it was drawn, and the
  // next one only after this one is acknowledged.
  const shots = [];
  let casting = true; // frames still in flight after a stop are acknowledged, not kept
  const cdp = await context.newCDPSession(page);
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    if (!casting) return;
    const file = resolve(frames, `${String(shots.length).padStart(6, "0")}.jpg`);
    writeFileSync(file, Buffer.from(data, "base64"));
    shots.push({ file, at: metadata.timestamp });
  });
  const cast = { format: "jpeg", quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 };
  const clock = () => Date.now() / 1000;
  // What goes in the video: spans of real time, with the waits between them cut out
  const spans = [];
  let spanStart = clock();
  await cdp.send("Page.startScreencast", cast);
  async function cut() {
    spans.push([spanStart, clock()]);
    casting = false;
    await cdp.send("Page.stopScreencast");
  }
  async function resume() {
    spanStart = clock();
    casting = true;
    await cdp.send("Page.startScreencast", cast);
    await page.mouse.move(pointer.x + 1, pointer.y); // a repaint, so the span opens on a fresh frame
    await page.mouse.move(pointer.x, pointer.y);
  }

  let pointer = { x: 640, y: 380 };
  async function glide(x, y, ms = 650) {
    const steps = Math.max(2, Math.round(ms / 25));
    const from = pointer;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const ease = t * t * (3 - 2 * t);
      await page.mouse.move(from.x + (x - from.x) * ease, from.y + (y - from.y) * ease);
      await beat(ms / steps);
    }
    pointer = { x, y };
  }
  async function to(locator, ms) {
    // lists that update as games move can replace an element between finding and measuring it
    let box = null;
    for (let k = 0; k < 40 && !box; k++) {
      box = await locator.boundingBox().catch(() => null);
      if (!box) await beat(50);
    }
    if (!box) throw new Error("record-tour: tried to reach something that is not on screen");
    await glide(box.x + box.width / 2, box.y + box.height / 2, ms);
  }
  async function press(locator, hold = 200) {
    await to(locator);
    await beat(hold);
    await page.mouse.down();
    await beat(90);
    await page.mouse.up();
  }
  async function clickAt(x, y) {
    await glide(x, y);
    await beat(200);
    await page.mouse.down();
    await beat(90);
    await page.mouse.up();
  }
  const caption = (text) => page.evaluate((t) => window.__caption(t), text);
  const square = async (sq) => {
    const b = await page.locator("#board").boundingBox(); // White at the bottom: the tour plays White
    const f = "abcdefgh".indexOf(sq[0]);
    const r = Number(sq[1]);
    return { x: b.x + ((f + 0.5) * b.width) / 8, y: b.y + ((8 - r + 0.5) * b.height) / 8 };
  };
  const moveCount = () => page.locator("#moves .mv").count();
  const waitMoves = (n, ms = 30000) =>
    page.waitForFunction((k) => document.querySelectorAll("#moves .mv").length >= k, n, { timeout: ms }).catch(() => warn(`the move list never reached ${n} moves`));
  const start = spanStart;

  // 1. The page
  await page.mouse.move(pointer.x, pointer.y);
  await beat(500);
  await caption("Jev, TypeSafe's System One model, plays chess against LLMs, the Stockfish engine and you.");
  await beat(3800);

  // 2. Jev's record
  await caption("Jev's win rate over every saved game: against humans, LLMs and engines.");
  await to(page.locator("#statsBtn"));
  await beat(2600);
  await press(page.locator("#statsBtn"));
  await page.locator("#statsDialog[open]").waitFor({ timeout: 5000 }).catch(() => warn("the record box did not open"));
  await caption("Click it for the record against each LLM and each engine level.");
  await beat(3400);
  await caption("A click anywhere outside the box closes it.");
  await beat(900);
  await clickAt(90, 640);
  await beat(700);
  if (await page.locator("#statsDialog[open]").count()) warn("a click outside did not close the record box");
  await beat(900);

  // 3. Opponents: Stockfish at a set strength and an LLM on OpenRouter
  await caption(`Pick opponents: Stockfish at a chosen strength, here Elo ${ELO}, and any LLM on OpenRouter.`);
  await press(page.locator(`#elos .chip[data-elo="${ELO}"]`));
  await beat(900);
  await caption("Free models are listed first; untick Free for all of them, and search.");
  await press(page.locator("#freeOnly"));
  await beat(500);
  await press(page.locator("#modelSearch"));
  await page.keyboard.type(OPPONENT.search, { delay: 70 });
  await beat(700);
  const pick = page.locator("#models .model", { hasText: OPPONENT.name }).first();
  if (!(await pick.count())) throw new Error(`record-tour: ${OPPONENT.name} is not in OpenRouter's list`);
  await press(pick);
  await beat(900);
  await caption("Jev plays White in both games. Fast plays each move as soon as it comes.");
  await press(page.locator('#pace button[data-v="0"]'));
  await beat(1400);
  await caption("Jev runs on a TypeSafe key; the LLM goes through OpenRouter. Keys stay in the browser.");
  await to(page.locator("#keysBtn"));
  await beat(2400);
  await press(page.locator("#startBtn"));

  // 4. Every board at once
  await caption("Both games run at once, and the screen splits so you can watch every board.");
  await waitMoves(6);
  const gifFrom = clock();
  await glide(700, 400, 900);
  await beat(4200);
  await caption("Jev answers in about a third of a second. The arrows are the moves it weighed.");
  await beat(4200);
  const gifTo = clock();

  // 5. One game up close: Jev against Stockfish
  await caption("Click a board to follow that game up close.");
  await press(page.locator("#boards .mini").first());
  await waitMoves(12);
  await beat(1200);
  // the last move Jev (White) made
  const jevMoves = page.locator("#moves .movegrid > .mv:nth-child(3n+2)");
  await press(jevMoves.nth(Math.max(0, (await jevMoves.count()) - 1)));
  await caption("Code describes every legal move in words; Jev picks one. The bars show how likely it thought each was.");
  await beat(1200);
  await page.evaluate(() => window.__overlays(false));
  await beat(350);
  await page.screenshot({ path: still, type: "jpeg", quality: 88 });
  await page.evaluate(() => window.__overlays(true));
  await beat(3400);
  await press(page.locator('[data-nav="end"]'));
  await beat(600);

  // 6. The LLM's side
  await press(page.locator("#matches .match").nth(1));
  await caption("The LLM gets the same described moves and answers with a move and one sentence about its idea.");
  await waitMoves(8);
  await to(page.locator("#playerTop .who"), 700);
  await beat(3400);
  const llmMoves = page.locator("#moves .movegrid > .mv:nth-child(3n)");
  await press(llmMoves.nth(Math.max(0, (await llmMoves.count()) - 1)));
  await beat(3000);
  await caption("The grid button brings back every board.");
  await press(page.locator("#gridBtn"));
  await beat(2200);

  // 7. The results, once both games are over: the wait is cut
  await caption("");
  await cut();
  await page.locator("#resultsDialog[open]").waitFor({ timeout: 40 * 60000 });
  await resume();
  const outcomes = await page.locator("#matches .match .res").allInnerTexts();
  await caption("Some minutes later, both games are over, and the table sums them up: results, time per move and cost.");
  await beat(5200);
  await press(page.locator("#resultsDialog .btn.primary"));
  await beat(500);
  await caption("Each board shows who won, or that it was a draw.");
  await glide(700, 420, 900);
  await beat(3600);
  await caption("Every finished game is saved on the server, without any key.");
  await press(page.locator('.modes button[data-mode="history"]'));
  await page.locator("#history .hgame").first().waitFor({ timeout: 10000 }).catch(() => warn("the saved list stayed empty"));
  await beat(1600);
  await press(page.locator("#history .hgame").first());
  await beat(900);
  await caption("Replay any game move by move, copy its PGN, or share a link to it.");
  await press(page.locator('[data-nav="start"]'));
  for (let k = 0; k < 6; k++) {
    await press(page.locator('[data-nav="next"]'), 120);
    await beat(380);
  }
  await beat(1400);
  await press(page.locator("#statsBtn"));
  await caption("The record counts the new games too.");
  await beat(3200);
  await clickAt(90, 640);
  await beat(900);

  // 8. You against Jev
  await caption("Or play Jev yourself: drag or click a piece, or type a move.");
  await press(page.locator('.modes button[data-mode="human"]'));
  await beat(600);
  await press(page.locator("#newGameBtn"));
  await beat(800);
  const e2 = await square("e2");
  const e4 = await square("e4");
  await glide(e2.x, e2.y);
  await page.mouse.down();
  await glide(e4.x, e4.y, 700); // a drag
  await page.mouse.up();
  await waitMoves(2);
  await beat(1400);
  await caption("Jev answers at once, and the arrows show what it weighed.");
  const g1 = await square("g1");
  const f3 = await square("f3");
  await clickAt(g1.x, g1.y);
  await beat(500);
  await clickAt(f3.x, f3.y);
  await waitMoves(4);
  await beat(1800);
  await press(page.locator("#moveInput"));
  await page.keyboard.type("Bc4", { delay: 110 });
  await beat(300);
  await page.keyboard.press("Enter");
  await waitMoves(6);
  await beat(2600);
  if ((await moveCount()) < 6) warn("the game against Jev did not reach three moves each");

  // 9. Dark theme
  await page.emulateMedia({ colorScheme: "dark" });
  await caption("Light and dark themes follow your system.");
  await beat(3400);
  await caption("");
  await beat(700);
  spans.push([spanStart, clock()]);
  casting = false;
  await cdp.send("Page.stopScreencast");
  await cdp.detach().catch(() => {});

  // ------------------------------------------------------------------ Encode
  // Each frame is shown until the next one arrives, within its span: frames come at a variable
  // rate, and resampling them to a fixed rate would duplicate frames unevenly.
  const list = ["ffconcat version 1.0"];
  let last = null;
  let length = 0;
  const videoTime = (t) => {
    let v = 0;
    for (const [a, b] of spans) {
      if (t >= b) v += b - a;
      else return v + Math.max(0, t - a);
    }
    return v;
  };
  for (const [a, b] of spans) {
    const inSpan = shots.filter((s) => s.at > a && s.at < b);
    const before = shots.filter((s) => s.at <= a).at(-1);
    const run = [...(before && a === start ? [before] : []), ...inSpan];
    run.forEach((shot, k) => {
      const stop = k + 1 < run.length ? run[k + 1].at : b;
      const d = stop - Math.max(shot.at, a);
      if (d <= 0) return;
      list.push(`file '${shot.file}'`, `duration ${d.toFixed(4)}`);
      last = shot;
      length += d;
    });
  }
  list.push(`file '${last.file}'`); // the concat demuxer ignores the last duration unless its file is repeated
  const listFile = resolve(raw, "frames.txt");
  await writeFile(listFile, list.join("\n") + "\n");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile,
    "-vf", "scale=1920:1080:flags=lanczos,format=yuv420p",
    "-fps_mode", "vfr",
    "-c:v", "libx264", "-preset", "slow", "-crf", "20",
    "-movflags", "+faststart", "-an", mp4,
  ], { stdio: ["ignore", "ignore", "inherit"] });

  // The gif is Jev's first moves against Stockfish: a whole tour at gif frame rates runs to megabytes.
  const gifStart = videoTime(gifFrom);
  const gifLength = Math.min(12, videoTime(gifTo) - gifStart);
  const palette = resolve(raw, "palette.png");
  const gifFilter = "fps=10,scale=720:-1:flags=lanczos";
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", gifStart.toFixed(2), "-t", gifLength.toFixed(2), "-i", mp4, "-vf", `${gifFilter},palettegen=stats_mode=diff:max_colors=128`, palette], { stdio: ["ignore", "ignore", "inherit"] });
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", gifStart.toFixed(2), "-t", gifLength.toFixed(2), "-i", mp4, "-i", palette, "-lavfi", `${gifFilter}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`, gif], { stdio: ["ignore", "ignore", "inherit"] });

  await rm(frames, { recursive: true, force: true });
  await rm(listFile, { force: true });
  await writeFile(resolve(raw, "take.json"), JSON.stringify({ url, seconds: length, cut: spans.length - 1, frames: shots.length, outcomes, gif: { start: gifStart, length: gifLength }, warnings }, null, 2));
  const mb = (path) => (statSync(path).size / 1e6).toFixed(1);
  console.log(`record-tour: tour.mp4 ${length.toFixed(1)}s ${mb(mp4)} MB from ${shots.length} frames, tour.gif ${gifLength.toFixed(1)}s ${mb(gif)} MB, results ${outcomes.join(" ")}, ${warnings.length} warnings`);
  if (warnings.length) process.exitCode = 1;
} finally {
  await browser.close();
}
