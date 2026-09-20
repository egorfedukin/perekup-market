"use strict";
// Мошенничество: три опоры механики.
//   1. Обманутые NPC-объявления — скрытый «fraud» у лота, раскрытие документами / сервисом / юридической
//      проверкой, премия рынка за разоблачение и юридическая проблема в гараже, если просмотрели.
//   2. Серые схемы игрока — наценка, авторитет, подозрение, расторжение сделки и «обыск» на 100 %.
//   3. Разводы с предоплатой во входящих предложениях.
// Сначала чистая математика, потом интеграция через API, где доля обмана выкручена в 100 %
// переменными PEREKUP_FRAUD_RATE / PEREKUP_SCAM_RATE (в проде их нет — шансы считаются по рынку).
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const fraud = require("./fraud");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Часть 1. Чистые расчёты ─────────────────────────────────────────────────────
{
  // Распределение типов обмана: при forceChance = 1 встречаются все пять, при 0 — никогда.
  const forced = new Map();
  for (let i = 0; i < 3000; i += 1) {
    const key = fraud.rollFraud({ askingRatio: 0.7, condition: 70, forceChance: 1 });
    forced.set(key, (forced.get(key) || 0) + 1);
  }
  assert.equal(forced.size, fraud.fraudCatalog.length, `rollFraud must cover every type, got ${[...forced.keys()]}`);
  assert.ok([...forced.values()].every((count) => count > 100), JSON.stringify([...forced]));
  assert.equal(fraud.rollFraud({ askingRatio: 0.5, condition: 90, forceChance: 0 }), null, "forceChance 0 must stay clean");
  assert.equal(fraud.rollFraud({ rng: () => 0.99 }), null, "a boring lot must not be fraudulent");
  assert.ok(fraud.rollFraud({ askingRatio: 0.4, condition: 80, rng: () => 0.01 }), "a too-good-to-be-true lot must be fraudulent");

  // Раскрытие: нужная категория + глубина осмотра либо полная диагностика сервиса.
  const pledged = fraud.fraudSpec("pledged");
  assert.equal(fraud.revealsFraud(pledged, { category: "documents", score: 4 }), false, "залог на глубине 5 не открывается осмотром на 4");
  assert.equal(fraud.revealsFraud(pledged, { category: "documents", score: 5 }), true);
  assert.equal(fraud.revealsFraud(pledged, { category: "engine", score: 8 }), false, "чужая система не покажет обременение");
  assert.equal(fraud.revealsFraud(pledged, { category: "engine", score: 8, serviceDiagnosed: true }), true);
  assert.equal(fraud.revealsFraud(null, { serviceDiagnosed: true }), false, "нет обмана — нечего раскрывать");

  // Цены проверок и награды.
  assert.ok(fraud.legalCheckCost({ price: 40000, cleanValue: 60000 }) >= 400, "проверка не может быть бесплатной");
  assert.ok(fraud.legalCheckCost({ price: 4000000, cleanValue: 5000000 }) > fraud.legalCheckCost({ price: 40000, cleanValue: 60000 }) * 5, "проверка коллекционера дороже");
  const chanceRaw = fraud.legalCheckChance({ appraisal: 0, terminal: 0, reputation: 50, depth: 5 });
  const chancePro = fraud.legalCheckChance({ appraisal: 5, terminal: 3, reputation: 90, depth: 5 });
  assert.ok(chancePro > chanceRaw, "навык и терминал обязаны помогать");
  assert.ok(chanceRaw >= 0.15 && chancePro <= 0.95, `${chanceRaw}..${chancePro} вне коридора`);
  const bounty = fraud.exposeReward({ price: 200000 }, 1);
  assert.ok(bounty.cash >= 1500 && bounty.xp >= 45 && bounty.reputation === 2, JSON.stringify(bounty));
  assert.ok(fraud.exposeReward({ price: 2000000 }, 8).xp > bounty.xp, "опыт за бдительность растёт с уровнем");
  assert.ok(bounty.title && bounty.text, "у разоблачения должно быть человеческое описание");

  // Дефект обмана: документы, чинится на сервисе, бьёт по цене сильнее ремонта.
  const defect = fraud.fraudDefect(pledged, { cleanValue: 200000 });
  assert.equal(defect.code, "fraud_pledged");
  assert.equal(defect.category, "documents");
  assert.ok(defect.repair > 0 && defect.impact >= defect.repair, JSON.stringify(defect));

  // Схемы: риск потерять сделку обязан превышать выигрыш от наценки.
  const odometer = fraud.schemeSpec("odometer");
  const forgedDocs = fraud.schemeSpec("fakeDocs");
  assert.equal(odometer.requires.level, 1);
  assert.equal(odometer.requires.notoriety, 0, "первая схема должна быть доступна новичку");
  assert.ok(forgedDocs.requires.level >= 2 || forgedDocs.requires.notoriety > 0, "серьёзные схемы запираются прогрессом");
  const dirtyCar = { schemes: [{ key: "odometer" }], price: 200000, invested: 150000 };
  assert.ok(fraud.deceptionBonus(dirtyCar) > 0, "схема обязана давать наценку");
  assert.equal(fraud.deceptionBonus(dirtyCar, true), 0, "раскрытая схема больше не продаётся дороже");
  const hidden = { schemes: [{ key: "hideFaults" }], price: 200000, invested: 150000 };
  assert.equal(fraud.concealedFromBuyer(hidden), true, "скрытые дефекты покупатель не видит");
  assert.equal(fraud.concealedFromBuyer({ ...hidden, schemesExposed: true }), false, "раскрытую схему скрыть нельзя");
  assert.equal(fraud.concealedFromBuyer(dirtyCar), false, "скрученный пробег — не сокрытие дефектов");
  assert.equal(fraud.legalDocsForged({ schemes: [{ key: "fakeDocs" }] }), true, "дубликат ПТС обязан всплывать при экспертизе");
  const penalty = fraud.schemePenalty(dirtyCar, { profit: 40000, level: 3, suspicion: 40 });
  const reward = fraud.schemeReward(dirtyCar, 3);
  assert.ok(penalty.fine > 0 && /расторгнута/i.test(penalty.text), JSON.stringify(penalty));
  assert.ok(penalty.fine >= dirtyCar.price * fraud.deceptionBonus(dirtyCar), `штраф ${penalty.fine} обязан перекрывать наценку ${Math.round(dirtyCar.price * fraud.deceptionBonus(dirtyCar))}`);
  assert.ok(reward.notoriety > 0 && reward.xp > 0, JSON.stringify(reward));
  assert.ok(penalty.reputation <= reward.reputation && penalty.reputation < 0, "расторгнутая сделка бьёт по репутации сильнее чистой");
  assert.ok(fraud.schemeCost(dirtyCar, forgedDocs) >= forgedDocs.minCost, "минимальный порог стоимости схемы");
  assert.ok(fraud.schemeCost(dirtyCar, odometer) < fraud.schemeCost({ ...dirtyCar, price: 9000000, invested: 8000000 }, odometer), "схема дорожает вместе с машиной");
  assert.ok(fraud.schemeCost({ price: 30000, invested: 25000 }, odometer) >= odometer.minCost, "дешёвой машине нужна минимальная цена подготовки");
  assert.ok(fraud.detectionChance({ car: dirtyCar, appraisal: 5, suspicion: 90, notoriety: 80 }) > fraud.detectionChance({ car: dirtyCar, appraisal: 0, suspicion: 0, notoriety: 0 }), "чем больше мухлюешь, тем заметнее");

  // Подозрение: копится, остывает, снимается адвокатом; на 100 % приезжает «обыск».
  assert.equal(fraud.decaySuspicion(80, 0), 80, "без выдержки подозрение не тает");
  assert.ok(fraud.decaySuspicion(80, fraud.SUSPICION_HALF_LIFE_MS) < 60, "подозрение обязано остывать");
  assert.ok(fraud.decaySuspicion(80, fraud.SUSPICION_HALF_LIFE_MS * 4) < fraud.decaySuspicion(80, fraud.SUSPICION_HALF_LIFE_MS), "остывание монотонно");
  assert.ok(fraud.lawyerCost(1000000) > fraud.lawyerCost(100000), "адвокат дорожает вместе с капиталом");
  assert.ok(fraud.lawyerCost(0) > 0 && fraud.lawyerRelief() > 0, "адвокат обязан снижать подозрение за деньги");
  const raid = fraud.raidPenalty({ cash: 30000, netWorth: 400000, level: 1 });
  assert.ok(raid.fine > 0 && raid.fine <= 30000, `штраф обыска не влезает в кассу: ${raid.fine}`);
  assert.ok(raid.suspicionAfter < 100 && raid.blockMs > 0, JSON.stringify(raid));
  assert.equal(fraud.raidPenalty({ cash: 0, netWorth: 0, level: 10 }).fine, 0, "с нулём денег штраф нулевой");

  // Развод с предоплатой.
  const greedy = fraud.rollScamOffer({ price: 200000, rng: () => 0 });
  assert.equal(greedy.kind, "scam");
  assert.ok(greedy.amount >= 200000 * 1.2 && greedy.amount <= 200000 * 1.5, JSON.stringify(greedy));
  assert.ok(greedy.deposit >= 1000 && greedy.deposit <= 200000 * 0.2, JSON.stringify(greedy.deposit));
  assert.match(greedy.text, /депозит/i);
  assert.ok(greedy.signs.length >= 2, "признаки развода должны читаться глазами");
  assert.equal(fraud.rollScamOffer({ price: 200000, scamChance: 0, rng: () => 0 }), null, "scamChance 0 обязан отключать разводы");
  assert.ok(fraud.scamSuspicionScore(greedy, { price: 200000, reputation: 20, level: 1 }) >= 60, "такой оффер обязан подсвечиваться красным");
  assert.ok(fraud.scamSuspicionScore({ amount: 190000, buyerType: "bot" }, { price: 200000, reputation: 80, level: 8 }) < 45, "обычное предложение — не развод");
  assert.equal(fraud.scamRecovery({ scamDeposit: 10000 }), 0, "без удачного возврата депозит не возвращается");
  const back = fraud.scamRecovery({ scamDeposit: 10000 }, { success: true });
  assert.ok(back > 0 && back <= 10000, `потерянный депозит возвращают частично: ${back}`);
}

// ── Часть 2. Интеграция через API ───────────────────────────────────────────────
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-fraud-"));
const port = 6400 + process.pid % 120;
const base = `http://127.0.0.1:${port}`;
const failures = [];
let token = null;
let server = null;

function check(condition, message) { if (!condition) failures.push(message); }
async function request(url, body, expected = 200) {
  const res = await fetch(base + url, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== expected) throw new Error(`${url}: ${res.status} ${data.error || JSON.stringify(data).slice(0, 200)}`);
  return data;
}
// /api/join без авторизации: с чужим заголовком сервер резюмирует текущую сессию вместо нового аккаунта.
async function joinAs(name, pin, baseUrl = base) {
  const res = await fetch(`${baseUrl}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, pin }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`/api/join ${name}: ${res.status} ${data.error || ""}`);
  return data;
}
function attempt(url, body) {
  return fetch(base + url, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body || {})
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => ({})) }));
}

(async () => {
  server = spawn(process.execPath, ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory, PEREKUP_FRAUD_FAST: "1", PEREKUP_FRAUD_RATE: "1", PEREKUP_SCAM_RATE: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Start timeout")), 25000);
    server.once("error", reject);
    server.stdout.on("data", (chunk) => { if (String(chunk).includes("Perekup Market")) { clearTimeout(timer); resolve(); } });
  });

  try {
    const suffix = Date.now().toString().slice(-6);
    const admin = await joinAs("federuk", "9900");
    const adminToken = admin.token;
    const victim = await joinAs(`Fraud${suffix}`, "4411");
    token = adminToken;
    await request("/api/admin/player", { playerId: victim.player.id, cashMode: "set", cashValue: 5000000, reason: "Fraud test budget" });
    token = victim.token;

    // 1) Клиент не должен получать ни тип обмана, ни сам факт его наличия.
    let state = await request("/api/state");
    const lots = () => state.market.filter((car) => !car.sellerId && car.saleType !== "auction" && !(car.defects || []).some((defect) => String(defect.code || "").startsWith("fraud_")));
    check(lots().length >= 10, `нужны чистые лоты для покупки, есть ${lots().length}`);
    for (const car of state.market.filter((item) => !item.sellerId)) {
      const view = car.fraud || {};
      check(["unknown", "suspect", "clear", "confirmed", "dirty"].includes(view.status), `статус обмана вне алфавита: ${view.status}`);
      check(!("type" in view) && !("revealed" in view) && !("applied" in view), `view обмана протекает: ${JSON.stringify(view)}`);
      check(!car.defects.some((defect) => String(defect.code || "").startsWith("fraud_")), `обман виден в дефектах до раскрытия: ${car.model}`);
    }
    check(state.market.some((car) => car.fraudCheckCost > 0), "у объявления должна быть цена юридической проверки");
    check(state.fraudInfo?.rules?.check && state.fraudInfo.threats.length >= 4, "справка по механике мошенничества не приехала");
    check(state.fraudInfo.startingCash === 50000, `стартовый капитал в справке: ${state.fraudInfo.startingCash}`);
    check(state.player.fraud && state.player.fraud.stage, "player.fraud пустой");
    check(Array.isArray(state.player.fraud.schemeOptions) && state.player.fraud.schemeOptions.length === 5, "каталог схем не приехал");
    check(state.player.fraud.schemeOptions.some((scheme) => scheme.key === "odometer" && scheme.unlocked), "первая схема доступна с 1 уровня");
    check(state.player.fraud.schemeOptions.some((scheme) => !scheme.unlocked), "часть схем заперта за авторитетом");
    check(state.player.fraud.schemes === 0, `счётчик схем должен быть числом: ${JSON.stringify(state.player.fraud.schemes)}`);
    check(state.player.fraud.blocked === 0 && state.player.fraud.suspicion === 0, "чистый игрок не обязан быть под подозрением");

    // 2) Отказываемся платить за воздух и жаловаться без доказательств.
    await request("/api/fraud/check", { carId: "car_missing" }, 404);
    await request("/api/fraud/expose", { carId: lots()[0].id }, 400);
    // 3) Юридическая проверка вскрывает обман (шанс роллится на каждую попытку).
    let revealedId = null;
    let checkCost = 0;
    for (let round = 0; round < 6 && !revealedId; round += 1) {
      const queue = lots().slice(0, 10);
      for (const lot of queue) {
        if (revealedId) break;
        const cashBefore = state.player.cash;
        const checked = await request("/api/fraud/check", { carId: lot.id });
        checkCost = checked.fraudCheck.cost;
        check(checked.player.cash === cashBefore - checkCost, "проверка обязана списываться с баланса");
        check(checked.fraudCheck.chance >= 15 && checked.fraudCheck.chance <= 95, `шанс проверки вне коридора: ${checked.fraudCheck.chance}`);
        if (checked.fraudCheck.revealed) {
          revealedId = lot.id;
          check(checked.fraudCheck.fraud?.name && checked.fraudCheck.fraud?.hint, `раскрытие без описания: ${JSON.stringify(checked.fraudCheck.fraud)}`);
          const listed = checked.market.find((car) => car.id === revealedId);
          check(listed?.fraud?.status === "confirmed", `лот после раскрытия: ${JSON.stringify(listed?.fraud)}`);
          check((listed?.defects || []).some((defect) => String(defect.code || "").startsWith("fraud_")), "раскрытый обман обязан появиться в дефектах лота");
        } else {
          check(checked.fraudCheck.fraud === null, "чистый ответ не должен описывать обман");
          const listed = checked.market.find((car) => car.id === lot.id);
          check(listed?.fraud?.status === "clear", `после неудачной проверки статус: ${JSON.stringify(listed?.fraud)}`);
        }
        state = checked;
      }
      if (!revealedId) { await sleep(400); state = await request("/api/state"); }
    }
    check(checkCost > 0 && checkCost <= 30000, `цена юридической проверки разорительна: ${checkCost}`);
    check(revealedId, "за 60 попыток ни одна проверка ничего не нашла при 100 % доле обмана");

    // 4) Разоблачение: лот уходит с рынка, игрок получает премию, XP и репутацию.
    const beforeExpose = state.player;
    const exposed = await request("/api/fraud/expose", { carId: revealedId });
    check(exposed.fraudResult.exposed === true && exposed.fraudResult.bounty > 0, JSON.stringify(exposed.fraudResult));
    check(exposed.player.cash === beforeExpose.cash + exposed.fraudResult.bounty, `премия не совпадает: ${exposed.player.cash - beforeExpose.cash} ≠ ${exposed.fraudResult.bounty}`);
    check(exposed.player.fraud.exposed === beforeExpose.fraud.exposed + 1, "счётчик разоблачений не вырос");
    check(exposed.player.reputation.score >= beforeExpose.reputation.score, "репутация за бдительность не выросла");
    check(exposed.player.xp > beforeExpose.xp, "разоблачение не дало опыта");
    check(!exposed.market.some((car) => car.id === revealedId), "обманутый лот остался на рынке");
    check(exposed.player.fraud.history.some((item) => item.kind === "exposed"), "лента риска пуста");
    state = exposed;

    // 5) Покупаем лот, обман не раскрыт → юридическая проблема приезжает в гараж.
    const trap = lots().sort((a, b) => a.price - b.price).find((car) => car.price <= state.player.cash * 0.4);
    check(trap, "нечего купить для проверки последствий обмана");
    const bought = await request("/api/buy", { carId: trap.id });
    const trapCar = () => boughtGarage(bought, trap.id);
    check(trapCar(), "машина не доехала до гаража");
    const fraudDefects = (trapCar().defects || []).filter((item) => String(item.code || "").startsWith("fraud_"));
    check(bought.player.fraud.scammed >= 1, "покупка без проверки обязана считаться обманом");
    check(bought.player.fraud.scammedCash > 0, "потери от обмана должны считаться в деньгах");
    check(fraudDefects.length >= 1, `обман не добавлен в дефекты: ${JSON.stringify(trapCar().defects?.map((item) => item.code))}`);
    check(trapCar().saleBlocked === true && /неисправност|документ|пробег|залог|однодневк|утопленник|VIN/i.test(trapCar().saleBlockReason || ""), `гараж не предупредил о проблеме: ${JSON.stringify(trapCar().saleBlockReason)}`);
    state = bought;

    // 6) Объявление с известной юридической проблемой не выставить, на учёт не поставить.
    const listAttempt = await attempt("/api/list", { carId: trap.id, price: Math.max(1000, Math.round((trapCar().invested || 50000) * 1.1)), description: "Продан как есть" });
    check(listAttempt.status === 409, `объявление с известной проблемой не заблокировано: ${listAttempt.status} ${JSON.stringify(listAttempt.body).slice(0, 120)}`);
    check(/неисправност/i.test(listAttempt.body.error || ""), `странное сообщение о блокировке: ${listAttempt.body.error}`);
    if (trapCar().fraudLegalHold) {
      const registration = await attempt("/api/car/registration", { carId: trap.id, action: "register" });
      check(registration.status === 409 && /приостановлен/i.test(registration.body.error || ""), `постановка на учёт не заблокирована: ${registration.status} ${registration.body.error}`);
    }

    // 7) Претензия продавцу: деньги возвращаются частично, повторная — отказ.
    const beforeClaim = state.player.cash;
    const claimed = await request("/api/fraud/claim", { carId: trap.id });
    check(claimed.fraudResult.amount > 0, `компенсация обязана быть: ${JSON.stringify(claimed.fraudResult)}`);
    check(claimed.player.cash === beforeClaim - claimed.fraudResult.fee + claimed.fraudResult.amount, `проведка претензии не бьётся: ${JSON.stringify(claimed.fraudResult)}`);
    check(claimed.player.fraud.claims === 1, "счётчик претензий не обновился");
    check(claimed.player.fraud.history.some((item) => item.kind === "claim"), "претензия не попала в ленту риска");
    await request("/api/fraud/claim", { carId: trap.id }, 409);
    state = claimed;

    // 8) Сервис закрывает проблему документов — машину можно продавать.
    // Полная диагностика: до неё часть проблем скрыта, а покупатель-бот найдёт их сам и
    // в ответ откажется от торга — объявление останется без предложений.
    state = await request("/api/service-diagnostic", { carId: trap.id });
    let garageCar = state.player.garage.find((item) => item.id === trap.id);
    for (let pass = 0; pass < 8; pass += 1) {
      garageCar = state.player.garage.find((item) => item.id === trap.id);
      const open = garageCar.defects.filter((item) => !item.repaired);
      if (!open.length) break;
      for (const defect of open) {
        const plan = (defect.servicePlans || []).some((item) => item.key === "standard") ? "standard" : "budget";
        const repaired = await request("/api/repair", { carId: garageCar.id, defect: defect.code, mode: "workshop", plan });
        state = repaired;
      }
    }
    garageCar = state.player.garage.find((item) => item.id === trap.id);
    check(garageCar.defects.every((item) => item.repaired), `сервис не закрыл проблемы документов: ${JSON.stringify(garageCar.defects.filter((item) => !item.repaired).map((item) => item.code))}`);
    check(garageCar.saleBlocked !== true, `гараж всё ещё под блокировкой: ${garageCar.saleBlockReason}`);
    // Цена ниже оценки: иначе боты не выйдут на связь, и проверка на развод превратится в ожидание.
    const estimate = garageCar.saleEstimate?.expectedNpcPrice || garageCar.invested;
    const listing = await attempt("/api/list", { carId: garageCar.id, price: Math.max(1000, Math.round(estimate * 0.8)), description: "Документы чисты, торг уместен" });
    check(listing.status === 200, `починенную машину не выставить: ${JSON.stringify(listing.body).slice(0, 160)} :: ${JSON.stringify({ diagnosed: garageCar.serviceDiagnosed, defects: garageCar.defects.map((item) => [item.code, item.repaired, String(item.fraud || "")]) })}`);
    state = listing.body;

    // 9) Серые схемы: наценка, авторитет, подозрение, «грязный» взгляд продавца.
    const beforeScheme = state.player;
    const mileageBefore = state.market.find((item) => item.id === garageCar.id)?.mileage;
    state = await request("/api/fraud/scheme", { carId: garageCar.id, key: "odometer" });
    const schemeResult = state.fraudResult;
    check(schemeResult.scheme === "odometer" && schemeResult.cost >= 0, JSON.stringify(schemeResult));
    const listedCar = () => state.market.find((item) => item.id === garageCar.id);
    check(listedCar()?.mileage < mileageBefore, `пробег не скручен: ${mileageBefore} → ${listedCar()?.mileage}`);
    check(state.player.fraud.notoriety > beforeScheme.fraud.notoriety, "авторитет не вырос");
    check(state.player.fraud.suspicion > beforeScheme.fraud.suspicion, "подозрение не выросло");
    check(state.player.fraud.schemes === beforeScheme.fraud.schemes + 1, "счётчик схем не обновился");
    check(state.player.fraud.history.some((item) => item.kind === "scheme"), "схема не попала в ленту риска");
    check(listedCar()?.fraud?.status === "dirty", `глазами продавца лот должен быть «грязным»: ${JSON.stringify(listedCar()?.fraud)}`);
    check(listedCar().fraud.deceptionBonus > 0 && listedCar().fraud.risk > 0, JSON.stringify(listedCar().fraud));
    check(listedCar().fraud.schemes.some((item) => item.key === "odometer"), "список схем пуст");
    await request("/api/fraud/scheme", { carId: garageCar.id, key: "odometer" }, 409);
    await request("/api/fraud/scheme", { carId: garageCar.id, key: "nope" }, 400);
    await request("/api/fraud/scheme", { carId: "car_ghost", key: "odometer" }, 404);
    const locked = await attempt("/api/fraud/scheme", { carId: garageCar.id, key: "doubleDeposit" });
    check(locked.status === 403 && /авторитет|уровн/i.test(locked.body.error || ""), `запертая схема доступна: ${locked.status} ${locked.body.error}`);

    // 10) Адвокат сжигает подозрение за деньги, потом дело закрыто.
    for (let round = 0; round < 8; round += 1) {
      state = await request("/api/state");
      if (state.player.fraud.suspicion <= 0) break;
      const cost = state.player.fraud.lawyerCost;
      const cashBefore = state.player.cash;
      const suspicionBefore = state.player.fraud.suspicion;
      const defended = await request("/api/fraud/lawyer", {});
      check(defended.player.fraud.suspicion < suspicionBefore, "адвокат не снизил подозрение");
      check(defended.player.cash <= cashBefore - 1, "адвокат должен стоить денег");
      check(cost > 0, "у адвоката обязана быть цена");
      state = defended;
    }
    state = await request("/api/state");
    check(state.player.fraud.suspicion <= 0, `подозрение не обнулилось: ${state.player.fraud.suspicion}`);
    await request("/api/fraud/lawyer", {}, 400);

    // 11) Развод с предоплатой во входящих предложениях (PEREKUP_SCAM_RATE=1).
    // Перевыставляем объявление: боты выходят на связь через 2,5–4,5 с после листинга.
    await request("/api/unlist", { carId: garageCar.id });
    state = await request("/api/list", { carId: garageCar.id, price: Math.max(1000, Math.round(estimate * 0.8)), description: "Документы чисты, торг уместен" });
    let scamOffer = null;
    for (let round = 0; round < 40 && !scamOffer; round += 1) {
      await sleep(700);
      state = await request("/api/state");
      scamOffer = state.player.incomingOffers.find((offer) => (offer.suspicion?.score || 0) >= 60);
    }
    check(scamOffer, "боты не принесли ни одного подозрительного предложения при 100 % доле разводов");
    if (scamOffer) {
      check(scamOffer.suspicion.deposit > 0 && scamOffer.suspicion.signs.length >= 1, `признаки развода не описаны: ${JSON.stringify(scamOffer.suspicion)}`);
      check(!("kind" in scamOffer), "клиент не должен получать метку kind напрямую");
      check(scamOffer.amount > listedCar().price, "развод обязан выглядеть щедрее цены объявления");
      const soft = await attempt("/api/offer/respond", { offerId: scamOffer.id, action: "accept" });
      check(soft.status === 409 && /депозит/i.test(soft.body.error || ""), `подтверждение депозита не спросили: ${soft.status} ${soft.body.error}`);
      const exposeResult = await request("/api/offer/respond", { offerId: scamOffer.id, action: "expose" });
      check(exposeResult.fraudResult?.success === true && exposeResult.fraudResult.bounty > 0, JSON.stringify(exposeResult.fraudResult));
      check(!exposeResult.player.incomingOffers.some((offer) => offer.id === scamOffer.id && ["active", "counter"].includes(offer.status)), "предложение развода осталось активным");
      check(exposeResult.player.fraud.exposed >= 2, "разоблачение покупателя не засчитано");
      state = exposeResult;
    }

    // 12) Обыск: доводим подозрение до ста серыми схемами — сделки закрываются, деньги горят.
    const risky = await joinAs(`Risky${suffix}`, "4422");
    token = adminToken;
    await request("/api/admin/player", { playerId: risky.player.id, cashMode: "set", cashValue: 1500000, reason: "Raid test" });
    token = risky.token;
    let raidState = await request("/api/state");
    for (let round = 0; round < 10; round += 1) {
      raidState = await request("/api/state");
      if (raidState.player.fraud.suspicion >= 100 || raidState.player.fraud.blocked > 0) break;
      if (raidState.player.garage.length >= raidState.player.garageCapacity) await sleep(600);
      const free = raidState.player.garage.length < raidState.player.garageCapacity;
      if (free) {
        // Берём самый дешёвый доступный лот: цель раунда — подозрение, а не дорогая иномарка.
        const lot = raidState.market.filter((car) => !car.sellerId && car.saleType !== "auction" && car.price <= raidState.player.cash * 0.4).sort((a, b) => a.price - b.price)[0];
        if (!lot) { await sleep(400); continue; }
        const purchased = await attempt("/api/buy", { carId: lot.id });
        if (purchased.status !== 200) { await sleep(400); continue; }
        raidState = purchased.body;
      }
      for (const car of raidState.player.garage) {
        await attempt("/api/fraud/scheme", { carId: car.id, key: "odometer" });
        await attempt("/api/fraud/scheme", { carId: car.id, key: "hideFaults" });
      }
    }
    raidState = await request("/api/state");
    check(raidState.player.fraud.schemes >= 2, `схемы не применяются: ${JSON.stringify(raidState.player.fraud).slice(0, 200)}`);
    check(raidState.player.fraud.notoriety > 0, "криминальный авторитет не рос");
    check(raidState.player.fraud.suspicion > 0, "подозрение не копится");
    let raided = null;
    for (let round = 0; round < 60 && !raided; round += 1) {
      const snapshot = await request("/api/state");
      if (snapshot.player.fraud.history.some((item) => item.kind === "raid")) raided = snapshot;
      else if (snapshot.player.fraud.suspicion < 100) {
        for (const car of snapshot.player.garage) await attempt("/api/fraud/scheme", { carId: car.id, key: "cleanHistory" });
        await sleep(300);
      } else await sleep(300);
    }
    check(raided, `подозрение ${raidState.player.fraud.suspicion} дошло до ста, а «обыска» нет`);
    if (raided) {
      check(raided.player.fraud.finesPaid > 0 || raided.player.fraud.seizedCars > 0, "обыск прошёл без последствий");
      check(raided.player.fraud.suspicion < 100, "после обыска подозрение обязано остыть");
      const blockedLot = (await request("/api/state")).market.filter((car) => !car.sellerId && car.saleType !== "auction").sort((a, b) => a.price - b.price)[0];
      const blockedBuy = await attempt("/api/buy", { carId: blockedLot?.id });
      check(blockedBuy.status === 403 && /разбирательств/i.test(blockedBuy.body.error || ""), `сделки во время разбирательства открыты: ${blockedBuy.status} ${blockedBuy.body.error}`);
    }

    // 13) Тихий рынок: при 0 % обмана ни одна проверка ничего не находит.
    const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), "market-fraud-clean-"));
    const cleanPort = port + 1;
    const cleanServer = spawn(process.execPath, ["server.js"], {
      cwd: __dirname,
      env: { ...process.env, PORT: String(cleanPort), PEREKUP_DATA_DIR: cleanDir, PEREKUP_FRAUD_RATE: "0", PEREKUP_SCAM_RATE: "0" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Clean start timeout")), 25000);
        cleanServer.once("error", reject);
        cleanServer.stdout.on("data", (chunk) => { if (String(chunk).includes("Perekup Market")) { clearTimeout(timer); resolve(); } });
      });
      const cleanBase = `http://127.0.0.1:${cleanPort}`;
      const join = await (await fetch(`${cleanBase}/api/join`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: `Clean${suffix}`, pin: "4433" }) })).json();
      const headers = { Authorization: `Bearer ${join.token}` };
      const cleanState = await (await fetch(`${cleanBase}/api/state`, { headers })).json();
      check(cleanState.market.filter((car) => car.fraud && car.fraud.status === "confirmed").length === 0, "на «чистом» рынке кто-то уже обманут");
      const cleanLot = cleanState.market.filter((car) => !car.sellerId && car.saleType !== "auction").sort((a, b) => a.price - b.price)[0];
      const checked = await (await fetch(`${cleanBase}/api/fraud/check`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ carId: cleanLot.id }) })).json();
      check(checked.fraudCheck?.revealed === false && checked.fraudCheck?.fraud === null, `чистый лот выдал обман: ${JSON.stringify(checked.fraudCheck)}`);
      check(checked.market.find((car) => car.id === cleanLot.id)?.fraud?.status === "clear", "после чистой проверки статус не сбросился");
      const cleanBought = await (await fetch(`${cleanBase}/api/buy`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ carId: cleanLot.id }) })).json();
      const cleanCar = cleanBought.player?.garage?.find((item) => item.id === cleanLot.id);
      check(cleanCar, `покупка на чистом рынке не прошла: ${JSON.stringify(cleanBought).slice(0, 160)}`);
      check(cleanCar && !cleanCar.defects.some((item) => String(item.code || "").startsWith("fraud_")), "на чистом рынке в гараж приехал обман");
      check(cleanBought.player?.fraud?.scammed === 0, "обмана не было, а счётчик вырос");
      const noClaim = await (await fetch(`${cleanBase}/api/fraud/claim`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ carId: cleanLot.id }) }));
      check(noClaim.status === 400, "претензия без повода прошла");
    } finally {
      cleanServer.kill("SIGTERM");
      fs.rmSync(cleanDir, { recursive: true, force: true });
    }

    if (failures.length) throw new Error(failures.join("\n  "));
    console.log("PASS: hidden seller fraud, exposure bounty, legal hold + claim + service fix, grey schemes, lawyer, deposit scams, quiet market, raid at 100% suspicion");
  } finally {
    server.kill("SIGTERM");
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch((error) => { console.error(`FAIL: ${error.message}`); process.exitCode = 1; });

function boughtGarage(state, carId) {
  return (state.player?.garage || []).find((item) => item.id === carId);
}
