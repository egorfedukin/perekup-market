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
async function run() {
  server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Server timeout")), 15000); server.once("error", reject); server.stdout.on("data", data => { if (String(data).includes("Perekup Market")) { clearTimeout(timer); resolve(); } }); });
  const join = await (await fetch(`${base}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Browser${Date.now().toString().slice(-7)}` }) })).json();
  const car = join.market.filter(item => item.saleType !== "auction" && item.price < 400000).sort((a, b) => a.price - b.price)[0];
  assert.ok(car);
  await fetch(`${base}/api/buy`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${join.token}` }, body: JSON.stringify({ carId: car.id }) });
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
  await page.locator('.tabs [data-view="garage"]').click();
  await page.locator('[data-garage-mode="development"]').first().click();
  await page.locator("#skills-grid").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(output, "mobile-skills.png") });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "Skills overflow mobile viewport");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: path.join(output, "desktop-skills.png") });
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    for (const view of ["market", "garage", "deals", "profile", "assets", "parts", "auctions", "chat", "rating"]) {
      await page.goto(`${base}/#${view}`);
      await page.locator(`#${view}-view.active-view`).waitFor({ state: "visible" });
      await page.waitForTimeout(150);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `${view} overflows at ${width}px`);
      await page.screenshot({ path: path.join(output, `${width}-${view}.png`) });
    }
  }
  assert.deepEqual(errors, []);
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
