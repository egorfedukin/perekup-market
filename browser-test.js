"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const port = 5400 + process.pid % 300;
const base = `http://127.0.0.1:${port}`;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-browser-"));
const output = process.env.QA_OUTPUT || path.join(__dirname, "work", "qa");
fs.mkdirSync(output, { recursive: true });
let server, browser;
async function startServer() {
  server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Server timeout")), 15000); server.once("error", reject); server.stdout.on("data", data => { if (String(data).includes("Perekup Market")) { clearTimeout(timer); resolve(); } }); });
}
async function run() {
  await startServer();
  const join = await (await fetch(`${base}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Browser${Date.now().toString().slice(-7)}` }) })).json();
  const car = join.market.filter(item => item.saleType !== "auction" && item.price < 400000).sort((a, b) => a.price - b.price)[0];
  assert.ok(car);
  const purchase = await fetch(`${base}/api/buy`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${join.token}` }, body: JSON.stringify({ carId: car.id }) });
  assert.equal(purchase.status, 200, await purchase.text());
  const savedProfile = await fetch(`${base}/api/profile/appearance`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${join.token}` }, body: JSON.stringify({ cosmeticId: 'workshop' }) });
  assert.equal(savedProfile.status, 200);
  // Unlock auction screens in the isolated test database only.
  await new Promise(resolve => setTimeout(resolve, 450));
  await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
  const { DatabaseSync } = require('node:sqlite');
  const fixtureDb = new DatabaseSync(path.join(directory, 'game.db'));
  const fixtureState = JSON.parse(fixtureDb.prepare('SELECT payload FROM game_state WHERE id = 1').get().payload);
  fixtureState.players.find(([id]) => id === join.player.id)[1].xp = 600;
  fixtureDb.prepare('UPDATE game_state SET payload = ? WHERE id = 1').run(JSON.stringify(fixtureState));
  fixtureDb.close();
  await startServer();
  browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(token => localStorage.setItem("perekup-token", token), join.token);
  await page.goto(`${base}/#garage`);
  await page.locator("#game").waitFor({ state: "visible" });
  await page.locator(`[data-open-garage="${car.id}"]`).click();
  await page.locator(".deal-workflow").waitFor();
  for (const layout of ["desktop", "mobile"]) {
  await page.setViewportSize(layout === "desktop" ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
  for (const category of ["engine", "chassis", "body", "electrics"]) {
    await page.locator(`[data-check="${category}"]`).click();
    await page.locator(`[data-method="${layout === "desktop" ? "visual" : "instrumental"}"]`).click();
    await page.locator(".inspection-game").waitFor();
    await page.screenshot({ path: path.join(output, `${layout}-${category}.png`) });
    for (let round = 0; round < 3; round++) {
      if (["engine", "chassis"].includes(category)) {
        await page.waitForFunction(() => { const needle = document.querySelector(".inspection-needle"); const target = document.querySelector(".inspection-target"); return needle && Math.abs(parseFloat(needle.style.left) - parseFloat(target.style.left) - parseFloat(target.style.width) / 2) < 4; });
        await page.locator("[data-sample]").click();
      } else {
        const readings = await page.locator("[data-reading] strong").allTextContents();
        const values = readings.map(parseFloat);
        const index = category === "body" ? values.findIndex(value => value > 160) : values.findIndex((value, i) => values.filter(other => other === value).length === 1);
        await page.locator(`[data-reading="${index}"]`).click();
      }
    }
    await page.locator("#skill-challenge").waitFor({ state: "hidden" });
    await page.waitForTimeout(300);
  }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('[data-deal-tab="repair"]').click();
  const comparison = page.locator(".repair-comparison summary").first();
  if (await comparison.count()) await comparison.click();
  await page.screenshot({ path: path.join(output, "desktop-repair.png") });
  await page.locator('[data-deal-tab="tuning"]').click();
  await page.screenshot({ path: path.join(output, "desktop-tuning.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-deal-tab="inspect"]').click();
  await page.screenshot({ path: path.join(output, "mobile-inspection.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Page overflows mobile viewport");
  await page.keyboard.press("Escape");
  await page.locator("[data-mobile-menu]").click();
  await page.locator('#utility-nav [data-view="profile"]').click();
  await page.locator("#profile-journey").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(output, "mobile-profile.png") });
  await page.locator('[data-profile-mode="style"]').click();
  await page.locator("#appearance-options").waitFor({ state: "visible" });
  assert.ok(await page.locator('[data-cosmetic="night"]').isDisabled(), "Paid background is locked for a free account");
  await page.locator('[data-cosmetic="plain"]').click();
  await page.screenshot({ path: path.join(output, "mobile-customize.png") });
  await page.locator('.tabs [data-view="garage"]').click();
  await page.locator('[data-garage-mode="development"]').first().click();
  await page.locator("#skills-grid").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(output, "mobile-skills.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Skills overflow mobile viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, "desktop-skills.png") });
  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('[data-mobile-menu]').click();
    await page.locator('#utility-nav [data-view="store"]').click();
    await page.locator('#store-view.active-view').waitFor({ state: 'visible' });
    await page.locator('[data-mobile-menu]').click();
    await page.locator('#utility-nav [data-view="assets"]').click();
    assert.equal(await page.locator('#asset-market-grid').isVisible(), false);
    await page.locator('.asset-mode-controls [data-asset-mode="all"]').click();
    assert.equal(await page.locator('#asset-market-grid').isVisible(), true);
    const propertyState = await (await fetch(`${base}/api/state`, { headers: { Authorization: `Bearer ${join.token}` } })).json();
    await page.locator('#asset-filters [name="min"]').fill('4575757');
    await page.locator('#asset-filters [name="max"]').fill('25000000');
    await page.locator('#asset-filters [name="category"]').selectOption('commercial');
    await page.locator('#asset-filters [name="sort"]').selectOption('priceAsc');
    assert.equal(await page.locator('#asset-filters').evaluate(form => form.checkValidity()), true, 'Any whole-ruble price is valid');
    await page.locator('#asset-filters [type="submit"]').click();
    const expectedProperties = propertyState.assetMarket.filter(item => item.type === 'property' && item.category === 'commercial' && item.price >= 4575757 && item.price <= 25000000).sort((a, b) => a.price - b.price).slice(0, 12).map(item => item.id);
    assert.deepEqual(await page.locator('#asset-market-grid [data-open-property]').evaluateAll(items => items.map(item => item.dataset.openProperty)), expectedProperties, 'Property filters and sorting affect results');
    await page.screenshot({ path: path.join(output, `${width}-property-filter.png`) });
    await page.locator('#asset-filters [type="reset"]').click();
    await page.locator('.tabs [data-view="market"]').click();
    assert.equal(await page.locator('#market-filters').isVisible(), false);
    await page.locator('#mobile-filter-toggle').click();
    assert.equal(await page.locator('#market-filters').isVisible(), true);
    await page.locator('#mobile-filter-toggle').click();
    const firstCard = await page.locator('#market-grid .car-card').first().boundingBox();
    assert.ok(firstCard && firstCard.y < 600, `Listings visible on first screen at ${width}px`);
    for (const view of ["market", "garage", "deals", "profile", "store", "assets", "parts", "auctions", "chat", "rating"]) {
      await page.goto(`${base}/#${view}`);
      await page.locator(`#${view}-view.active-view`).waitFor({ state: "visible" });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${view} overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `${width}-${view}.png`) });
      if (view === 'garage') {
        const more = page.locator('.garage-more-actions').first();
        assert.equal(await more.locator('div').isVisible(), false, 'Secondary garage actions start hidden');
        await more.locator('summary').click();
        assert.equal(await more.locator('div').isVisible(), true);
        await more.locator('summary').click();
      }
      if (view === 'auctions') {
        await page.locator('[data-auction-mode="containers"]').click();
        await page.locator('.container-card').first().waitFor({ state: 'visible' });
        await page.screenshot({ path: path.join(output, `${width}-containers.png`) });
      }
      if (view === 'market') {
        await page.locator('#market-grid [data-open-market]').first().click();
        await page.screenshot({ path: path.join(output, `${width}-market-inspection.png`) });
        await page.keyboard.press('Escape');
      }
      if (view === 'profile') {
        await page.locator('.profile-edit-details summary').click();
        await page.locator('#profile-edit-form').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `${width}-profile-edit.png`) });
        await page.locator('[data-mobile-menu]').click();
        const menuBounds = await page.locator('#utility-nav').boundingBox();
        assert.ok(menuBounds.height < 500, 'Menu remains compact');
        await page.screenshot({ path: path.join(output, `${width}-menu.png`) });
        await page.locator('#utility-nav [data-close-section-menu]').click();
      }
    }
  }
  await page.goto(`${base}/#profile`);
  await page.locator('[data-profile-mode="style"]').click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, "desktop-customize.png") });
  const missingArt = await page.locator('.cosmetic-option img').evaluateAll(images => images.filter(image => !image.complete || image.naturalWidth === 0).length);
  assert.equal(missingArt, 0, "Profile artwork loads locally");
  assert.equal(await page.locator(".activity-board").count(), 0);
  const authHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${join.token}` };
  const diagnostic = await fetch(`${base}/api/service-diagnostic`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ carId: car.id }) });
  assert.equal(diagnostic.status, 200);
  const diagnosed = await diagnostic.json();
  for (const defect of diagnosed.player.garage.find(item => item.id === car.id).defects.filter(item => !item.repaired)) {
    const repair = await fetch(`${base}/api/repair`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ carId: car.id, defect: defect.code, mode: 'workshop', plan: 'standard' }) });
    assert.equal(repair.status, 200);
  }
  const sale = await fetch(`${base}/api/list`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${join.token}` }, body: JSON.stringify({ carId: car.id, price: 150000, description: 'Состояние по осмотру, разумный торг.' }) });
  assert.equal(sale.status, 200);
  await page.goto(`${base}/#deals`);
  await page.locator('#incoming-offers .offer-card').first().waitFor({ state: 'visible', timeout: 15000 });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.screenshot({ path: path.join(output, `${width}-npc-offers.png`) });
    const counterInput = page.locator('#incoming-offers .counter-row input').first();
    assert.ok((await counterInput.boundingBox()).width >= 120, 'Counteroffer price remains readable');
    await counterInput.fill('57001');
    assert.equal(await counterInput.inputValue(), '57001');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(errors, []);
  const latest = await (await fetch(`${base}/api/state`, { headers: authHeaders })).json();
  const inspectedLot = latest.market.find(item => item.saleType === 'fixed' && !item.sellerId && item.price < 500000);
  assert.ok(inspectedLot);
  for (const category of ['engine', 'chassis', 'body', 'electrics', 'tires', 'documents']) {
    const checked = await fetch(`${base}/api/market-check`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ carId: inspectedLot.id, category, method: 'instrumental' }) });
    assert.equal(checked.status, 200);
  }
  await page.goto(`${base}/#market`);
  await page.locator('#mobile-filter-toggle').click();
  await page.locator('#market-search').fill(inspectedLot.model);
  await page.locator('#market-filters [type="submit"]').click();
  await page.locator(`[data-open-market="${inspectedLot.id}"]`).click();
  await page.locator('#offer-form select[name="defectCode"]').waitFor();
  assert.equal(await page.locator(`[data-buy="${inspectedLot.id}"]`).isDisabled(), true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await page.locator('#offer-form').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `${width}-defect-discount.png`) });
  }
  if (process.env.RUN_SMOKE === "1") await new Promise((resolve, reject) => {
    const smoke = spawn(process.execPath, ["smoke-test.js"], { cwd: __dirname, env: { ...process.env, TEST_URL: base }, stdio: "inherit" });
    smoke.once("error", reject); smoke.once("exit", code => code === 0 ? resolve() : reject(Error(`Smoke test exit ${code}`)));
  });
  console.log("PASS: four inspection games, workflow tabs, profile, mobile overflow, no browser exceptions");
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) await new Promise(resolve => { server.once("exit", resolve); server.kill(); });
});
