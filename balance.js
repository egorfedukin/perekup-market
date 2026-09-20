"use strict";
// Экономика «с нуля». Все стартовые пороги и скидочные кривые собраны в одном месте,
// чтобы баланс можно было перенастроить в одном файле и проверить тестами без сервера.
//
// Идея старта: 50 000 ₽, гараж из четырёх мест, ни одного дорогого инструмента.
// Игрок живёт на «стартовом сегменте» — дешёвые убитые машины, которые он сам
// находит, чинит своими руками и продаёт с наценкой 20-45%.

const STARTING_CASH = 50000;

// Стартовый сегмент рынка: сколько дешёвых лотов всегда должно быть в наличии и почём.
const STARTER = {
  lots: 18,               // гарантированное количество дешёвых объявлений у NPC
  maxPriceShare: 1.7,     // верхняя граница стартовой цены = 85 000 ₽
  valueMin: 32000,        // разброс «чистой» стоимости стартовых машин
  valueMax: 78000,
  repairFloor: 400,       // мелкие работы не опускаем ниже этого уровня
  salvageFloor: 5000      // минимальная цена битого стартового автомобиля
};

// Скидка новичка на услуги и инструменты: уровень 1 — 20% полной цены,
// к шестому уровню скидка полностью исчезает.
const LEVEL_FEE = { start: 0.2, step: 0.16, maxLevel: 6 };

// Награды за стартовые контракты так же масштабируются, иначе 42 000 ₽ в первую же
// минуту обесценивают весь путь «подъёма с нуля».
const CONTRACT_SHARE = { start: 0.18, step: 0.16, maxLevel: 6 };

function clamp(value, low, high) { return Math.min(high, Math.max(low, Number(value) || 0)); }
function round(value, step = 1000) { const size = Math.max(1, step); return Math.round((Number(value) || 0) / size) * size; }

function levelFeeScale(level) {
  const current = Math.max(1, Math.round(Number(level) || 1));
  if (current >= LEVEL_FEE.maxLevel) return 1;
  return clamp(LEVEL_FEE.start + LEVEL_FEE.step * (current - 1), LEVEL_FEE.start, 1);
}

function contractScale(level) {
  const current = Math.max(1, Math.round(Number(level) || 1));
  if (current >= CONTRACT_SHARE.maxLevel) return 1;
  return clamp(CONTRACT_SHARE.start + CONTRACT_SHARE.step * (current - 1), CONTRACT_SHARE.start, 1);
}

// Цена услуги с учётом льгот новичка: пошлины, диагностика, расширение гаража.
function fee(base, level, step = 100) { return Math.max(step, round(base * levelFeeScale(level), step)); }

// Награда контракта: на первом уровне это «деньги на первую машину», дальше — полный размер.
function contractReward(base, level) { return Math.max(500, round(base * contractScale(level), 500)); }

// Стартовый инструмент продаётся б/у — первую ступень оборудования сильно удешевляем.
function equipmentPrice(prices, level) {
  if (!Array.isArray(prices) || prices.length < 2) return 0;
  if (level >= CONTRACT_SHARE.maxLevel) return prices[1];
  return Math.max(500, round(prices[1] * clamp(0.35 + 0.13 * (Math.max(1, level) - 1), 0.35, 1), 500));
}

// Автомобиль «стартового сегмента»: дешёвый, с пропорционально дешёвыми ремонтами.
function isStarterCar(car) { return Boolean(car?.starter) || Number(car?.cleanValue || 0) <= STARTER.valueMax; }

function starterPriceBand() {
  return { min: STARTER.salvageFloor, max: Math.round(STARTING_CASH * STARTER.maxPriceShare / 1000) * 1000 };
}

// Масштаб дефектов для дешёвых машин. Работы дорожают быстрее, чем теряется стоимость:
// на убитой «копейке» мелкий ремонт — это заметные деньги, а не бесплатная печать прибыли.
function defectScales(cleanValue) {
  const ratio = clamp((Number(cleanValue) || 0) / 900000, 0.05, 1);
  const curve = Math.pow(ratio, 0.75);
  return {
    repair: clamp(curve * 1.35, 0.14, 1),
    impact: clamp(curve, 0.08, 1)
  };
}

// Полная диагностика в сервисе: для стартовых машин считаем от стоимости, а не от 5 000 ₽.
function serviceDiagnosticBase(car) {
  return isStarterCar(car) ? 900 : 5000;
}

// Осмотр «под нагрузкой» и инструментальный: 3 500 ₽ и 9 000 ₽ на машине за 60 000 ₽
// съедали всю маржу, поэтому для дешёвых лотов применяем понижающий коэффициент.
function inspectionScale(car) {
  if (!isStarterCar(car)) return 1;
  return clamp(0.12 + (Number(car?.cleanValue) || 0) / STARTER.valueMax * 0.25, 0.12, 0.4);
}

// Тюнинг для дешёвых машин стоит и даёт пропорционально меньше: иначе «большое ТО»
// за 34 000 ₽ на машине за 40 000 ₽ не имеет смысла.
function upgradeScale(car) {
  const cleanValue = Number(car?.cleanValue) || Number(car?.price) || 0;
  return clamp(Math.pow(clamp(cleanValue / 900000, 0.02, 1), 0.72), 0.16, 1);
}

// Расширение гаража: на старте второе место должно быть достижимой целью, а не «копил полгода».
function garageExpandPrice(capacity, level) {
  const base = 140000 + (Math.max(4, Number(capacity) || 4) - 4) * 65000;
  return Math.max(5000, round(base * clamp(0.25 + 0.15 * (Math.max(1, level) - 1), 0.25, 1), 1000));
}

module.exports = {
  STARTING_CASH, STARTER, LEVEL_FEE, CONTRACT_SHARE,
  isStarterCar, starterPriceBand, defectScales, serviceDiagnosticBase, inspectionScale,
  levelFeeScale, fee, contractReward, contractScale, equipmentPrice, garageExpandPrice, upgradeScale
};
