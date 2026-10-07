import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const browser=await chromium.launch();
for(const width of [1440,768,390]) {
 const page=await browser.newPage({viewport:{width,height:900},reducedMotion:'reduce'});
 await page.goto('http://localhost:3100',{waitUntil:'networkidle'});
 for(const [name,count] of [['Terminal',4],['Validators',3],['Vault',5]]) {
  const trigger=page.getByRole('button',{name,exact:true}); await trigger.click();
  const menu=page.getByRole('menu'); await menu.waitFor();
  assert.equal(await menu.getByRole('menuitem').count(),count);
  const hrefs=await menu.getByRole('menuitem').evaluateAll(es=>es.map(e=>e.getAttribute('href')));
  assert.ok(hrefs.every(h=>h?.startsWith('/')));
  await page.screenshot({path:`design/screens/impl/landing-${name.toLowerCase()}-menu-${width}.png`});
  await page.keyboard.press('Escape'); await menu.waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(e=>e===document.activeElement),true);
 }
 await page.getByRole('button',{name:'Validators',exact:true}).click();
 await page.getByRole('menuitem',{name:/Independent operators/}).click();await page.waitForURL(/chips=hide-top18/);
 await page.goto('http://localhost:3100',{waitUntil:'networkidle'});
 await page.locator('.validator-showcase').scrollIntoViewIfNeeded();
 const logoCount=await page.locator('.validator-track-group').first().locator('img').count(); assert.ok(logoCount>0);
 for (const img of await page.locator('.validator-track-group').first().locator('img').all()) { await img.scrollIntoViewIfNeeded(); await img.evaluate(e=>e.decode()); assert.ok(await img.evaluate(e=>e.naturalWidth>0)); }
 assert.equal(await page.locator('.validator-track-group[aria-hidden="true"] a').evaluateAll(es=>es.every(e=>e.tabIndex===-1)),true);
 await page.close();
}
console.log('PASS: desktop/mobile dropdowns, Escape/focus return, correct filter navigation, loaded official logos and inaccessible duplicate strip.');await browser.close();
