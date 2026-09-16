"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bank = require("./bank");

// Чистые расчёты
const product = bank.loanProducts.find((item) => item.key === "working");
const quote = bank.loanQuote(product, 1000000, 650);
assert.ok(quote.payment * quote.periods > 1000000, "annuity overpays principal");
assert.ok(bank.effectiveRate(product, 850) < bank.effectiveRate(product, 300), "better rating → lower rate");
assert.equal(bank.carSaleTax({ amount: 500000, invested: 600000, deals: 10, level: 10 }).tax, 0, "loss is not taxed");
assert.equal(bank.carSaleTax({ amount: 700000, invested: 600000, deals: 0, level: 1 }).tax, 0, "tax holiday for newcomers");
assert.equal(bank.carSaleTax({ amount: 700000, invested: 600000, deals: 10, level: 10 }).tax, 13000, "13% of profit");
assert.equal(bank.carSaleTax({ amount: 7000000, invested: 1000000, deals: 10, level: 10 }).tax, 5000000 * .13 + 1000000 * .15, "progressive rate above threshold");
assert.ok(bank.carSaleTax({ amount: 700000, invested: 600000, deals: 10, level: 10, showroomBonus: .15 }).tax < 13000, "showroom deduction");
const loan = bank.createLoan(product, 120000, 650, 0);
const missed = bank.applyScheduledPayment(loan, 0, 1);
assert.equal(missed.missed, true); assert.ok(loan.overdue > 0);
const paid = bank.applyScheduledPayment(loan, 10000000, 2);
assert.equal(paid.missed, false); assert.equal(loan.overdue, 0); assert.equal(loan.missed, 0);
const early = bank.applyEarlyRepayment(loan, 10000000, 3);
assert.equal(early.closed, true); assert.equal(loan.balance, 0);

// Взыскание: три пропуска подряд → флаг collection
const bad = bank.createLoan(product, 100000, 500, 0);
let collect = null;
for (let i = 1; i <= 3; i += 1) collect = bank.applyScheduledPayment(bad, 0, i);
assert.equal(collect.collection, true, "third consecutive miss triggers collection");
assert.ok(bad.overdue > 3 * bank.scheduledDue(bad).due * 0.9);
// Андеррайтинг: игрок с 650к не получит миллиард
const poor = { loans: [], credit: {}, reputation: { score: 50 }, deals: 0 };
const decision = bank.underwrite(bank.loanProducts[0], { player: poor, level: 1, rating: 550, limit: 50000000, netWorth: 650000, incomePerPeriod: 0 });
assert.ok(decision.approved < 1000000, `approved ${decision.approved} must be bounded by capital/income`);
assert.ok(decision.approved >= 100000, "but still gets something meaningful");

// Интеграция с сервером
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-bank-"));
const port = 6200 + process.pid % 150;
const base = `http://127.0.0.1:${port}`;
let server, token;
async function request(url, body, status = 200) {
  const res = await fetch(base + url, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json(); assert.equal(res.status, status, JSON.stringify(data.error)); return data;
}
(async () => {
  server = spawn(process.execPath, ["server.js"], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory, PEREKUP_LOAN_PERIOD_MS: "1500" }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error("Start timeout")), 15000); server.once("error", reject); server.stdout.on("data", (data) => { if (String(data).includes("Perekup Market")) { clearTimeout(timer); resolve(); } }); });
  try {
    let state = await request("/api/join", { name: `Bank${Date.now().toString().slice(-8)}` });
    token = state.token;
    assert.ok(state.player.bank.limit >= 100000);
    assert.ok(state.player.bank.products.find((item) => item.key === "express").available);
    assert.equal(state.player.bank.products.find((item) => item.key === "invest").available, false, "invest locked for level 1");
    const express = state.player.bank.products.find((item) => item.key === "express");
    assert.ok(express.maxAmount <= state.player.bank.netWorth * 2, "approval bounded by capital");
    assert.ok(express.maxAmount < 1000000000);
    const denied = await request("/api/bank/loan", { productKey: "express", amount: 1000000000 }, 400);
    assert.match(denied.error, /одобрил максимум/);
    await request("/api/bank/loan", { productKey: "invest", amount: 100000 }, 400);
    state = await request("/api/bank/loan", { productKey: "express", amount: 123000 });
    assert.equal(state.player.bank.loans[0].principal, 123000, "custom amount with 1000 step");
    state = await request("/api/bank/repay", { loanId: state.player.bank.loans[0].id, full: true });
    const cashBeforeSecond = state.player.cash;
    state = await request("/api/bank/loan", { productKey: "express", amount: 100000 });
    const loanRow = state.player.bank.loans.find((loan) => loan.status === "active");
    assert.equal(state.player.cash, cashBeforeSecond + 100000 - loanRow.fee, "principal minus fee credited");
    assert.equal(state.player.bank.debt, 100000);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    state = await request("/api/state");
    const afterPeriod = state.player.bank.loans.find((loan) => loan.status === "active");
    assert.ok(afterPeriod.paidPeriods >= 1, "scheduled payment processed");
    assert.ok(afterPeriod.balance < 100000, "balance decreased");
    assert.ok(state.player.ledger.some((entry) => entry.type === "loan-payment"), "ledger entry for payment");
    state = await request("/api/bank/repay", { loanId: afterPeriod.id, full: true });
    assert.equal(state.player.bank.loans.find((loan) => loan.id === afterPeriod.id).status, "closed");
    assert.equal(state.player.bank.debt, 0);
    assert.equal(state.player.bank.history.repaid, 2);
    await request("/api/bank/repay", { loanId: afterPeriod.id, full: true }, 404);
    // Первая продажа новичка — налоговые каникулы отражены в прогнозе
    assert.equal(state.player.bank.tax.holidayDealsLeft, 3);
    console.log("BANK_TEST_OK");
  } finally {
    if (server.exitCode === null) await new Promise((resolve) => { server.once("exit", resolve); server.kill(); });
  }
})().catch((error) => { console.error(error); process.exit(1); });
