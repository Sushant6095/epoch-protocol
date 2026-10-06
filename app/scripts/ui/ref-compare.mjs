#!/usr/bin/env node
// Epoch — compare a built page with its Refero reference, structure only.
//
//   node scripts/ui/ref-compare.mjs <route> <name> --ref <image> [--width 1440] [--base URL] [--settle ms]
//   node scripts/ui/ref-compare.mjs /terminal terminal --ref design/screens/terminal/ref-primary-18cf9c6a.png
//
// Takes a full-page screenshot of the route at the reference's viewport width (default 1440), scales both
// images to the same width, and writes three images to design/screens/compare/:
//   <name>-side.png     reference left, ours right
//   <name>-overlay.png  ours with the reference at 50% on top
//   <name>-edges.png    edges only: reference in orange, ours in mint, overlap in white
// It also prints two alignment scores (0–1): rows (vertical rhythm: where regions start and end) and
// columns (the grid: where the columns and gutters sit). Aim for ≥ 0.85 on both at the reference width, then
// fix whatever the overlay shows off by more than 8 px. Colours are ignored on purpose: the palette is
// Epoch's own, only the structure has to match.
// Reference images stay on your machine (design/screens/** is git-ignored for ref-*). No extra
// dependencies: the image work runs inside Playwright's browser.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(["--ref", "--width", "--base", "--settle"]);
const values = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (VALUE_OPTS.has(args[i])) values[args[i].slice(2)] = args[++i];
  else positional.push(args[i]);
}
const route = positional.find((a) => a.startsWith("/") || a.includes("://")) ?? "/";
const name = positional.find((a) => !a.startsWith("/") && !a.includes("://")) ?? "page";
if (!values.ref) {
  console.error("Missing --ref <image>. Pull it first with refero_get_screen_image (image_size: \"full\").");
  process.exit(2);
}
const width = Number(values.width ?? 1440);
const settle = Number(values.settle ?? 1200);
const base = values.base ?? process.env.EPOCH_APP_URL ?? "http://localhost:3000";
const target = /^(https?|file):/.test(route) ? route : base + route;

const refBuf = await readFile(values.ref);
const refType = values.ref.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
const outDir = path.resolve("design/screens/compare");
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const ctx = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, colorScheme: "dark", reducedMotion: "reduce" });
const page = await ctx.newPage();
await page.goto(target, { waitUntil: "networkidle" });
await page.waitForTimeout(settle);
const ours = await page.screenshot({ fullPage: true });

const lab = await ctx.newPage();
await lab.setContent("<!doctype html><body style='margin:0;background:#000'></body>");
const result = await lab.evaluate(
  async ({ refSrc, oursSrc }) => {
    const load = (src) => new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = bad; i.src = src; });
    const [ref, own] = await Promise.all([load(refSrc), load(oursSrc)]);
    const W = Math.min(ref.naturalWidth, own.naturalWidth, 1440);
    const hRef = Math.round(ref.naturalHeight * W / ref.naturalWidth);
    const hOwn = Math.round(own.naturalHeight * W / own.naturalWidth);
    const H = Math.min(hRef, hOwn, 6000);
    const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };
    const draw = (img, h) => { const c = canvas(W, H); c.getContext("2d").drawImage(img, 0, 0, W, h); return c; };
    const cRef = draw(ref, hRef), cOwn = draw(own, hOwn);
    const gray = (c) => { const d = c.getContext("2d").getImageData(0, 0, W, H).data; const g = new Float32Array(W * H);
      for (let i = 0; i < W * H; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]; return g; };
    // Edges after normalising each image's contrast, so a dark palette and a light palette compare fairly.
    const edges = (g) => { let lo = 255, hi = 0; for (const v of g) { if (v < lo) lo = v; if (v > hi) hi = v; }
      const k = 255 / Math.max(1, hi - lo); const e = new Uint8Array(W * H);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x;
        const gx = (g[i + 1] - g[i - 1]) * k, gy = (g[i + W] - g[i - W]) * k; e[i] = Math.hypot(gx, gy) > 38 ? 1 : 0; }
      return e; };
    const eRef = edges(gray(cRef)), eOwn = edges(gray(cOwn));
    const profile = (e, byRow) => { const n = byRow ? H : W; const p = new Float32Array(n);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (e[y * W + x]) p[byRow ? y : x]++; return p; };
    const smooth = (p, r) => p.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - r); j <= Math.min(p.length - 1, i + r); j++) { s += p[j]; c++; } return s / c; });
    const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
      let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; } return s / Math.sqrt(sa * sb || 1); };
    const rows = corr(smooth(profile(eRef, true), 6), smooth(profile(eOwn, true), 6));
    const cols = corr(smooth(profile(eRef, false), 6), smooth(profile(eOwn, false), 6));
    // side by side
    const side = canvas(W * 2 + 24, H); const s = side.getContext("2d"); s.fillStyle = "#222"; s.fillRect(0, 0, side.width, H);
    s.drawImage(cRef, 0, 0); s.drawImage(cOwn, W + 24, 0);
    // overlay
    const over = canvas(W, H); const o = over.getContext("2d"); o.drawImage(cOwn, 0, 0); o.globalAlpha = 0.5; o.drawImage(cRef, 0, 0);
    // edges
    const ed = canvas(W, H); const ectx = ed.getContext("2d"); const img = ectx.createImageData(W, H);
    for (let i = 0; i < W * H; i++) { const a = eRef[i], b = eOwn[i]; const j = i * 4;
      if (a && b) { img.data[j] = 255; img.data[j + 1] = 255; img.data[j + 2] = 255; }
      else if (a) { img.data[j] = 245; img.data[j + 1] = 165; img.data[j + 2] = 91; }
      else if (b) { img.data[j] = 151; img.data[j + 1] = 252; img.data[j + 2] = 215; }
      img.data[j + 3] = 255; }
    ectx.putImageData(img, 0, 0);
    return { W, H, hRef, hOwn, rows, cols, side: side.toDataURL("image/png"), overlay: over.toDataURL("image/png"), edges: ed.toDataURL("image/png") };
  },
  { refSrc: `data:${refType};base64,${refBuf.toString("base64")}`, oursSrc: `data:image/png;base64,${ours.toString("base64")}` },
);
await browser.close();

for (const k of ["side", "overlay", "edges"]) {
  await writeFile(path.join(outDir, `${name}-${k}.png`), Buffer.from(result[k].split(",")[1], "base64"));
}
const fmt = (v) => (Math.round(v * 100) / 100).toFixed(2);
console.log(`compared ${target} with ${values.ref} at ${result.W}px (reference ${result.hRef}px tall, ours ${result.hOwn}px; compared the first ${result.H}px)`);
console.log(`rows ${fmt(result.rows)} · columns ${fmt(result.cols)}  (aim for ≥ 0.85 on both)`);
if (Math.abs(result.hRef - result.hOwn) > 0.15 * result.hRef) console.log("note: the heights differ by more than 15%, so a whole section is missing or extra");
console.log(`wrote design/screens/compare/${name}-side.png, -overlay.png, -edges.png`);
if (result.rows < 0.85 || result.cols < 0.85) process.exitCode = 1;
