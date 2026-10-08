import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
await page.goto('http://localhost:3100', { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.getByRole('button', { name: 'Pause animations' }).click();
await page.getByRole('button', { name: 'Resume animations' }).waitFor();
await page.screenshot({ path: 'design/screens/impl/editorial-paused-hero.png' });
await page.getByRole('button', { name: 'Resume animations' }).click();
for (const [name, title] of [
  ['For validators', 'Good operators deserve room to grow.'],
  ['For lenders', 'See what’s behind your return.'],
  ['For stakers', 'Know who’s behind your stake.'],
]) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
}
console.log('PASS: Pause/resume and all audience controls.');
await browser.close();
