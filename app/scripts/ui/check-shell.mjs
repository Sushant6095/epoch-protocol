import { chromium } from 'playwright';
import assert from 'node:assert/strict';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('http://localhost:3100/terminal');
  await page.getByRole('button', { name: /Search validators/ }).click();
  await page.getByRole('combobox').fill('NTT');
  await page.getByRole('option').filter({ hasText: 'NTT' }).first().click();
  await page.waitForURL('**/validators/*');
  await page.keyboard.press('/');
  await page.getByRole('combobox').fill('no-such-validator-xyz');
  await page.getByText('No match. Paste a vote account, wallet or signature.').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /Epoch 1044/ }).click();
  await page.getByText(/not a live connection/).waitFor();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.waitForURL('**/vault');
  assert.equal(await page.getByRole('dialog').count(), 0, 'mobile menu closes after navigation');
  assert.deepEqual(errors, []);
  console.log('PASS: validator search, unknown search, keyboard palette, snapshot detail, mobile navigation.');
} finally {
  await browser.close();
}
