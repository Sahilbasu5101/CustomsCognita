/* CustomsCognita — Cinematic scroll film engine
   Canvas image-sequence scrubber: scroll position drives frame index.
   Frames are kept as compressed blobs; only a sliding window around the
   current frame is decoded to ImageBitmaps (keeps RAM sane on mobile).
   Falls back to a procedural 3D canvas animation when no frames are built. */

const canvas = document.getElementById("film");
const ctx = canvas.getContext("2d");
const track = document.getElementById("track");
const loader = document.getElementById("loader");
const loadbar = document.getElementById("loadbar");
const scrollCue = document.getElementById("scroll-cue");
const captions = [...document.querySelectorAll(".caption")];

const KEEP = 120;
const AHEAD = 30;

const state = {
  blobs: [],
  bitmaps: new Map(),
  count: 0,
  pattern: "",
  current: -1,
  target: 0,
  smooth: 0,
  dir: 1,
  ready: false,
  decoding: new Set(),
};

/* ── loading ─────────────────────────────────────────── */

async function loadManifest() {
  const res = await fetch("frames/frames.json");
  if (!res.ok) throw new Error("no manifest");
  return res.json();
}

function frameURL(i) {
  return state.pattern.replace("%04d", String(i + 1).padStart(4, "0"));
}

async function fetchBlob(i) {
  if (state.blobs[i]) return state.blobs[i];
  const res = await fetch(frameURL(i));
  state.blobs[i] = await res.blob();
  return state.blobs[i];
}

async function decode(i) {
  if (state.bitmaps.has(i) || state.decoding.has(i)) return;
  state.decoding.add(i);
  try {
    if (!state.blobs[i]) await fetchBlob(i);
    const bmp = await createImageBitmap(state.blobs[i]);
    state.bitmaps.set(i, bmp);
  } catch { /* transient decode failure — retried next tick */ }
  state.decoding.delete(i);
}

function manageWindow(center) {
  for (let d = 0; d <= AHEAD; d++) {
    const fwd = center + d * state.dir;
    const back = center - Math.min(d, 8) * state.dir;
    if (fwd >= 0 && fwd < state.count) decode(fwd);
    if (back >= 0 && back < state.count) decode(back);
  }
  if (state.bitmaps.size > KEEP * 2) {
    for (const [idx, bmp] of state.bitmaps) {
      if (Math.abs(idx - center) > KEEP) {
        bmp.close();
        state.bitmaps.delete(idx);
      }
    }
  }
}

async function preload() {
  const { count } = state;
  const EAGER = Math.min(Math.ceil(count * 0.15), 80);
  let done = 0;
  await Promise.all(
    Array.from({ length: EAGER }, (_, i) =>
      fetchBlob(i).then(() => {
        done++;
        loadbar.style.width = `${(done / EAGER) * 100}%`;
      })
    )
  );
  await decode(0);
  state.ready = true;
  loader.classList.add("done");
  let next = EAGER;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (next < count) {
        const i = next++;
        try { await fetchBlob(i); } catch { /* refetched on demand */ }
      }
    })
  );
}

/* ── drawing ─────────────────────────────────────────── */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  state.current = -1;
}

function nearestDecoded(i) {
  if (state.bitmaps.has(i)) return i;
  for (let d = 1; d < state.count; d++) {
    if (state.bitmaps.has(i - d)) return i - d;
    if (state.bitmaps.has(i + d)) return i + d;
  }
  return -1;
}

function drawFrame(i) {
  const j = nearestDecoded(i);
  if (j < 0) return;
  const bmp = state.bitmaps.get(j);
  const cw = canvas.width, ch = canvas.height;
  ctx.fillStyle = "#050811";
  ctx.fillRect(0, 0, cw, ch);
  const s = Math.min(cw / bmp.width, ch / bmp.height) * 1.04;
  const w = bmp.width * s, h = bmp.height * s;
  ctx.drawImage(bmp, (cw - w) / 2, (ch - h) / 2, w, h);
  state.current = j;
}

/* ── scroll mapping ──────────────────────────────────── */

function progress() {
  const max = track.offsetHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

function updateCaptions(p) {
  for (const el of captions) {
    const tIn = +el.dataset.in, tHold = +el.dataset.hold, tOut = +el.dataset.out;
    const rise = Math.max((tHold - tIn) * 0.4, 0.008);
    const fall = Math.max((tOut - tHold) * 0.6, 0.008);
    let o = 0;
    if (p >= tIn && p <= tOut) {
      o = Math.min((p - tIn) / rise, 1) * Math.min((tOut - p) / fall, 1);
      o = Math.min(Math.max(o, 0), 1);
    }
    el.style.opacity = o.toFixed(3);
    const drift = (p - tHold) * -40;
    el.style.transform = `${transformBase(el)} translateY(${drift.toFixed(1)}px)`;
  }
  scrollCue.style.opacity = p < 0.015 ? 1 : 0;
}

function transformBase(el) {
  if (el.classList.contains("cap-center")) return "translate(-50%, -50%)";
  if (el.classList.contains("cap-top") || el.classList.contains("cap-bottom")) return "translateX(-50%)";
  return "translateY(-50%)";
}

/* ── main loop ───────────────────────────────────────── */

let lastT = performance.now();
function tick(now) {
  const dt = Math.min((now - lastT) / 1000, 0.5) || 0.016;
  lastT = now;
  if (state.ready) {
    const p = progress();
    const prevTarget = state.target;
    state.target = p * (state.count - 1);
    if (state.target !== prevTarget) state.dir = state.target >= prevTarget ? 1 : -1;
    const k = 1 - Math.exp(-dt * 14);
    state.smooth += (state.target - state.smooth) * k;
    if (Math.abs(state.target - state.smooth) < 0.5) state.smooth = state.target;
    const i = Math.round(state.smooth);
    manageWindow(i);
    if (i !== state.current) drawFrame(i);
    updateCaptions(p);
  }
  requestAnimationFrame(tick);
}

/* ── dev placeholder (procedural 3D canvas) ─────────── */

function devPlaceholder() {
  loader.classList.add("done");

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  function ensureSize() {
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  ensureSize();
  window.addEventListener("resize", ensureSize);

  // Chapter visual descriptors used in the animated dev mode
  const CHAPTERS = [
    { label: "Chapter 1", sub: "Floating Cargo Entity", color: "#00f0ff" },
    { label: "Chapter 2", sub: "Document Ingestion & Laser Scan", color: "#00c8ff" },
    { label: "Chapter 3", sub: "Cross-Document Neural Matrix", color: "#0090ff" },
    { label: "Chapter 4", sub: "Deterministic Rule Engine", color: "#00e87a" },
    { label: "Chapter 5", sub: "Clearance Seal", color: "#00f0ff" },
    { label: "Chapter 6", sub: "Global Trade Network", color: "#4080ff" },
  ];

  const CHAPTER_BEATS = [0, 0.15, 0.35, 0.55, 0.75, 0.90];

  function getChapter(p) {
    let ch = 0;
    for (let i = 0; i < CHAPTER_BEATS.length; i++) {
      if (p >= CHAPTER_BEATS[i]) ch = i;
    }
    return ch;
  }

  function getChapterProgress(p) {
    const ch = getChapter(p);
    const start = CHAPTER_BEATS[ch];
    const end = CHAPTER_BEATS[ch + 1] ?? 1.0;
    return (p - start) / (end - start);
  }

  // Particle system
  const particles = Array.from({ length: 60 }, () => ({
    x: Math.random(),
    y: Math.random(),
    vx: (Math.random() - 0.5) * 0.0003,
    vy: (Math.random() - 0.5) * 0.0003,
    r: Math.random() * 1.5 + 0.5,
    alpha: Math.random() * 0.5 + 0.1,
  }));

  // Grid nodes for rule engine
  const nodes = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 7; col++) {
      nodes.push({
        x: 0.15 + col * 0.1,
        y: 0.25 + row * 0.12,
        phase: Math.random() * Math.PI * 2,
        state: Math.random() > 0.3 ? "green" : "amber",
      });
    }
  }

  let animT = 0;
  function drawDev(now) {
    animT = now * 0.001;
    const p = progress();
    const ch = getChapter(p);
    const chP = getChapterProgress(p);
    const cw = canvas.width, ch_h = canvas.height;
    const info = CHAPTERS[ch];

    // Background gradient
    const bg = ctx.createRadialGradient(cw * 0.5, ch_h * 0.5, 0, cw * 0.5, ch_h * 0.5, Math.max(cw, ch_h) * 0.8);
    bg.addColorStop(0, "#080d1a");
    bg.addColorStop(1, "#050811");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cw, ch_h);

    // Animated grid
    ctx.save();
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = info.color;
    ctx.lineWidth = 0.5 * dpr;
    const gStep = 60 * dpr;
    for (let x = 0; x < cw; x += gStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ch_h); ctx.stroke(); }
    for (let y = 0; y < ch_h; y += gStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cw, y); ctx.stroke(); }
    ctx.restore();

    // Particles
    ctx.save();
    for (const pt of particles) {
      pt.x += pt.vx; pt.y += pt.vy;
      if (pt.x < 0) pt.x = 1; if (pt.x > 1) pt.x = 0;
      if (pt.y < 0) pt.y = 1; if (pt.y > 1) pt.y = 0;
      ctx.globalAlpha = pt.alpha * 0.6;
      ctx.fillStyle = info.color;
      ctx.beginPath();
      ctx.arc(pt.x * cw, pt.y * ch_h, pt.r * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Chapter-specific visuals
    if (ch === 0) {
      // Floating container wireframe
      drawContainer(cw, ch_h, chP, info.color, dpr, animT);
    } else if (ch === 1) {
      // Holographic document sheets
      drawDocuments(cw, ch_h, chP, info.color, dpr, animT);
    } else if (ch === 2) {
      // Cross-doc beams
      drawCrossDoc(cw, ch_h, chP, info.color, dpr, animT);
    } else if (ch === 3) {
      // Rule tree nodes
      drawRuleTree(cw, ch_h, chP, info.color, dpr, animT, nodes);
    } else if (ch === 4) {
      // Clearance seal
      drawClearanceSeal(cw, ch_h, chP, info.color, dpr, animT);
    } else {
      // Global network
      drawGlobalNetwork(cw, ch_h, chP, info.color, dpr, animT);
    }

    // Scan line
    ctx.save();
    const scanY = (ch_h * 0.3 + Math.sin(animT * 0.7) * ch_h * 0.2);
    const scanG = ctx.createLinearGradient(0, scanY - 30 * dpr, 0, scanY + 30 * dpr);
    scanG.addColorStop(0, "transparent");
    scanG.addColorStop(0.5, `${info.color}18`);
    scanG.addColorStop(1, "transparent");
    ctx.fillStyle = scanG;
    ctx.fillRect(0, scanY - 30 * dpr, cw, 60 * dpr);
    ctx.restore();

    // Chapter label (dev mode watermark)
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = info.color;
    ctx.font = `${10 * dpr}px -apple-system, monospace`;
    ctx.textAlign = "right";
    ctx.fillText(`DEV MODE · ${info.label} · ${info.sub}`, cw - 20 * dpr, ch_h - 20 * dpr);
    ctx.restore();

    updateCaptions(p);
    scrollCue.style.opacity = p < 0.015 ? 1 : 0;
    requestAnimationFrame(drawDev);
  }

  requestAnimationFrame(drawDev);
  state.ready = true; // Allow captions to animate
}

function drawContainer(cw, ch_h, p, color, dpr, t) {
  ctx.save();
  ctx.translate(cw * 0.5, ch_h * 0.45 + Math.sin(t * 0.4) * 8 * dpr);
  ctx.rotate(Math.sin(t * 0.15) * 0.04);

  const S = Math.min(cw, ch_h) * 0.22;
  const pts3d = (x, y, z) => {
    const iso = { x: (x - z) * Math.cos(Math.PI / 6), y: y - (x + z) * Math.sin(Math.PI / 6) };
    return [iso.x * S, iso.y * S];
  };

  const corners = [
    [0,0,0],[1,0,0],[1,1,0],[0,1,0],
    [0,0,1],[1,0,1],[1,1,1],[0,1,1],
  ];
  const edges = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.globalAlpha = 0.7;

  for (const [a, b] of edges) {
    const [ax, ay] = pts3d(...corners[a]);
    const [bx, by] = pts3d(...corners[b]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }

  // Telemetry grid lines on top face
  ctx.globalAlpha = 0.25;
  ctx.strokeStyle = color;
  ctx.lineWidth = 0.8 * dpr;
  for (let i = 0.2; i < 1; i += 0.2) {
    const [ax, ay] = pts3d(i, 0, 0); const [bx, by] = pts3d(i, 0, 1);
    const [cx, cy] = pts3d(0, 0, i); const [dx, dy] = pts3d(1, 0, i);
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(dx, dy); ctx.stroke();
  }

  // Pulsing center glow
  ctx.globalAlpha = 0.15 + Math.sin(t * 2) * 0.08;
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, S * 0.6);
  grd.addColorStop(0, color);
  grd.addColorStop(1, "transparent");
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, S * 0.6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawDocuments(cw, ch_h, p, color, dpr, t) {
  ctx.save();
  const sheets = [
    { x: 0.5, label: "Invoice" },
    { x: 0.5 + (p * 0.18), label: "Packing List" },
    { x: 0.5 - (p * 0.18), label: "Bill of Lading" },
  ];
  const W = cw * 0.18, H = ch_h * 0.38;

  for (let s = 0; s < sheets.length; s++) {
    const sh = sheets[s];
    const sx = sh.x * cw, sy = ch_h * 0.44;
    const tilt = (s - 1) * p * 0.2;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(tilt);

    // Glass panel
    ctx.globalAlpha = 0.08 + s * 0.02;
    ctx.fillStyle = color;
    ctx.fillRect(-W / 2, -H / 2, W, H);

    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(-W / 2, -H / 2, W, H);

    // Data lines
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = color;
    for (let row = 0; row < 8; row++) {
      const rw = (0.4 + Math.random() * 0.4) * W;
      ctx.fillRect(-W / 2 + W * 0.1, -H / 2 + H * (0.12 + row * 0.1), rw, 2 * dpr);
    }

    // Label
    ctx.globalAlpha = 0.6;
    ctx.font = `bold ${8 * dpr}px monospace`;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(sh.label, 0, -H / 2 - 8 * dpr);

    ctx.restore();
  }

  // Laser scan line
  ctx.globalAlpha = 0.5;
  const scanY = ch_h * 0.3 + Math.sin(t * 3) * ch_h * 0.12;
  const lg = ctx.createLinearGradient(0, 0, cw, 0);
  lg.addColorStop(0, "transparent");
  lg.addColorStop(0.3, color);
  lg.addColorStop(0.7, color);
  lg.addColorStop(1, "transparent");
  ctx.strokeStyle = lg;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.moveTo(0, scanY); ctx.lineTo(cw, scanY); ctx.stroke();

  ctx.restore();
}

function drawCrossDoc(cw, ch_h, p, color, dpr, t) {
  ctx.save();
  const docW = cw * 0.18, docH = ch_h * 0.36;
  const leftX = cw * 0.28, rightX = cw * 0.72, docY = ch_h * 0.45;

  // Two document panels
  for (const dx of [leftX, rightX]) {
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = color;
    ctx.fillRect(dx - docW / 2, docY - docH / 2, docW, docH);
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(dx - docW / 2, docY - docH / 2, docW, docH);
    for (let row = 0; row < 7; row++) {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = color;
      ctx.fillRect(dx - docW * 0.35, docY - docH * 0.35 + row * docH * 0.1, docW * 0.7, 1.5 * dpr);
    }
  }

  // Energy beams between matching fields
  ctx.lineWidth = 1 * dpr;
  for (let row = 0; row < 5; row++) {
    const ly = docY - docH * 0.28 + row * docH * 0.1;
    const ry = ly + Math.sin(t + row) * 5 * dpr;
    const isFlag = row === 2;
    const beamColor = isFlag ? "#ff3860" : color;
    ctx.globalAlpha = isFlag ? 0.7 : 0.35 + Math.sin(t * 2 + row) * 0.15;
    ctx.strokeStyle = beamColor;
    ctx.beginPath();
    ctx.moveTo(leftX + docW / 2, ly);
    ctx.bezierCurveTo(cw / 2, ly, cw / 2, ry, rightX - docW / 2, ry);
    ctx.stroke();

    if (isFlag) {
      // Red pulse dot
      ctx.globalAlpha = 0.8 + Math.sin(t * 6) * 0.2;
      ctx.fillStyle = "#ff3860";
      ctx.beginPath();
      ctx.arc(cw / 2, (ly + ry) / 2, 4 * dpr, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function drawRuleTree(cw, ch_h, p, color, dpr, t, nodes) {
  ctx.save();
  // Draw connections
  for (let i = 0; i < nodes.length - 7; i++) {
    const a = nodes[i], b = nodes[i + 7];
    ctx.globalAlpha = 0.12;
    ctx.strokeStyle = a.state === "green" ? "#00e87a" : "#f0a500";
    ctx.lineWidth = 0.8 * dpr;
    ctx.beginPath();
    ctx.moveTo(a.x * cw, a.y * ch_h);
    ctx.lineTo(b.x * cw, b.y * ch_h);
    ctx.stroke();
  }
  // Draw nodes
  for (const nd of nodes) {
    const pulse = 0.5 + Math.sin(t * 3 + nd.phase) * 0.4;
    ctx.globalAlpha = 0.4 + pulse * 0.5;
    ctx.fillStyle = nd.state === "green" ? "#00e87a" : "#f0a500";
    ctx.beginPath();
    ctx.arc(nd.x * cw, nd.y * ch_h, (3 + pulse * 2) * dpr, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 0.15 + pulse * 0.1;
    const grd = ctx.createRadialGradient(nd.x * cw, nd.y * ch_h, 0, nd.x * cw, nd.y * ch_h, 20 * dpr);
    grd.addColorStop(0, nd.state === "green" ? "#00e87a" : "#f0a500");
    grd.addColorStop(1, "transparent");
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(nd.x * cw, nd.y * ch_h, 20 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawClearanceSeal(cw, ch_h, p, color, dpr, t) {
  ctx.save();
  ctx.translate(cw * 0.5, ch_h * 0.45);

  // Outer ring
  const R = Math.min(cw, ch_h) * 0.18;
  ctx.globalAlpha = 0.15 + Math.sin(t * 2) * 0.05;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.arc(0, 0, R, 0, Math.PI * 2);
  ctx.stroke();

  // Inner tick marks (like a seal)
  ctx.globalAlpha = 0.5;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const inner = R * 0.88, outer = R * 0.97;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * outer, Math.sin(a) * outer);
    ctx.stroke();
  }

  // Checkmark
  ctx.globalAlpha = 0.8 + Math.sin(t * 3) * 0.2;
  ctx.strokeStyle = "#00e87a";
  ctx.lineWidth = 3 * dpr;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-R * 0.3, 0);
  ctx.lineTo(-R * 0.05, R * 0.3);
  ctx.lineTo(R * 0.35, -R * 0.28);
  ctx.stroke();

  // Glow
  const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, R * 1.4);
  grd.addColorStop(0, `${color}20`);
  grd.addColorStop(1, "transparent");
  ctx.globalAlpha = 0.6 + Math.sin(t * 2) * 0.3;
  ctx.fillStyle = grd;
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function drawGlobalNetwork(cw, ch_h, p, color, dpr, t) {
  ctx.save();
  // Network nodes — trade hubs
  const hubs = [
    { x: 0.5, y: 0.45, label: "CUSTOMSCOGNITA" },
    { x: 0.22, y: 0.3, label: "INDIA" },
    { x: 0.78, y: 0.3, label: "EU / TARIC" },
    { x: 0.15, y: 0.6, label: "SE ASIA" },
    { x: 0.85, y: 0.6, label: "US CBP" },
    { x: 0.5, y: 0.7, label: "MIDDL EAST" },
  ];

  // Draw connections
  for (let i = 1; i < hubs.length; i++) {
    const a = hubs[0], b = hubs[i];
    const pulse = (Math.sin(t * 2 + i) + 1) / 2;
    ctx.globalAlpha = 0.1 + pulse * 0.2;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1 * dpr;
    ctx.setLineDash([4 * dpr, 8 * dpr]);
    ctx.lineDashOffset = -t * 20 * dpr;
    ctx.beginPath();
    ctx.moveTo(a.x * cw, a.y * ch_h);
    ctx.lineTo(b.x * cw, b.y * ch_h);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draw hub nodes
  for (let i = 0; i < hubs.length; i++) {
    const hub = hubs[i];
    const isCenter = i === 0;
    const pulse = 0.5 + Math.sin(t * 2 + i * 1.3) * 0.4;
    const R = isCenter ? 12 * dpr : 6 * dpr;

    ctx.globalAlpha = 0.6 + pulse * 0.4;
    ctx.fillStyle = isCenter ? color : `${color}aa`;
    ctx.beginPath();
    ctx.arc(hub.x * cw, hub.y * ch_h, R, 0, Math.PI * 2);
    ctx.fill();

    // Ping ring
    if (isCenter) {
      ctx.globalAlpha = (1 - (t % 2) / 2) * 0.4;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5 * dpr;
      ctx.beginPath();
      ctx.arc(hub.x * cw, hub.y * ch_h, R + (t % 2) * 40 * dpr, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Label
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = color;
    ctx.font = `${7 * dpr}px monospace`;
    ctx.textAlign = "center";
    ctx.fillText(hub.label, hub.x * cw, hub.y * ch_h + R + 12 * dpr);
  }

  ctx.restore();
}

/* ── boot ──────────────────────────────────────────────── */

window.addEventListener("resize", resize);
resize();

loadManifest()
  .then((m) => {
    state.count = m.count;
    state.pattern = m.pattern;
    state.blobs = new Array(m.count).fill(null);
    requestAnimationFrame(tick);
    return preload();
  })
  .catch(() => devPlaceholder());
