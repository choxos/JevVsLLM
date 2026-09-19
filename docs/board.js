/**
 * The chessboard: squares, pieces that slide from square to square, drag or click to move, a
 * promotion picker, and arrows. It knows nothing about the game; the page hands it a position
 * and the moves the player may make, and hears back which move was made.
 */
const FILES = "abcdefgh";
const PIECE = (code) => `pieces/${code}.svg`; // code: color + uppercase type, e.g. "wN"

function placement(fen) {
  const out = new Map();
  fen.split(" ")[0].split("/").forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else out.set(`${FILES[f++]}${8 - r}`, (ch === ch.toUpperCase() ? "w" : "b") + ch.toUpperCase());
    }
  });
  return out;
}

export function createBoard(root, { onMove }) {
  const sqLayer = document.createElement("div");
  sqLayer.className = "sqs";
  const pcLayer = document.createElement("div");
  pcLayer.className = "pieces";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "arrows");
  svg.setAttribute("viewBox", "0 0 8 8");
  root.append(sqLayer, pcLayer, svg);

  let st = { fen: "8/8/8/8/8/8/8/8 w - - 0 1", flip: null, last: null, check: null, movable: null, arrows: [] };
  let pieces = new Map(); // square -> {el, code}
  let squares = new Map(); // square -> el
  let selected = null;
  let drag = null;
  let promo = null;

  const xy = (sq) => {
    const f = FILES.indexOf(sq[0]);
    const r = Number(sq[1]);
    return st.flip ? [7 - f, r - 1] : [f, 8 - r];
  };
  const place = (el, sq) => {
    const [x, y] = xy(sq);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
  };

  function buildSquares() {
    sqLayer.textContent = "";
    squares = new Map();
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const f = st.flip ? 7 - x : x;
        const r = st.flip ? y + 1 : 8 - y;
        const sq = `${FILES[f]}${r}`;
        const el = document.createElement("div");
        el.className = `sq${(f + r) % 2 === 1 ? " d" : ""}`; // a1 (file 0, rank 1) is dark
        if (y === 7) el.insertAdjacentHTML("beforeend", `<span class="co f">${FILES[f]}</span>`);
        if (x === 0) el.insertAdjacentHTML("beforeend", `<span class="co r">${r}</span>`);
        squares.set(sq, el);
        sqLayer.append(el);
      }
    }
  }

  function renderPieces(animate) {
    const next = placement(st.fen);
    const old = pieces;
    const used = new Set();
    pieces = new Map();
    const take = (sq, code) => {
      const p = old.get(sq);
      if (p && !used.has(sq)) {
        used.add(sq);
        if (p.code !== code) (p.el.src = PIECE(code)), (p.code = code);
        return p;
      }
      return null;
    };
    // Pieces that moved come from their old squares, so the CSS transition slides them over
    const moved = new Map();
    if (animate) {
      moved.set(animate.to, animate.from);
      if (animate.rook) moved.set(animate.rook.to, animate.rook.from);
    }
    for (const [sq, code] of next) if (old.get(sq)?.code === code && !moved.has(sq)) pieces.set(sq, take(sq, code));
    for (const [sq, code] of next) {
      if (pieces.has(sq)) continue;
      let p = moved.has(sq) ? take(moved.get(sq), code) : null;
      if (!p) {
        const el = document.createElement("img");
        el.className = "pc still";
        el.alt = "";
        el.draggable = false;
        el.src = PIECE(code);
        p = { el, code };
        place(el, sq);
        pcLayer.append(el);
        requestAnimationFrame(() => el.classList.remove("still"));
      }
      place(p.el, sq);
      pieces.set(sq, p);
    }
    for (const [sq, p] of old) if (!used.has(sq)) p.el.remove();
  }

  function renderMarks() {
    for (const [sq, el] of squares) {
      el.classList.toggle("last", Boolean(st.last && (st.last.from === sq || st.last.to === sq)));
      el.classList.toggle("check", st.check === sq);
      el.classList.toggle("sel", selected === sq);
      const target = Boolean(selected && st.movable?.get(selected)?.some((m) => m.to === sq));
      el.classList.toggle("target", target);
      el.classList.toggle("occ", target && pieces.has(sq));
    }
  }

  function renderArrows() {
    const ns = "http://www.w3.org/2000/svg";
    svg.textContent = "";
    for (const a of [...st.arrows].sort((p, q) => p.w - q.w)) {
      const [x1, y1] = xy(a.from).map((v) => v + 0.5);
      const [x2, y2] = xy(a.to).map((v) => v + 0.5);
      const len = Math.hypot(x2 - x1, y2 - y1);
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const width = 0.1 + 0.12 * a.w;
      const head = 0.32;
      const ex = x2 - ux * head;
      const ey = y2 - uy * head;
      const g = document.createElementNS(ns, "g");
      g.setAttribute("opacity", String(a.main ? 0.85 : 0.25 + 0.55 * a.w));
      g.setAttribute("fill", "var(--accent)");
      const line = document.createElementNS(ns, "line");
      Object.entries({ x1: x1 + ux * 0.2, y1: y1 + uy * 0.2, x2: ex, y2: ey, stroke: "var(--accent)", "stroke-width": width, "stroke-linecap": "round" }).forEach(([k, v]) => line.setAttribute(k, v));
      const tri = document.createElementNS(ns, "polygon");
      const px = -uy * (width + 0.14);
      const py = ux * (width + 0.14);
      tri.setAttribute("points", `${x2 - ux * 0.08},${y2 - uy * 0.08} ${ex + px},${ey + py} ${ex - px},${ey - py}`);
      g.append(line, tri);
      svg.append(g);
    }
  }

  function set(next, { animate = null } = {}) {
    const flipChanged = next.flip !== undefined && next.flip !== st.flip;
    const fenChanged = next.fen && next.fen !== st.fen;
    st = { ...st, ...next };
    if (flipChanged) {
      buildSquares();
      for (const [sq, p] of pieces) p.el.classList.add("still"), place(p.el, sq), requestAnimationFrame(() => p.el.classList.remove("still"));
    }
    if (fenChanged || flipChanged) {
      selected = selected && st.movable?.has(selected) ? selected : null;
      closePromo();
    }
    if (!st.movable) selected = null;
    renderPieces(fenChanged ? animate : null);
    renderMarks();
    renderArrows();
  }

  // ------------------------------------------------------------------ input
  function squareAt(e) {
    const r = root.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * 8);
    const y = Math.floor(((e.clientY - r.top) / r.height) * 8);
    if (x < 0 || x > 7 || y < 0 || y > 7) return null;
    const f = st.flip ? 7 - x : x;
    const rank = st.flip ? y + 1 : 8 - y;
    return `${FILES[f]}${rank}`;
  }

  function closePromo() {
    promo?.remove();
    promo = null;
  }

  function tryMove(from, to) {
    const options = st.movable?.get(from)?.filter((m) => m.to === to) || [];
    if (!options.length) return false;
    selected = null;
    if (options.length > 1) {
      // Several moves share the squares: a promotion. Ask which piece; the pawn waits at home.
      const pawn = pieces.get(from);
      if (pawn) place(pawn.el, from);
      const color = pawn?.code[0] || "w";
      const [x, y] = xy(to);
      promo = document.createElement("div");
      promo.className = "promo";
      promo.style.left = `${x * 12.5}%`;
      const down = y === 0;
      promo.style[down ? "top" : "bottom"] = down ? "0" : `${(7 - y) * 12.5}%`;
      for (const t of ["q", "n", "r", "b"]) {
        const b = document.createElement("button");
        b.type = "button";
        b.innerHTML = `<img src="${PIECE(color + t.toUpperCase())}" alt="${{ q: "Queen", n: "Knight", r: "Rook", b: "Bishop" }[t]}">`;
        b.addEventListener("pointerdown", (e) => e.stopPropagation()); // the board would close the picker first
        b.addEventListener("click", () => (closePromo(), onMove(from, to, t)));
        promo.append(b);
      }
      root.append(promo);
    } else onMove(from, to, options[0].promotion);
    renderMarks();
    return true;
  }

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (promo) return closePromo();
    const sq = squareAt(e);
    if (!sq || !st.movable) return;
    if (selected && selected !== sq && tryMove(selected, sq)) return;
    if (st.movable.has(sq)) {
      selected = sq;
      const p = pieces.get(sq);
      if (p) {
        root.setPointerCapture(e.pointerId);
        drag = { from: sq, el: p.el, id: e.pointerId, moved: false, x: e.clientX, y: e.clientY };
      }
    } else selected = null;
    renderMarks();
  });

  root.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    const r = root.getBoundingClientRect();
    const s = r.width / 8;
    drag.el.classList.add("drag");
    drag.el.style.transform = `translate(${e.clientX - r.left - s / 2}px, ${e.clientY - r.top - s / 2}px)`;
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { from, el, moved } = drag;
    drag = null;
    el.classList.remove("drag");
    if (!moved) return;
    el.classList.add("still");
    const to = e.type === "pointerup" ? squareAt(e) : null;
    if (!to || to === from || !tryMove(from, to)) place(el, from);
    requestAnimationFrame(() => el.classList.remove("still"));
  };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);

  buildSquares();
  return { set };
}
