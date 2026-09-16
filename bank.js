"use strict";
// Банк: кредиты для игроков и налог с продажи автомобилей.
// Все расчёты вынесены в чистые функции, чтобы их можно было проверять без сервера.

// Один платёжный период кредита. По умолчанию 10 минут реального времени, в тестах можно ускорить.
const LOAN_PERIOD_MS = Math.max(200, Number(process.env.PEREKUP_LOAN_PERIOD_MS) || 10 * 60 * 1000);
const MAX_ACTIVE_LOANS = 2;
const ISSUE_FEE_RATE = 0.01;       // комиссия за выдачу: защищает от «взял — сразу вернул бесплатно»
const MIN_ISSUE_FEE = 1000;
const LATE_PENALTY_RATE = 0.005;   // пеня за каждый период просрочки от суммы долга
const MISSED_BEFORE_COLLECTION = 3; // после стольких пропусков подряд банк забирает автомобили
const COLLECTION_PRICE_FACTOR = 0.7; // банк продаёт изъятую машину ниже рынка
const GARNISH_RATE = 0.35;           // доля от продаж и доходов, удерживаемая во взыскании
const COLLECTION_COOLDOWN_MS = 24 * 3600 * 1000; // после взыскания новые кредиты закрыты на сутки

const loanProducts = [
  { key: "express", name: "Экспресс", tag: "Быстрые деньги", periods: 6, rate: 0.02, minLevel: 1, minRating: 0, maxShare: 0.6, description: "Небольшая сумма на диагностику, ремонт или срочный выкуп. Дорого, но доступно с первого уровня." },
  { key: "working", name: "Оборотный", tag: "Для перекупа", periods: 12, rate: 0.014, minLevel: 3, minRating: 480, maxShare: 1, description: "Средний срок и умеренная ставка. Подходит для покупки машины под перепродажу." },
  { key: "invest", name: "Инвестиционный", tag: "Крупные сделки", periods: 24, rate: 0.009, minLevel: 6, minRating: 600, maxShare: 1, description: "Длинный срок и низкая ставка для недвижимости, бизнеса и премиальных лотов. Требует хорошей кредитной истории." }
];

// Налоговые правила продажи автомобилей.
const carTax = {
  baseRate: 0.13,          // НДФЛ с прибыли от сделки
  highRate: 0.15,          // повышенная ставка на прибыль сверх порога
  highThreshold: 5000000,  // порог повышенной ставки за одну сделку
  minRate: 0.06,           // ниже этой ставки вычеты не опускают налог
  holidayDeals: 3,         // первые сделки новичка без налога
  holidayMaxLevel: 3,      // налоговые каникулы действуют только на низких уровнях
  showroomDeductionFactor: 0.2 // бонус шоурума (0..0.15) уменьшает ставку до 3 п.п.
};

function round(value) { return Math.round(Number(value) || 0); }
function clamp(value, low, high) { return Math.min(high, Math.max(low, value)); }

// Кредитный рейтинг 300..850: репутация, уровень, история платежей и текущая просрочка.
function creditRating(player, level = 1) {
  const credit = player.credit || {};
  const reputation = Number(player.reputation?.score ?? 50);
  const activeMissed = (player.loans || []).filter((loan) => loan.status === "active").reduce((sum, loan) => sum + (loan.missed || 0), 0);
  const score = 420 + reputation * 2 + Math.min(30, level) * 6 + Math.min(10, credit.repaid || 0) * 15 - (credit.missed || 0) * 25 - (credit.seized || 0) * 60 - activeMissed * 50 + Math.min(20, Number(player.deals) || 0) * 3;
  return clamp(round(score), 300, 850);
}

function ratingLabel(rating) {
  if (rating >= 750) return "Отличный";
  if (rating >= 650) return "Хороший";
  if (rating >= 550) return "Средний";
  if (rating >= 450) return "Низкий";
  return "Плохой";
}

// Лимит растёт с уровнем и оборотом, а рейтинг работает как множитель 0.5..1.5.
function creditLimit(player, level = 1, rating = creditRating(player, level)) {
  const base = 200000 + Math.min(30, level) * 300000;
  const turnover = Math.min(base, (Number(player.deals) || 0) * 50000);
  const factor = clamp(rating / 650, 0.5, 1.5);
  return clamp(Math.round((base + turnover) * factor / 10000) * 10000, 100000, 50000000);
}

function activeDebt(player) {
  return (player.loans || []).filter((loan) => ["active", "collection"].includes(loan.status)).reduce((sum, loan) => sum + loan.balance + (loan.overdue || 0), 0);
}

function hasOverdue(player) {
  return (player.loans || []).some((loan) => ["active", "collection"].includes(loan.status) && (loan.overdue || 0) > 0);
}

// Персональная ставка: продуктовая ставка × коэффициент 0.75..1.25 в зависимости от рейтинга.
function effectiveRate(product, rating) {
  const factor = 1.25 - clamp((rating - 300) / 550, 0, 1) * 0.5;
  return Math.round(product.rate * factor * 10000) / 10000;
}

function annuityPayment(principal, rate, periods) {
  if (periods <= 0) return principal;
  if (rate <= 0) return principal / periods;
  return principal * rate / (1 - Math.pow(1 + rate, -periods));
}

function loanQuote(product, amount, rating) {
  const principal = round(amount);
  const rate = effectiveRate(product, rating);
  const payment = Math.ceil(annuityPayment(principal, rate, product.periods));
  const fee = Math.max(MIN_ISSUE_FEE, round(principal * ISSUE_FEE_RATE));
  const total = payment * product.periods;
  return { productKey: product.key, principal, rate, ratePct: Math.round(rate * 10000) / 100, periods: product.periods, payment, fee, total, overpayment: total - principal + fee, received: principal - fee };
}

// Максимальная сумма кредита, при которой аннуитетный платёж не превышает affordablePayment.
function principalForPayment(payment, rate, periods) {
  if (payment <= 0) return 0;
  if (rate <= 0) return payment * periods;
  return payment * (1 - Math.pow(1 + rate, -periods)) / rate;
}

// Скоринг заявки. Банк смотрит на три вещи:
//  1) рейтинговый лимит (уровень, история, репутация);
//  2) капитал заёмщика — нельзя занять больше, чем netWorth × плечо (0.6..1.8 по рейтингу);
//  3) платёжеспособность — платёж не должен превышать 6% капитала + 50% среднего дохода за период.
// Итог — минимум из трёх. Так игрок с 650 000 ₽ не получит миллиард.
function underwrite(product, { player, level, rating, limit, netWorth = 0, incomePerPeriod = 0 }) {
  const debt = activeDebt(player);
  const rate = effectiveRate(product, rating);
  const leverage = 0.6 + clamp((rating - 300) / 550, 0, 1) * 1.2;
  const byRating = Math.max(0, Math.min(limit * product.maxShare, limit - debt));
  const byCapital = Math.max(0, netWorth * leverage - debt);
  const affordablePayment = Math.max(0, netWorth) * 0.06 + Math.max(0, incomePerPeriod) * 0.5 - currentPayments(player);
  const byIncome = Math.max(0, principalForPayment(affordablePayment, rate, product.periods));
  const approved = Math.max(0, Math.floor(Math.min(byRating, byCapital, byIncome) / 1000) * 1000);
  const limiting = approved >= Math.floor(byRating / 1000) * 1000 ? "rating" : approved >= Math.floor(byCapital / 1000) * 1000 ? "capital" : "income";
  return { approved, byRating: Math.floor(byRating), byCapital: Math.floor(byCapital), byIncome: Math.floor(byIncome), leverage: Math.round(leverage * 100) / 100, affordablePayment: Math.floor(affordablePayment), netWorth: Math.floor(netWorth), incomePerPeriod: Math.floor(incomePerPeriod), limiting, rate };
}

function currentPayments(player) {
  return (player.loans || []).filter((loan) => loan.status === "active").reduce((sum, loan) => sum + loan.payment, 0);
}

function inCollection(player) {
  return (player.loans || []).some((loan) => loan.status === "collection");
}

function productAvailability(product, player, level, rating, limit, context = {}) {
  const activeCount = (player.loans || []).filter((loan) => ["active", "collection"].includes(loan.status)).length;
  const decision = underwrite(product, { player, level, rating, limit, ...context });
  const maxAmount = decision.approved;
  const cooldownLeft = Math.max(0, (player.credit?.blockedUntil || 0) - Date.now());
  let reason = null;
  if (level < product.minLevel) reason = `Доступно с ${product.minLevel} уровня`;
  else if (rating < product.minRating) reason = `Нужен кредитный рейтинг от ${product.minRating}`;
  else if (inCollection(player)) reason = "Долг передан во взыскание. Новые кредиты недоступны до полного погашения";
  else if (cooldownLeft > 0) reason = `После взыскания банк не кредитует ещё ${Math.ceil(cooldownLeft / 3600000)} ч`;
  else if (hasOverdue(player)) reason = "Сначала погасите просрочку";
  else if (activeCount >= MAX_ACTIVE_LOANS) reason = `Не больше ${MAX_ACTIVE_LOANS} активных кредитов`;
  else if (maxAmount < 10000) reason = decision.limiting === "income" ? "Отказ: платёж не по карману. Увеличьте капитал или доход" : decision.limiting === "capital" ? "Отказ: недостаточно капитала под обеспечение" : "Лимит исчерпан";
  return { maxAmount, reason, available: !reason, decision };
}

function createLoan(product, amount, rating, now = Date.now(), makeId = () => `loan_${now}`) {
  const quote = loanQuote(product, amount, rating);
  return {
    id: makeId(), productKey: product.key, name: product.name, principal: quote.principal, balance: quote.principal, rate: quote.rate, periods: product.periods, paidPeriods: 0,
    payment: quote.payment, fee: quote.fee, overdue: 0, missed: 0, missedTotal: 0, interestPaid: 0, penaltyPaid: 0,
    issuedAt: now, nextPaymentAt: now + LOAN_PERIOD_MS, status: "active", history: [{ type: "issued", text: `Выдано ${quote.principal.toLocaleString("ru-RU")} ₽, комиссия ${quote.fee.toLocaleString("ru-RU")} ₽`, at: now }]
  };
}

// Сумма планового платежа: проценты на остаток + тело, но не больше остатка.
function scheduledDue(loan) {
  const interest = round(loan.balance * loan.rate);
  const principalPart = Math.min(loan.balance, Math.max(0, loan.payment - interest));
  return { interest, principalPart, due: interest + principalPart };
}

// Плановое списание одного периода. Возвращает, сколько списано и был ли пропуск.
function applyScheduledPayment(loan, availableCash, now = Date.now()) {
  const { interest, principalPart, due } = scheduledDue(loan);
  const owed = due + (loan.overdue || 0);
  loan.nextPaymentAt += LOAN_PERIOD_MS;
  if (availableCash >= owed) {
    const penaltyPart = loan.overdue || 0;
    loan.overdue = 0; loan.missed = 0;
    loan.balance -= principalPart; loan.paidPeriods += 1; loan.interestPaid += interest; loan.penaltyPaid += penaltyPart;
    loan.history.push({ type: "payment", text: `Платёж ${owed.toLocaleString("ru-RU")} ₽ (проценты ${interest.toLocaleString("ru-RU")} ₽)`, at: now });
    if (loan.balance <= 0 || loan.paidPeriods >= loan.periods) { loan.balance = 0; loan.status = "closed"; loan.closedAt = now; loan.history.push({ type: "closed", text: "Кредит закрыт", at: now }); }
    return { charged: owed, interest, missed: false, closed: loan.status === "closed" };
  }
  // Пропуск: платёж уходит в просрочку, на весь долг начисляется пеня.
  const penalty = round((loan.balance + (loan.overdue || 0) + due) * LATE_PENALTY_RATE);
  loan.overdue = (loan.overdue || 0) + due + penalty;
  loan.missed += 1; loan.missedTotal += 1; loan.paidPeriods += 1;
  loan.history.push({ type: "missed", text: `Пропущен платёж ${due.toLocaleString("ru-RU")} ₽, пеня ${penalty.toLocaleString("ru-RU")} ₽`, at: now });
  return { charged: 0, missed: true, penalty, collection: loan.missed >= MISSED_BEFORE_COLLECTION };
}

// Досрочное погашение: сначала просрочка, затем тело. Проценты за будущие периоды не берутся.
function applyEarlyRepayment(loan, amount, now = Date.now()) {
  let remaining = round(amount);
  const overduePart = Math.min(remaining, loan.overdue || 0);
  loan.overdue = (loan.overdue || 0) - overduePart; loan.penaltyPaid += overduePart; remaining -= overduePart;
  if (loan.overdue === 0) loan.missed = 0;
  const principalPart = Math.min(remaining, loan.balance);
  loan.balance -= principalPart; remaining -= principalPart;
  const paid = overduePart + principalPart;
  if (loan.balance <= 0 && loan.overdue <= 0) {
    loan.balance = 0; loan.status = "closed"; loan.closedAt = now;
    loan.history.push({ type: "closed", text: `Досрочно погашен, внесено ${paid.toLocaleString("ru-RU")} ₽`, at: now });
  } else {
    const periodsLeft = Math.max(1, loan.periods - loan.paidPeriods);
    loan.payment = Math.ceil(annuityPayment(loan.balance, loan.rate, periodsLeft));
    loan.history.push({ type: "early", text: `Частичное погашение ${paid.toLocaleString("ru-RU")} ₽, новый платёж ${loan.payment.toLocaleString("ru-RU")} ₽`, at: now });
  }
  return { paid, overduePart, principalPart, closed: loan.status === "closed" };
}

function payoffAmount(loan) { return loan.balance + (loan.overdue || 0); }

// Налог с продажи автомобиля: платится только с прибыли, прогрессивная шкала, вычет за собственный шоурум,
// налоговые каникулы для первых сделок новичков.
function carSaleTax({ amount, invested, showroomBonus = 0, deals = 0, level = 1 }) {
  const profit = Math.max(0, round(amount) - round(invested));
  const holiday = level <= carTax.holidayMaxLevel && deals < carTax.holidayDeals;
  if (profit <= 0 || holiday) return { profit, tax: 0, rate: 0, holiday, holidayDealsLeft: holiday ? carTax.holidayDeals - deals : 0, deduction: 0 };
  const deduction = Math.min(carTax.baseRate - carTax.minRate, clamp(showroomBonus, 0, 0.15) * carTax.showroomDeductionFactor);
  const baseRate = carTax.baseRate - deduction;
  const highRate = carTax.highRate - deduction;
  const basePart = Math.min(profit, carTax.highThreshold);
  const highPart = Math.max(0, profit - carTax.highThreshold);
  const tax = round(basePart * baseRate + highPart * highRate);
  return { profit, tax, rate: Math.round(tax / profit * 10000) / 100, holiday: false, holidayDealsLeft: 0, deduction: Math.round(deduction * 10000) / 100 };
}

module.exports = {
  LOAN_PERIOD_MS, MAX_ACTIVE_LOANS, MISSED_BEFORE_COLLECTION, COLLECTION_PRICE_FACTOR, LATE_PENALTY_RATE, ISSUE_FEE_RATE, GARNISH_RATE, COLLECTION_COOLDOWN_MS,
  underwrite, principalForPayment, currentPayments, inCollection,
  loanProducts, carTax, creditRating, ratingLabel, creditLimit, activeDebt, hasOverdue, effectiveRate, annuityPayment, loanQuote, productAvailability,
  createLoan, scheduledDue, applyScheduledPayment, applyEarlyRepayment, payoffAmount, carSaleTax
};
