"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { repairQuote, repairReliability, inspectionQuote, careerProgress } = require("./gameplay");

async function run() {
  assert.throws(() => repairQuote({ labor: 1000, plan: "unknown" }));
  assert.equal(careerProgress({ cash: 100000000 }).stage, "Новичок");
  assert.equal(careerProgress({ deals: 5, profit: 150000, reputation: { score: 50 } }).stage, "Гаражный мастер");
  assert.throws(() => inspectionQuote("unknown", 0, 0));
  assert.equal(repairReliability("restoration", 68, 50), 34);
  assert.equal(inspectionQuote("visual", 0, 0).depth, 1);
  assert.equal(inspectionQuote("instrumental", 0, 0).depth, 4);
  assert.equal(inspectionQuote("instrumental", 5, 3).confidence, 100);
  assert.ok(repairQuote({ labor: 10000, plan: "restoration" }).total > repairQuote({ labor: 10000 }).total);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-gameplay-"));
  const port = 5100 + process.pid % 500;
  let server;
  const start = async () => {
    server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ["ignore", "pipe", "pipe"] });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error("Server timeout")), 15000);
      server.once("error", reject);
      server.stdout.on("data", (data) => { if (String(data).includes("Perekup Market")) { clearTimeout(timeout); resolve(); } });
    });
  };
  const stop = () => new Promise((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once("exit", resolve); server.kill(); });
  try {
    await start();
    let token;
    const request = async (url, body, expected = 200) => {
      const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result.error));
      return result;
    };
    let state = await request("/api/join", { name: `Check${Date.now().toString().slice(-8)}` });
    token = state.token;
    const candidate = state.market.filter((car) => car.saleType !== "auction" && car.price < 150000).sort((a,b) => a.price-b.price)[0];
    assert.ok(candidate, "Affordable vehicle exists");
    state = await request("/api/buy", { carId: candidate.id });
    assert.ok(state.player.achievements.unlocked.includes("first_purchase"));
    const xp = state.player.xp;
    assert.equal((await request("/api/state")).player.xp, xp, "Reading state must not grant rewards");
    state = await request("/api/check", { carId: candidate.id, category: "engine", method: "visual", interactionScore: 100 });
    assert.equal(state.checkResult.confidence, 17, "Client score cannot override diagnostic depth");
    await request("/api/check", { carId: candidate.id, category: "engine", method: "visual" }, 400);
    const before = state.player.cash;
    state = await request("/api/check", { carId: candidate.id, category: "engine", method: "instrumental" });
    assert.equal(before-state.player.cash, 9000);
    state = await request("/api/service-diagnostic", { carId: candidate.id });
    const defect = state.player.garage[0].defects.filter((d) => !d.repaired).sort((a,b) => a.serviceRepairCost-b.serviceRepairCost)[0];
    assert.ok(defect.servicePlans.length === 3);
    const quote = defect.servicePlans.find((p) => p.key === "restoration");
    const cash = state.player.cash;
    await request("/api/repair", { carId: candidate.id, defect: defect.code, plan: "invalid" }, 400);
    if (cash >= quote.total) {
      state = await request("/api/repair", { carId: candidate.id, defect: defect.code, mode: "workshop", plan: "restoration" });
      assert.equal(cash-state.player.cash, quote.total, "Displayed repair quote must match charge");
      assert.equal(state.player.garage[0].defects.find((d) => d.code === defect.code).repairQuality, "Восстановление");
    } else throw Error("Test vehicle repair exceeds budget");
    const expectedPlayer = state.player;
    await stop();
    await start();
    state = await request("/api/state");
    assert.equal(state.player.cash, expectedPlayer.cash);
    assert.equal(state.player.xp, expectedPlayer.xp);
    assert.deepEqual(state.player.achievements, expectedPlayer.achievements);
    assert.deepEqual(state.player.garage[0].defects, expectedPlayer.garage[0].defects);
    console.log("PASS: career, repair quotes, diagnostics, rewards and persistence after restart");
  } finally {
    await stop();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
