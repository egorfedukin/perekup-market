"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { acquisitionPrice, buyerPrice } = require("./economy");
const { cosmetics, profileAppearance, ownsCosmetic, grantPurchase, paymentMatches } = require("./cosmetics");
const { npcFit } = require("./progression");
let server;
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-economy-"));
const port = 5800 + process.pid % 150;
const base = `http://127.0.0.1:${port}`;
async function start() {
  server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Start timeout")), 15000); server.once("error", reject); server.stdout.on("data", data => { if (String(data).includes("Perekup Market")) { clearTimeout(timer); resolve(); } }); });
}
async function stop() { if (server && server.exitCode === null) await new Promise(resolve => { server.once("exit", resolve); server.kill(); }); }
let token;
async function request(url, body, status = 200) {
  const res = await fetch(base + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data.error)); return data;
}
async function run() {
  const player = { cash: 500000, xp: 0, purchasedCash: 0 };
  assert.ok(acquisitionPrice({ value: 2000000000, restorationValue: 2000000000, repairCost: 0, kind: 'optimistic', unit: 1 }) <= 2000000000);
  assert.ok(buyerPrice({ value: 2000000000, fit: 1.5, type: 'collector', unknownCount: 0, classic: true }) <= 2000000000);
  assert.equal(ownsCosmetic(player, cosmetics.find(item => item.id === "road"), 1), false);
  assert.equal(ownsCosmetic(player, cosmetics.find(item => item.id === "road"), 3), true);
  assert.equal(ownsCosmetic({ supporterTier: "bronze" }, cosmetics.find(item => item.id === "night"), 1), true);
  grantPurchase(player, { cash: 0, cosmetics: ["night", "redline"] });
  assert.equal(player.cash, 500000);
  assert.equal(profileAppearance(player, 1).catalog.find(item => item.id === "night").unlocked, true);
  const order = { orderId: "test", rubles: 149 };
  const payment = { status: "succeeded", paid: true, metadata: { orderId: "test" }, amount: { value: "149.00", currency: "RUB" } };
  assert.equal(paymentMatches(order, payment), true);
  assert.equal(paymentMatches(order, { ...payment, amount: { value: "1.00", currency: "RUB" } }), false);
  assert.equal(paymentMatches(order, { ...payment, metadata: { orderId: "wrong" } }), false);
  for (const age of [5, 15, 30, 45]) {
    const car = { year: new Date().getFullYear() - age, upgrades: [], defects: [] };
    const offer = buyerPrice({ value: 200000, type: "specialist", fit: npcFit(car, { type: "specialist" }, []).multiplier, unknownCount: 2, lied: false });
    const cost = acquisitionPrice({ value: 200000, restorationValue: 300000, repairCost: 50000, kind: "urgent" });
    assert.ok(offer > cost * 1.1);
  }
  await start();
  let state = await request("/api/join", { name: `Economy${Date.now().toString().slice(-7)}` }); token = state.token;
  await request("/api/profile/appearance", { cosmeticId: "night" }, 403);
  await request("/api/profile/appearance", { cosmeticId: "road" }, 403);
  await request("/api/profile/appearance", { cosmeticId: "workshop" });
  await request("/api/activity", { activity: "scout", score: 100 }, 410);
  assert.ok(state.store.packages.every(pack => pack.cash === 0 && pack.cosmetics.length > 0));
  assert.ok(state.player.contracts.every(contract => !contract.model), "Starter contracts accept affordable cars");
  await new Promise(resolve => setTimeout(resolve, 450)); await stop();
  const db = new DatabaseSync(path.join(directory, "game.db"));
  const saved = JSON.parse(db.prepare("SELECT payload FROM game_state WHERE id = 1").get().payload);
  const fixture = saved.players.find(([, p]) => p.id === state.player.id)[1];
  fixture.cash = 20000000; fixture.garageCapacity = 12; fixture.xp = 5000; fixture.cosmeticsOwned = ["night", "redline"];
  const legacyCar = structuredClone(saved.market.find(car => car.saleType !== 'auction'));
  Object.assign(legacyCar, { id: 'legacy_avatr_test', model: 'Avatr 07', make: 'Avatr', year: 1995, cleanValue: 100000, invested: 123456, purchasePrice: 110000, catalogRevision: 6, ownerId: fixture.id, sellerId: null });
  fixture.garage.push(legacyCar);
  db.prepare("UPDATE game_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(saved), Date.now()); db.close();
  await start(); state = await request("/api/state");
  const migratedCar = state.player.garage.find(car => car.id === 'legacy_avatr_test');
  assert.equal(migratedCar.year, 2024);
  assert.equal(migratedCar.invested, 123456);
  assert.ok(migratedCar.saleEstimate.expectedNpcPrice > 1000000, 'Modern car no longer valued as a 1995 salvage vehicle');
  await request("/api/profile/appearance", { cosmeticId: "night" });
  state = await request("/api/profile/appearance", { cosmeticId: "redline" });
  const eligible = state.market.filter(car => car.saleType !== "auction" && !car.sellerId && car.price < 500000 && ["Срочная продажа", "Под восстановление"].includes(car.marketTag)).sort((a, b) => a.price - b.price).slice(0, 6);
  assert.ok(eligible.length >= 4, "Must seed affordable opportunities");
  const results = [];
  for (let index = 0; index < eligible.length; index++) {
    const candidate = eligible[index];
    state = await request("/api/buy", { carId: candidate.id });
    if (index % 2) {
      state = await request("/api/service-diagnostic", { carId: candidate.id });
      let car = state.player.garage.find(car => car.id === candidate.id);
      for (const defect of car.defects.filter(defect => !defect.repaired)) {
        const plan = defect.servicePlans.find(plan => plan.key === "standard");
        if (plan.projectedProfit > 0) state = await request("/api/repair", { carId: candidate.id, defect: defect.code, mode: "workshop", plan: "standard" });
      }
    }
    const car = state.player.garage.find(car => car.id === candidate.id);
    const investment = car.invested;
    state = await request("/api/list", { carId: car.id, price: Math.round(car.saleEstimate.expectedNpcPrice * 1.2), description: "Состояние соответствует осмотру. Разумный торг." });
    let offers = [];
    for (let retry = 0; retry < 14 && !offers.length; retry++) {
      await new Promise(resolve => setTimeout(resolve, 500)); state = await request("/api/state");
      offers = state.player.incomingOffers.filter(offer => offer.carId === car.id).sort((a, b) => b.amount - a.amount);
    }
    assert.ok(offers.length, "Buyer must make a concrete offer");
    state = await request("/api/offer/respond", { offerId: offers[0].id, action: "accept" });
    results.push({ model: car.model, mode: index % 2 ? "inspection/preparation" : "quick turnover", cost: investment, sold: offers[0].amount, profit: offers[0].amount - investment });
  }
  assert.ok(results.filter(result => result.profit > 0).length >= 4, JSON.stringify(results));
  const expectedCash = state.player.cash;
  const npcPrices = new Map(state.market.filter(car => !car.sellerId && car.saleType !== 'auction').map(car => [car.id, car.price]));
  await stop(); await start(); state = await request("/api/state");
  for (const car of state.market.filter(car => npcPrices.has(car.id))) assert.equal(car.price, npcPrices.get(car.id), 'Restart must not reroll NPC asking prices');
  assert.equal(state.player.cash, expectedCash);
  assert.deepEqual(state.player.appearance.selected, { background: "night", frame: "redline" });
  console.log(JSON.stringify(results, null, 2));
  console.log("PASS: real NPC trades are profitable, cosmetics gated and persisted, purchase validation, no cash from style purchases, board retired");
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
