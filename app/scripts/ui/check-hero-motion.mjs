import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const intervals = await page.evaluate(() => new Promise(resolve => {
  const samples = []; let last;
  function step(t) { if (last) samples.push(t-last); last=t; if(samples.length < 120) requestAnimationFrame(step); else resolve(samples); }
  requestAnimationFrame(step);
}));
intervals.sort((a,b)=>a-b);
console.log(JSON.stringify({ medianFrameMs: intervals[60], p95FrameMs: intervals[114], note: 'Local headless browser, not a device-wide performance guarantee.' }));
await page.screenshot({path: 'design/screens/impl/editorial-hero.png'});
const canvas = page.locator('.editorial-sculpture canvas');
const before = await canvas.screenshot(); await page.waitForTimeout(500); const after = await canvas.screenshot();
assert.equal(before.equals(after), false, 'Hero changes visibly while idle');
await page.getByRole('button', {name: 'Pause animations', exact: true}).click();
await page.waitForTimeout(200);
const frozen = await canvas.screenshot(); await page.waitForTimeout(400); const still = await canvas.screenshot();
assert.equal(frozen.equals(still), true, 'Hero freezes when paused');
console.log('PASS: visible idle motion and stable paused frame.');
await page.getByRole('button', {name: 'Resume animations', exact: true}).click();
await page.waitForTimeout(1600);
await page.getByRole('link', {name: 'Discover Epoch', exact: true}).click();
await page.waitForTimeout(1400);
assert.ok(page.url().endsWith('#terminal-reveal'));
const reveal = await page.locator('.terminal-reveal-stage').evaluate(e => ({transform: getComputedStyle(e).transform, top: e.getBoundingClientRect().top}));
assert.ok(reveal.top < 800, 'Terminal enters viewport after discover link');
await page.screenshot({path:'design/screens/impl/editorial-terminal-reveal.png'});
console.log('PASS: Discover Epoch anchor reaches the cinematic Terminal reveal.', reveal);

await browser.close();
