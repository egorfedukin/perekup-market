'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { randomInspectionSkills, knownFaults, npcFaults } = require('./trade-rules');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-trade-'));
const port = 6100 + process.pid % 300;
const base = `http://127.0.0.1:${port}`;
let server;
async function start() {
  server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Server timeout')), 15000); server.stdout.on('data', data => { if (String(data).includes('Perekup Market:')) { clearTimeout(timer); resolve(); } }); server.once('error', reject); });
}
async function stop() { if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); }); }
async function request(token, url, body, status = 200) {
  const response = await fetch(base + url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json(); assert.equal(response.status, status, `${url}: ${JSON.stringify(data.error)}`); return data;
}
async function run() {
  const fault = { code: 'oil_low', name: 'Низкий уровень масла', category: 'engine', skill: 1, equipmentLevel: 0, severity: 1, repair: 6500, impact: 18000, repaired: false };
  assert.equal(npcFaults({ defects: [fault] }, { inspectionSkills: randomInspectionSkills(() => 0) }).length, 0);
  assert.equal(npcFaults({ defects: [fault] }, { inspectionSkills: randomInspectionSkills(() => .99) }).length, 1);
  assert.equal(knownFaults({ defects: [fault], discovered: [] }).length, 0);
  assert.equal(knownFaults({ defects: [fault], discovered: ['oil_low'] }).length, 1);
  assert.equal(knownFaults({ defects: [{ ...fault, repaired: true }], discovered: ['oil_low'] }).length, 0);
  await start();
  const seller = await request(null, '/api/join', { name: 'TradeSeller' + Date.now() });
  const buyer = await request(null, '/api/join', { name: 'TradeBuyer' + Date.now() });
  await request(seller.token, '/api/profile/appearance', { cosmeticId: 'workshop' });
  await stop();
  const db = new DatabaseSync(path.join(directory, 'game.db'));
  const saved = JSON.parse(db.prepare('SELECT payload FROM game_state WHERE id=1').get().payload);
  const sp = saved.players.find(([id]) => id === seller.player.id)[1];
  const bp = saved.players.find(([id]) => id === buyer.player.id)[1];
  sp.cash = bp.cash = 20000000; sp.xp = bp.xp = 1500;
  bp.skills = Object.fromEntries(Object.keys(bp.skills).map(key => [key, 5]));
  const template = saved.market.find(car => car.saleType !== 'auction');
  const car = { ...structuredClone(template), id: 'trade-test-car', ownerId: sp.id, sellerId: null, saleType: 'fixed', price: 150000, invested: 100000, cleanValue: 250000, defects: [fault], repairs: [], discovered: ['oil_low'], publicDiscovered: [], serviceDiagnosed: false };
  sp.garage.push(car);
  db.prepare('UPDATE game_state SET payload=? WHERE id=1').run(JSON.stringify(saved));
  const npcBefore = db.prepare('SELECT * FROM npc_skills ORDER BY id').all();
  db.close();
  await start();
  await request(seller.token, '/api/list', { carId: car.id, price: 150000 }, 409);
  await request(seller.token, '/api/repair', { carId: car.id, defect: 'oil_low', mode: 'workshop', plan: 'standard' });
  await request(seller.token, '/api/list', { carId: car.id, price: 150000 });
  // Add a newly hidden fault to a listed car, and force strong inspectors in the test only.
  await request(seller.token, '/api/profile/appearance', { cosmeticId: 'workshop' }); await stop();
  const db2 = new DatabaseSync(path.join(directory, 'game.db'));
  assert.deepEqual(db2.prepare('SELECT * FROM npc_skills ORDER BY id').all(), npcBefore, 'NPC skills persist');
  const payload = JSON.parse(db2.prepare('SELECT payload FROM game_state WHERE id=1').get().payload);
  const listing = payload.market.find(item => item.id === car.id);
  listing.defects = [{ ...fault, code: 'oil_leak', name: 'Течь масла', skill: 1 }]; listing.discovered = []; listing.publicDiscovered = []; listing.serviceDiagnosed = false;
  db2.prepare('UPDATE game_state SET payload=? WHERE id=1').run(JSON.stringify(payload));
  db2.prepare('UPDATE npc_skills SET payload=?').run(JSON.stringify(randomInspectionSkills(() => .99)));
  db2.close(); await start();
  await request(buyer.token, '/api/offer', { carId: car.id, amount: 120000, defectCode: 'oil_leak' }, 400);
  const early = await request(buyer.token, '/api/offer', { carId: car.id, amount: 100000 });
  const earlyId = early.player.outgoingOffers.find(item => item.carId === car.id).id;
  await request(seller.token, '/api/offer/respond', { offerId: earlyId, action: 'counter', amount: 120000 });
  await request(seller.token, '/api/list/update-price', { carId: car.id, price: 150000 });
  let npcState;
  for (let i = 0; i < 15; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    npcState = await request(seller.token, '/api/state');
    if (npcState.market.find(item => item.id === car.id)?.saleBlocked) break;
  }
  assert.ok(npcState.market.find(item => item.id === car.id).saleBlocked, 'NPC finds fault and refuses');
  assert.ok(!npcState.player.incomingOffers.some(item => item.carId === car.id && item.buyerType === 'bot'));
  await request(buyer.token, '/api/offer/accept-counter', { offerId: earlyId }, 409);
  const inspected = await request(buyer.token, '/api/market-check', { carId: car.id, category: 'engine', method: 'instrumental' });
  assert.ok(inspected.market.find(item => item.id === car.id).saleBlocked);
  const offerState = await request(buyer.token, '/api/offer', { carId: car.id, amount: 120000, defectCode: 'oil_leak' });
  const offer = offerState.player.outgoingOffers.find(item => item.carId === car.id);
  assert.match(offer.reason, /Течь масла/);
  await request(buyer.token, '/api/buy', { carId: car.id }, 409);
  await request(seller.token, '/api/offer/respond', { offerId: offer.id, action: 'accept' }, 409);
  await request(seller.token, '/api/unlist', { carId: car.id });
  await request(seller.token, '/api/list', { carId: car.id, price: 150000, saleType: 'auction' }, 409);
  await request(seller.token, '/api/repair', { carId: car.id, defect: 'oil_leak', mode: 'workshop', plan: 'standard' });
  await request(seller.token, '/api/list', { carId: car.id, price: 150000 });
  const bought = await request(buyer.token, '/api/buy', { carId: car.id });
  assert.ok(bought.player.garage.some(item => item.id === car.id));
  console.log('PASS: skill-based detection, persistent NPC skills, known-fault listing and sale blocks, validated discount reason, repair then sale');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(stop);
