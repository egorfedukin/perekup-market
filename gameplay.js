"use strict";

const repairPlans = {
  budget: { name: "Бюджетный ремонт", laborFactor: 0.75, quality: "economy", reliability: 72, warranty: 0 },
  standard: { name: "Стандартный ремонт", laborFactor: 1, quality: "analog", reliability: 88, warranty: 3 },
  restoration: { name: "Восстановление", laborFactor: 1.4, quality: "original", reliability: 99, warranty: 7 }
};

function repairQuote({ labor, partPrice = 0, plan = "standard", discount = 0 }) {
  const specification = repairPlans[plan];
  if (!specification) throw new Error("Неизвестный план ремонта");
  const work = Math.max(500, Math.round(labor * specification.laborFactor * (1 - discount) / 500) * 500);
  return { ...specification, key: plan, labor: work, partPrice, total: work + partPrice };
}

function repairReliability(plan, part, condition = 100) {
  return Math.max(1, Math.min(repairPlans[plan].reliability, Math.round(part * condition / 100)));
}

const inspectionMethods = {
  visual: { name: "Первичный осмотр", cost: 0, depth: 1 },
  targeted: { name: "Проверка под нагрузкой", cost: 3500, depth: 2 },
  instrumental: { name: "Инструментальная проверка", cost: 9000, depth: 4 }
};

const inspectionGames = {
  engine: { name: "Холодный запуск", prompt: "Удержите обороты в зелёной зоне", success: "Состояние двигателя" },
  chassis: { name: "Тест-драйв", prompt: "Поймайте момент торможения без увода", success: "Подвеска и тормоза" },
  body: { name: "Осмотр кузова", prompt: "Найдите деталь с другим оттенком", success: "Следы ремонта кузова" },
  electronics: { name: "Диагностический прибор", prompt: "Выберите подозрительный показатель", success: "Электрика и блоки" }
};

function inspectionQuote(method, skill, equipment) {
  if (!Object.hasOwn(inspectionMethods, method)) throw new Error("Неизвестный метод осмотра");
  const option = inspectionMethods[method];
  const depth = Math.min(8, skill + equipment + option.depth);
  return { ...option, key: method, depth, confidence: Math.min(100, Math.round(depth / 6 * 100)) };
}

function careerProgress(player) {
  const stages = [
    { name: "Новичок", deals: 0, profit: 0, reputation: 0 },
    { name: "Гаражный мастер", deals: 5, profit: 150000, reputation: 50 },
    { name: "Дилер", deals: 20, profit: 1000000, reputation: 65 },
    { name: "Автосалон", deals: 50, profit: 5000000, reputation: 80 }
  ];
  const metrics = { deals: player.deals || 0, profit: player.profit || 0, reputation: player.reputation?.score || 0 };
  let index = 0;
  while (index + 1 < stages.length && Object.keys(metrics).every((key) => metrics[key] >= stages[index + 1][key])) index++;
  const next = stages[index + 1];
  return { stage: stages[index].name, next: next?.name || null, goals: next ? Object.entries(metrics).map(([key, value]) => ({ key, current: value, target: next[key], percent: Math.max(0, Math.min(100, Math.floor(value / next[key] * 100))) })) : [] };
}

module.exports = { repairPlans, repairQuote, repairReliability, inspectionMethods, inspectionGames, inspectionQuote, careerProgress };
