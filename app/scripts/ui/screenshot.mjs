#!/usr/bin/env node
// Epoch — the loop's eyes. Full-page screenshots of one route at four breakpoints, plus guards.
//
//   node scripts/ui/screenshot.mjs <route> [name] [--base URL] [--bp sm,md,lg,xl] [--settle ms]
//                                  [--motion] [--axe]
//   node scripts/ui/screenshot.mjs /validators validators --axe
//
// Writes design/screens/impl/<name>.<bp>.png at 1× (tall pages continue in <name>.<bp>.2.png, .3.png …, each
// at most 4,000 px high so the images stay readable for design-cop). Verify against a PRODUCTION build
// (pnpm --filter app build && pnpm --filter app start), not `next dev`.
// Guards (exit code 1 if any fire): console errors, uncaught page errors, charts still at the
// 300×150 canvas default (a blank lightweight-charts pane), horizontal overflow, and with --axe
// any serious or critical accessibility violation (checked at lg).
// Set PLAYWRIGHT_CHROMIUM_PATH to use an installed Chrome/Chromium instead of Playwright's own download.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const VALUE_OPTS = new Set(["--base", "--bp", "--settle"]);
const values = {};
const flags = new Set();
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (VALUE_OPTS.has(a)) values[a.slice(2)] = args[++i];
  else if (a.startsWith("--")) flags.add(a);
  else positional.push(a);
}
const opt = (key, fallback) => values[key] ?? fallback;

const route = positional.find((a) => a.startsWith("/")) ?? "/";
const name =
  positional.find((a) => !a.startsWith("/")) ??
  (route === "/" ? "landing" : route.replace(/^\//, "").replaceAll("/", "-").replaceAll("#", "-"));
const base = opt("base", process.env.EPOCH_APP_URL ?? "http://localhost:3000");
const settle = Number(opt("settle", "1200"));
const BREAKPOINTS = { sm: [390, 844], md: [768, 1024], lg: [1280, 800], xl: [1440, 900] };
const wanted = opt("bp", "sm,md,lg,xl").split(",").filter((b) => b in BREAKPOINTS);

const outDir = path.resolve("design/screens/impl");
await mkdir(outDir, { recursive: true });

// PLAYWRIGHT_CHROMIUM_PATH lets you use an existing Chrome/Chromium instead of Playwright's download.
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const problems = [];

for (const bp of wanted) {
  const [width, height] = BREAKPOINTS[bp];
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme: "dark",
    reducedMotion: flags.has("--motion") ? "no-preference" : "reduce",
  });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`[${bp}] console error: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${bp}] page error: ${e.message}`));

  const res = await page.goto(base + route, { waitUntil: "networkidle" });
  if (!res || !res.ok()) problems.push(`[${bp}] HTTP ${res?.status() ?? "no response"} for ${route}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(settle);

  const blankCanvases = await page.$$eval("canvas", (cs) => cs.filter((c) => c.width === 300 && c.height === 150).length);
  if (blankCanvases) problems.push(`[${bp}] ${blankCanvases} canvas(es) at the 300×150 default: a chart did not size`);

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) problems.push(`[${bp}] horizontal overflow of ${overflow}px`);

  if (flags.has("--axe") && bp === "lg") {
    const { default: AxeBuilder } = await import("@axe-core/playwright");
    const result = await new AxeBuilder({ page }).analyze();
    for (const v of result.violations.filter((v) => ["serious", "critical"].includes(v.impact ?? ""))) {
      problems.push(`[axe ${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} nodes)`);
    }
  }

  const MAX_H = 4000;
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let part = 0, y = 0; y < total; part++, y += MAX_H) {
    const file = path.join(outDir, part === 0 ? `${name}.${bp}.png` : `${name}.${bp}.${part + 1}.png`);
    await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y, width, height: Math.min(MAX_H, total - y) } });
    console.log(`✓ ${path.relative(process.cwd(), file)}`);
  }
  await context.close();
}

await browser.close();

if (problems.length) {
  console.log("\nProblems (fix before design-cop):");
  for (const p of problems) console.log(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log("\nNo console errors, blank charts, overflow" + (flags.has("--axe") ? " or serious axe issues." : "."));
}
