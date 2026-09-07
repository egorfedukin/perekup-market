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

// Short, deterministic interaction checks used by the client and validated by the server.
const miniGameRules = {
  engine: { steps: 3, targets: [62, 48, 55], tolerance: 12, defect: "engine" },
  chassis: { steps: 3, targets: [35, 72, 50], tolerance: 15, defect: "chassis" },
  body: { steps: 4, targets: [1, 3, 0, 2], tolerance: 0, defect: "body" },
  electronics: { steps: 3, targets: [2, 0, 3], tolerance: 0, defect: "electronics" }
};

function playInspectionMiniGame(category, attempts = [], seed = 0) {
  const rule = miniGameRules[category];
  if (!rule) throw new Error("Неизвестная мини-игра");
  const values = Array.isArray(attempts) ? attempts.slice(0, rule.steps) : [];
  const hits = values.reduce((sum, value, index) => {
    const expected = rule.targets[(index + Math.abs(Number(seed) || 0)) % rule.targets.length];
    return sum + (Math.abs(Number(value) - expected) <= rule.tolerance ? 1 : 0);
  }, 0);
  const score = Math.round(hits / rule.steps * 100);
  return { category, score, hits, steps: rule.steps, defect: rule.defect, depthBonus: score >= 80 ? 2 : score >= 50 ? 1 : 0, reliable: score >= 50 };
}

const buyerProfiles = {
  budget: { name: "Практичный покупатель", budget: 350000, interests: ["utility"], riskTolerance: 72, ageTolerance: 90 },
  family: { name: "Семья", budget: 1200000, interests: ["comfort", "utility"], riskTolerance: 35, ageTolerance: 65 },
  enthusiast: { name: "Автолюбитель", budget: 2500000, interests: ["sport", "classic"], riskTolerance: 70, ageTolerance: 55 },
  collector: { name: "Коллекционер", budget: 6000000, interests: ["classic"], riskTolerance: 20, ageTolerance: 25 }
};

function tuningImpact(upgrade, buyerKey = "budget") {
  const buyer = buyerProfiles[buyerKey] || buyerProfiles.budget;
  const fit = buyer.interests.includes(upgrade.profile) ? 1 : 0;
  const demand = fit ? 1.15 : 0.92;
  const risk = fit ? (upgrade.risk || 0) : (upgrade.risk || 0) + 3;
  return { demand, priceMultiplier: demand + (upgrade.value || 0) / 1000000, risk, suitable: Boolean(fit) };
}

const skillTree = {
  diagnostics: { name: "Диагностика", effects: ["+точность мини-игр", "+глубина осмотра"] },
  mechanics: { name: "Механика", effects: ["-стоимость ремонта", "+надёжность"] },
  negotiation: { name: "Переговоры", effects: ["+цена сделки", "меньше потерь репутации"] },
  tuning: { name: "Тюнинг", effects: ["больше спрос", "меньше риск несовместимости"] },
  propertyManagement: { name: "Управление объектами", effects: ["+доход недвижимости", "-расходы обслуживания"] }
};

function propertyRoi(property, upgradeLevel = 0, maintenance = 100) {
  const income = Math.max(0, Math.round((property.income || 0) * (1 + upgradeLevel * 0.08) * maintenance / 100));
  const upkeep = Math.round((property.price || property.basePrice || 0) * (0.00002 + upgradeLevel * 0.000004));
  const net = income - upkeep;
  return { income, upkeep, net, months: net > 0 ? Math.ceil((property.price || property.basePrice || 0) / net) : Infinity };
}

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

module.exports = { repairPlans, repairQuote, repairReliability, inspectionMethods, inspectionGames, inspectionQuote, careerProgress, miniGameRules, playInspectionMiniGame, buyerProfiles, tuningImpact, skillTree, propertyRoi };
