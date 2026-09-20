"use strict";
// Мошенничество: обе стороны рынка.
//
// 1. NPC-продавцы врут. Дешёвое объявление может оказаться скрученным пробегом,
//    утопленником после мойки, залоговым автомобилем, перебитым VIN или «продавцом-однодневкой».
//    Пока обман не раскрыт — машина кажется находкой. Раскроете до покупки — получите
//    награду рынка, репутацию и скидку; проглядите — получите юридическую проблему уже в гараже.
//
// 2. Игрок может мухлевать сам. Серые схемы поднимают цену продажи, но копят «подозрение»,
//    и каждая сделка может закончиться расторжением, штрафом и изъятием автомобиля.
//    Чем выше криминальная известность, тем серьёзнее схемы и тем дороже замять дело.
//
// Все расчёты — чистые функции: их можно проверить без сервера и переиспользовать на клиенте.

function clamp(value, low, high) { return Math.min(high, Math.max(low, Number(value) || 0)); }
function round(value, step = 100) { const size = Math.max(1, step); return Math.round((Number(value) || 0) / size) * size; }

// ── Обманы продавцов ────────────────────────────────────────────────────────────
// depth — насколько глубоким должен быть осмотр, чтобы обман увидеть (см. inspectionQuote: 1..8).
const fraudCatalog = [
  {
    key: "odometer", name: "Скрученный пробег", category: "documents", depth: 3, severity: 2, weight: 30,
    hint: "Одометр перепрошит, реальный пробег вдвое больше заявленного.",
    priceFactor: 0.88, mileageFactor: 2.1, suspicionHint: "Пробег не стыкуется с возрастом салона"
  },
  {
    key: "salvage", name: "Утопленник после мойки", category: "electrics", depth: 4, severity: 3, weight: 22,
    hint: "Машина ушла под воду, блоки просушены и поставлены обратно.",
    priceFactor: 0.76, extraDefects: 2, suspicionHint: "Свежая шумоизоляция и запах сушителя"
  },
  {
    key: "pledged", name: "Автомобиль в залоге", category: "documents", depth: 5, severity: 3, weight: 18,
    hint: "В реестре обременений машина числится залоговой, продавец — подставное лицо.",
    priceFactor: 0.72, blocksRegistration: true, seizable: true, suspicionHint: "Цена заметно ниже рынка, продавец торопится"
  },
  {
    key: "vin", name: "Перебитый VIN", category: "documents", depth: 6, severity: 3, weight: 13,
    hint: "Маркировка нанесена повторно: в регистрации будет отказано.",
    priceFactor: 0.6, blocksRegistration: true, unregistrable: true, suspicionHint: "Несоответствие шрифта и глубины символов"
  },
  {
    key: "ghost", name: "Продавец-однодневка", category: "documents", depth: 4, severity: 2, weight: 15,
    hint: "Документы оформлены на несуществующего владельца, денег назад не вернуть.",
    priceFactor: 0.82, refundFactor: 0.4, suspicionHint: "Аккаунт создан сегодня, связей нет"
  }
];

const fraudByKey = new Map(fraudCatalog.map((item) => [item.key, item]));
function fraudSpec(key) { return fraudByKey.get(String(key || "")) || null; }

// Вероятность обмана: чем сильнее цена «ниже рынка» при заявленном хорошем состоянии,
// тем внимательнее надо смотреть документы. Уровень игрока слегка снижает долю развода.
function rollFraud({ askingRatio = 1, condition = 60, level = 1, forceChance = null, rng = Math.random } = {}) {
  const bargain = clamp(1 - clamp(Number(askingRatio) || 1, 0.3, 1.6), -0.2, 0.7);
  const polish = clamp((Number(condition) || 60) - 55, -25, 35) / 100;
  const natural = clamp(0.10 + bargain * 0.55 + Math.max(0, polish) * 0.35 - Math.min(10, Math.max(1, level)) * 0.004, 0.03, 0.42);
  // PEREKUP_FRAUD_RATE позволяет тестам (и «жёсткому» режиму рынка) задать долю обманных лотов напрямую.
  const chance = forceChance === null || !Number.isFinite(Number(forceChance)) ? natural : clamp(Number(forceChance), 0, 1);
  if (!(chance > 0) || rng() >= chance) return null;
  const total = fraudCatalog.reduce((sum, item) => sum + item.weight, 0);
  let cursor = rng() * total;
  for (const item of fraudCatalog) {
    cursor -= item.weight;
    if (cursor <= 0) return item.key;
  }
  return fraudCatalog[0].key;
}

// Достаточно ли глубокий осмотр, чтобы увидеть обман.
function revealsFraud(fraud, { category, score = 0, serviceDiagnosed = false } = {}) {
  if (!fraud) return false;
  if (serviceDiagnosed) return true;
  if (category && category !== fraud.category) return false;
  return Number(score) >= fraud.depth;
}

// Что игрок получает, если проверил документы ДО покупки и увидел обман.
function exposeReward(car, level = 1) {
  const price = Math.max(1000, Number(car?.price) || 0);
  return {
    cash: Math.max(1500, round(price * 0.02, 500)),
    xp: 45 + Math.max(1, level) * 4,
    reputation: 2,
    title: "Разоблачение",
    text: "Объявление снято с рынка, продавец-мошенник получил блок, вам выплачена премия рынка."
  };
}

// Юридическая проверка до покупки: вероятность увидеть обман.
function legalCheckChance({ appraisal = 0, terminal = 0, reputation = 50, depth = 3 } = {}) {
  return clamp(0.34 + appraisal * 0.11 + terminal * 0.14 + reputation / 500 - depth * 0.03, 0.15, 0.95);
}

function legalCheckCost(car) { return Math.max(400, round(Math.max(60000, Number(car?.price) || 0) * 0.014, 100)); }

// Претензия продавцу после покупки: шанс вернуть часть денег.
function claimChance({ appraisal = 0, reputation = 50, evidence = false } = {}) {
  return clamp(0.2 + appraisal * 0.08 + reputation / 400 + (evidence ? 0.25 : 0), 0.1, 0.9);
}

function claimPayout(car, recoveredShare) { return Math.max(500, round((Number(car?.purchasePrice) || Number(car?.price) || 0) * clamp(recoveredShare, 0, 1), 500)); }

// «Последствие» обмана для машины уже в гараже: юридический дефект с ценой,
// пропорциональной стоимости автомобиля, а не каталожными миллиардами.
function fraudDefect(fraud, car) {
  const cleanValue = Math.max(6000, Number(car?.cleanValue) || Number(car?.price) || 60000);
  const repair = Math.max(1200, round(cleanValue * (fraud.key === "vin" ? 0.09 : fraud.key === "pledged" ? 0.11 : 0.05), 100));
  const impact = Math.max(repair, round(cleanValue * (fraud.key === "vin" ? 0.26 : fraud.key === "pledged" ? 0.3 : 0.16), 500));
  return {
    code: `fraud_${fraud.key}`, category: fraud.category, name: fraud.name, symptom: fraud.hint,
    consequence: "Пока проблема в документах не закрыта, продажа или регистрация невозможны.",
    severity: fraud.severity, skill: 2, equipment: "historyTerminal", equipmentLevel: 1,
    repair, impact, fraud: fraud.key, repaired: false
  };
}

// ── Серые схемы игрока ──────────────────────────────────────────────────────────
const schemeCatalog = [
  {
    key: "odometer", name: "Скрутить пробег", description: "Перепрошиваете одометр: машина выглядит моложе, покупатель платит выше.",
    costShare: 0.02, minCost: 1200, priceBonus: 0.09, risk: 0.3, suspicion: 10, notoriety: 6,
    requires: { level: 1, notoriety: 0 }, cooldownMs: 0, exposure: "Покупатель сверит пробег по базам и от сделки откажется."
  },
  {
    key: "hideFaults", name: "Спрятать следы неисправностей", description: "Заглушки, мойка двигателя и косметика: при быстрой проверке дефекты не видны.",
    costShare: 0.035, minCost: 2000, priceBonus: 0.13, risk: 0.44, suspicion: 17, notoriety: 11,
    requires: { level: 1, notoriety: 8 }, needsOpenDefects: true, exposure: "Через пару недель дефекты всплывут, и покупатель вернётся с претензией."
  },
  {
    key: "cleanHistory", name: "Отмыть историю в базах", description: "Убираете чужие осмотры и помечаете автомобиль как обслуженный.",
    costShare: 0.04, minCost: 2500, priceBonus: 0.1, risk: 0.34, suspicion: 14, notoriety: 12,
    requires: { level: 2, notoriety: 16 }, skill: { key: "appraisal", level: 1 }, exposure: "Отчёт всплывёт у нового покупателя: доверие к вам просядет."
  },
  {
    key: "fakeDocs", name: "Дубликат ПТС без обременений", description: "Левый пакет документов закрывает юридические проблемы в глазах покупателя.",
    costShare: 0.06, minCost: 5000, priceBonus: 0.12, risk: 0.52, suspicion: 26, notoriety: 24,
    requires: { level: 3, notoriety: 34 }, unblocksLegal: true, exposure: "Экспертиза признает документы поддельными: машину изымают."
  },
  {
    key: "doubleDeposit", name: "Предоплата от двух покупателей", description: "Берёте задаток у двух клиентов, а машину отдаёте тому, кто заплатил первым.",
    costShare: 0, minCost: 0, priceBonus: 0, risk: 0.62, suspicion: 40, notoriety: 34,
    requires: { level: 4, notoriety: 52 }, needsPlayerOffer: true, depositShare: 0.18, exposure: "Обиженный клиент идёт писать заявление: рынок для вас закрывается."
  }
];

const schemeByKey = new Map(schemeCatalog.map((item) => [item.key, item]));
function schemeSpec(key) { return schemeByKey.get(String(key || "")) || null; }

function schemeCost(car, scheme) {
  const invested = Math.max(1000, Number(car?.invested) || Number(car?.price) || 0);
  return Math.max(scheme.minCost, round(invested * scheme.costShare, 100));
}

// Насколько схема раздувает цену, которую готов заплатить покупатель.
// aware — покупатель уже знает про подготовку, и «бонус» исчезает.
function deceptionBonus(car, aware = false) {
  if (aware) return 0;
  const schemes = (car?.schemes || []).map((item) => schemeSpec(item.key || item)).filter(Boolean);
  return clamp(schemes.reduce((sum, item) => sum + item.priceBonus, 0), 0, 0.4);
}

function concealedFromBuyer(car) { return Boolean((car?.schemes || []).some((item) => (item.key || item) === "hideFaults") && !car?.schemesExposed); }
function legalDocsForged(car) { return Boolean((car?.schemes || []).some((item) => (item.key || item) === "fakeDocs") && !car?.schemesExposed); }

// Итоговая вероятность, что схему раскусят: база схем складывается «как отказ от риска»,
// дальше на неё влияют репутация, навык оценщика, уровень подозрения и опытный покупатель.
function detectionChance({ car = null, buyerSkill = 0, appraisal = 0, reputation = 50, suspicion = 0, notoriety = 0 }) {
  const schemes = (car?.schemes || []).map((item) => schemeSpec(item.key || item)).filter(Boolean);
  if (!schemes.length) return 0;
  const safe = schemes.reduce((product, item) => product * (1 - item.risk), 1);
  const base = 1 - safe;
  const adjust = (Number(buyerSkill) || 0) * 0.03 + (Number(suspicion) || 0) / 300 + (Number(notoriety) || 0) / 700
    - (Number(appraisal) || 0) * 0.03 - clamp((Number(reputation) || 0) - 50, 0, 50) / 400;
  return clamp(base + adjust, 0.03, 0.92);
}

// Что бывает, когда схему раскусили прямо на сделке: деньги покупателю возвращаются,
// машина остаётся у вас, сверху — штраф и подозрение.
function schemePenalty(car, { profit = 0, level = 1, suspicion = 0 } = {}) {
  const schemes = (car?.schemes || []).map((item) => schemeSpec(item.key || item)).filter(Boolean);
  const severity = schemes.reduce((sum, item) => sum + item.suspicion, 0);
  const invested = Math.max(1000, Number(car?.invested) || Number(car?.price) || 0);
  const fine = Math.max(3000, round(Math.max(profit, 0) * 2.2 + invested * 0.12 + severity * 900, 500));
  return {
    fine,
    reputation: -Math.min(18, 4 + Math.round(severity / 6)),
    suspicion: Math.min(80, 22 + Math.round(severity / 2)),
    xp: 0,
    text: `Сделка расторгнута: покупатель${schemes.length > 1 ? "ы" : ""} заметили подготовку. Штраф ${fine.toLocaleString("ru-RU")} ₽, автомобиль вернулся в гараж.`
  };
}

// Награда за «чистую» серую сделку.
function schemeReward(car, level = 1) {
  const schemes = (car?.schemes || []).map((item) => schemeSpec(item.key || item)).filter(Boolean);
  const severity = schemes.reduce((sum, item) => sum + item.notoriety, 0);
  return { notoriety: severity, xp: 20 + severity, reputation: -1 };
}

// Подозрение остывает само: примерно одно очко в минуту.
const SUSPICION_HALF_LIFE_MS = 60 * 1000;
function decaySuspicion(suspicion, elapsedMs) {
  const value = clamp(Number(suspicion) || 0, 0, 100);
  if (value <= 0) return 0;
  const factor = Math.pow(0.5, Math.max(0, elapsedMs) / SUSPICION_HALF_LIFE_MS / 1.4);
  return Math.round(value * factor * 10) / 10;
}

// Если подозрение дошло до ста — «обыск»: теряете часть наличных, одну машину и рынок на время.
function raidPenalty({ cash = 0, netWorth = 0, level = 1 }) {
  const fine = Math.min(Math.max(0, Number(cash) || 0), Math.max(10000, round(Number(netWorth) || 0, 1) * 0.25));
  return {
    fine: round(fine, 500),
    reputation: -12,
    suspicionAfter: 30,
    blockMs: Math.max(60000, 12 * 60000 - Math.max(1, level) * 15000),
    seizesCar: true,
    text: "Вас взяли с поличным: часть наличных изъята, одна машина ушла на ответственное хранение, рынок временно закрыт."
  };
}

// Адвокат заминает дело: тем дороже, чем крупнее ваш капитал.
function lawyerCost(netWorth) { return Math.max(4000, round(Math.max(0, Number(netWorth) || 0) * 0.045, 500)); }
function lawyerRelief() { return 45; }

// ── Развод «жадного покупателя» ────────────────────────────────────────────────
// NPC предлагает цену ВЫШЕ вашей и просит «страховой депозит» — классика перекупского развода.
function rollScamOffer({ price = 0, sellerReputation = 50, level = 1, scamChance = null, rng = Math.random } = {}) {
  const natural = clamp(0.05 + Math.max(0, 60 - Number(sellerReputation) || 0) / 260 - Math.min(8, Math.max(1, level)) * 0.004, 0.01, 0.16);
  const chance = scamChance === null || !Number.isFinite(Number(scamChance)) ? natural : clamp(Number(scamChance), 0, 1);
  if (!(chance > 0) || rng() >= chance) return null;
  const amount = round(Math.max(1000, (Number(price) || 0) * (1.22 + rng() * 0.26)), 1000);
  const deposit = Math.max(1000, round((Number(price) || 0) * (0.1 + rng() * 0.09), 500));
  return {
    kind: "scam",
    amount,
    deposit,
    signs: [
      "Предлагает выше вашей цены и торопит с оформлением",
      "Просит «страховой депозит» до сделки",
      "Аккаунт создан только что, истории сделок нет"
    ],
    text: `Готов забрать за ${amount.toLocaleString("ru-RU")} ₽, но сначала переведи депозит ${deposit.toLocaleString("ru-RU")} ₽ — иначе «отдам дешевле другому».`
  };
}

// Насколько предложение похоже на развод (0..100) — подсказка в интерфейсе.
function scamSuspicionScore(offer, { level = 1, price = 0, reputation = 50 } = {}) {
  if (!offer) return 0;
  if (offer.kind === "scam") {
    const greed = clamp(((Number(offer.amount) || 0) / Math.max(1, Number(price) || 1) - 1) * 220, 0, 55);
    const deposit = clamp(((Number(offer.deposit) || 0) / Math.max(1, Number(price) || 1)) * 260, 0, 30);
    return clamp(20 + greed + deposit - clamp((Number(reputation) || 0) - 50, 0, 50) / 4, 5, 99);
  }
  const overpay = ((Number(offer.amount) || 0) / Math.max(1, Number(price) || 1) - 1) * 120;
  return clamp(6 + Math.max(0, overpay), 0, 40);
}

function scamRecovery(car, { success = false } = {}) {
  const deposit = Math.max(0, Number(car?.scamDeposit) || 0);
  return success ? round(deposit * 0.7, 100) : 0;
}

module.exports = {
  fraudCatalog, fraudSpec, rollFraud, revealsFraud, exposeReward, legalCheckChance, legalCheckCost,
  claimChance, claimPayout, fraudDefect,
  schemeCatalog, schemeSpec, schemeCost, deceptionBonus, concealedFromBuyer, legalDocsForged,
  detectionChance, schemePenalty, schemeReward,
  SUSPICION_HALF_LIFE_MS, decaySuspicion, raidPenalty, lawyerCost, lawyerRelief,
  rollScamOffer, scamSuspicionScore, scamRecovery
};
