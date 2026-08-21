const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, "public");
const STARTING_CASH = 650000;
const MAX_GARAGE = 4;
const GARAGE_CAPACITY_MAX = 10;
const BOT_BID_CHANCE = process.env.PEREKUP_BOT_ALWAYS === "1" ? 1 : 0.48;
const NPC_ROTATION_MS = Math.max(60000, Number(process.env.PEREKUP_ROTATION_MS) || 180000);
const NPC_ROTATION_COUNT = 10;
const ADMIN_NAMES = new Set(String(process.env.PEREKUP_ADMIN_NAMES || "Егор пк").split(",").map((name) => name.trim().toLocaleLowerCase("ru-RU")).filter(Boolean));
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const PUBLIC_URL = String(process.env.PEREKUP_PUBLIC_URL || "https://perekup-market-production.up.railway.app").replace(/\/$/, "");
const cashPackages = [
  { id: "starter", rubles: 59, cash: 75000, name: "Быстрый старт" },
  { id: "dealer", rubles: 149, cash: 220000, name: "Капитал дилера" },
  { id: "business", rubles: 299, cash: 500000, name: "Развитие бизнеса" }
];
const DATA_DIR = process.env.PEREKUP_DATA_DIR ? path.resolve(process.env.PEREKUP_DATA_DIR) : path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "game.db"));
db.exec("CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");

const featuredCatalog = [
  { model: "Volna 2107", year: 2008, base: 165000, className: "classic", color: "#d8aa43" },
  { model: "Sfera City", year: 2013, base: 390000, className: "hatch", color: "#d14d3f" },
  { model: "Kvant S2", year: 2016, base: 610000, className: "sedan", color: "#386c8e" },
  { model: "Taiga Cross", year: 2015, base: 720000, className: "suv", color: "#4f7651" },
  { model: "Meteor GT", year: 2011, base: 540000, className: "coupe", color: "#e27036" },
  { model: "Sever Van", year: 2017, base: 880000, className: "van", color: "#717b86" },
  { model: "Iskra E", year: 2020, base: 1250000, className: "electric", color: "#4d73bb" },
  { model: "Berkut X", year: 2018, base: 1480000, className: "premium", color: "#24282d" },
  { model: "Ladoga Wagon", year: 2014, base: 570000, className: "wagon", color: "#627b70" },
  { model: "Ruta Compact", year: 2018, base: 740000, className: "hatch", color: "#c94355" },
  { model: "Granit 4x4", year: 2012, base: 690000, className: "suv", color: "#77745d" },
  { model: "Strela R", year: 2019, base: 1320000, className: "roadster", color: "#ca3e32" },
  { model: "Orbit Family", year: 2017, base: 830000, className: "wagon", color: "#4c6683" },
  { model: "Yar Pickup", year: 2016, base: 1080000, className: "pickup", color: "#82634a" },
  { model: "Neva Business", year: 2020, base: 1520000, className: "sedan", color: "#3e4858" },
  { model: "Sokol RS", year: 2015, base: 970000, className: "coupe", color: "#d25b2f" },
  { model: "Polar Mini", year: 2021, base: 990000, className: "hatch", color: "#65a2ab" },
  { model: "Atlas Tour", year: 2022, base: 1960000, className: "suv", color: "#315a4a" },
  { model: "Vector EV", year: 2023, base: 2240000, className: "electric", color: "#537dc5" },
  { model: "Tornado Cabrio", year: 2016, base: 1190000, className: "roadster", color: "#e1a52d" },
  { model: "Master Cargo", year: 2019, base: 1380000, className: "van", color: "#e2e0d5" },
  { model: "Status L", year: 2021, base: 2780000, className: "premium", color: "#29252e" },
  { model: "Sputnik Classic", year: 1998, base: 130000, className: "classic", color: "#9aaf9a" },
  { model: "Prizma Liftback", year: 2020, base: 1270000, className: "sedan", color: "#704f78" }
];

const generatedMakes = ["Astra", "Borey", "Cobalt", "Dvina", "Elbrus", "Fakel", "Gorizont", "Helios", "Irtysh", "Jupiter", "Karelia", "Luch", "Magistral", "Nord", "Onega", "Progress", "Rubin", "Sirius", "Titan", "Ural", "Vega", "Yantar", "Zenit", "Avangard", "Baltika", "Cascade", "Diamant", "Express", "Favorit", "Grand", "Impulse", "Krepost"];
const generatedSeries = ["10", "20", "30", "40", "50", "60", "70", "80", "90", "100", "City", "Tour", "Cross", "Sport", "Family", "Cargo", "Classic", "Prime", "GT", "RS", "EV", "X", "S", "L", "Pro", "Max", "Mini", "Coupe", "Wagon", "Road", "Ultra"];
const generatedClasses = ["classic", "hatch", "sedan", "suv", "coupe", "van", "electric", "premium", "wagon", "pickup", "roadster"];
const generatedColors = ["#b9473d", "#35698c", "#4e7652", "#d39232", "#555f6d", "#292b30", "#7b4e78", "#6999a4", "#806247", "#8d927e"];
const generatedCatalog = [];
for (let makeIndex = 0; makeIndex < generatedMakes.length; makeIndex += 1) {
  for (let seriesIndex = 0; seriesIndex < generatedSeries.length; seriesIndex += 1) {
    const index = makeIndex * generatedSeries.length + seriesIndex;
    const priceProgress = index / (1000 - featuredCatalog.length - 1);
    const base = Math.round((10000 * Math.pow(10000, priceProgress)) / 1000) * 1000;
    generatedCatalog.push({
      model: `${generatedMakes[makeIndex]} ${generatedSeries[seriesIndex]}`,
      year: 1985 + ((index * 7) % 42), base: Math.max(10000, Math.min(100000000, base)),
      className: generatedClasses[index % generatedClasses.length], color: generatedColors[(index * 3) % generatedColors.length]
    });
  }
}
const catalog = [...featuredCatalog, ...generatedCatalog.slice(0, 1000 - featuredCatalog.length)];

const defectCatalog = [
  { code: "oil_low", category: "engine", name: "Критически низкий уровень моторного масла", symptom: "Щуп показывает уровень ниже минимума, масло потемнело.", consequence: "Ускоренный износ двигателя и риск масляного голодания.", severity: 2, skill: 1, equipment: "tools", equipmentLevel: 1, repair: 6500, impact: 18000, partName: "Моторное масло 5W-30" },
  { code: "timing_belt", category: "engine", name: "Трещины на ремне ГРМ", symptom: "Микротрещины на рабочей поверхности ремня, срок замены просрочен.", consequence: "Обрыв ремня загнёт клапаны и остановит двигатель.", severity: 3, skill: 2, equipment: "tools", equipmentLevel: 2, repair: 42000, impact: 76000, partName: "Комплект ремня ГРМ" },
  { code: "oil_leak", category: "engine", name: "Течь масла из-под клапанной крышки", symptom: "Масляный налёт на верхней части двигателя и запах после поездки.", consequence: "Падение уровня масла и риск масляного голодания.", severity: 2, skill: 1, equipment: "tools", equipmentLevel: 1, repair: 26000, impact: 47000 },
  { code: "compression", category: "engine", name: "Низкая компрессия во втором цилиндре", symptom: "Неровный холодный запуск, лёгкая вибрация на холостом ходу.", consequence: "Рост расхода масла и капитальный ремонт двигателя.", severity: 3, skill: 3, equipment: "tools", equipmentLevel: 3, repair: 118000, impact: 165000 },
  { code: "timing", category: "engine", name: "Растянута цепь ГРМ", symptom: "Короткий металлический треск при запуске.", consequence: "Перескок цепи может повредить клапаны.", severity: 3, skill: 2, equipment: "scanner", equipmentLevel: 2, repair: 68000, impact: 97000 },
  { code: "clutch", category: "chassis", name: "Изношено сцепление", symptom: "Обороты растут быстрее скорости при резком разгоне.", consequence: "Машина перестанет передавать тягу на колёса.", severity: 3, skill: 2, equipment: "lift", equipmentLevel: 1, repair: 47000, impact: 74000 },
  { code: "bearing", category: "chassis", name: "Люфт передней ступицы", symptom: "Гул усиливается в правом повороте.", consequence: "Ускоренный износ покрышки и риск разрушения подшипника.", severity: 2, skill: 1, equipment: "lift", equipmentLevel: 1, repair: 17000, impact: 29000 },
  { code: "rack", category: "chassis", name: "Люфт рулевой рейки", symptom: "Стук на мелких неровностях и пустая зона руля.", consequence: "Ухудшение управляемости и дорогой ремонт рейки.", severity: 3, skill: 3, equipment: "lift", equipmentLevel: 2, repair: 62000, impact: 94000 },
  { code: "brakes", category: "chassis", name: "Предельный износ тормозных дисков", symptom: "Биение педали при торможении со скорости.", consequence: "Увеличенный тормозной путь и перегрев.", severity: 3, skill: 1, equipment: "tools", equipmentLevel: 1, repair: 24000, impact: 42000 },
  { code: "paint", category: "body", name: "Вторичный окрас левого крыла", symptom: "Толщина покрытия отличается от соседних деталей.", consequence: "Снижает ликвидность, возможна скрытая коррозия.", severity: 1, skill: 1, equipment: "gauge", equipmentLevel: 1, repair: 23000, impact: 37000 },
  { code: "frame", category: "body", name: "Следы ремонта переднего лонжерона", symptom: "Неровный герметик и нарушенная геометрия контрольных точек.", consequence: "Автомобиль хуже держит удар и быстрее изнашивает резину.", severity: 3, skill: 3, equipment: "gauge", equipmentLevel: 3, repair: 135000, impact: 210000 },
  { code: "rust", category: "body", name: "Коррозия порогов под накладками", symptom: "Вздутие краски у задних колёсных арок.", consequence: "Потребуется сварка и полный окрас порогов.", severity: 2, skill: 2, equipment: "lift", equipmentLevel: 2, repair: 59000, impact: 88000 },
  { code: "airbag", category: "electrics", name: "Эмулятор подушки безопасности", symptom: "Индикатор SRS гаснет одновременно с другими лампами.", consequence: "Подушка не сработает при столкновении.", severity: 3, skill: 3, equipment: "scanner", equipmentLevel: 3, repair: 76000, impact: 126000 },
  { code: "generator", category: "electrics", name: "Нестабильная зарядка генератора", symptom: "Напряжение проседает при включении обогрева.", consequence: "Разряд аккумулятора и остановка двигателя.", severity: 2, skill: 1, equipment: "scanner", equipmentLevel: 1, repair: 21000, impact: 35000 },
  { code: "turn_signal", category: "electrics", name: "Не работает левый передний поворотник", symptom: "Лампа не включается, в корпусе следы влаги.", consequence: "Автомобиль не подаёт сигнал манёвра и может не пройти техосмотр.", severity: 1, skill: 1, equipment: "electricalBench", equipmentLevel: 1, repair: 4500, impact: 9000, partName: "Лампа поворотника" },
  { code: "can_bus", category: "electrics", name: "Плавающие ошибки CAN-шины", symptom: "Периодически пропадает связь с блоком комфорта.", consequence: "Непредсказуемые отказы электрооборудования.", severity: 2, skill: 2, equipment: "scanner", equipmentLevel: 2, repair: 39000, impact: 66000 },
  { code: "coolant", category: "engine", name: "Микротрещина рубашки охлаждения", symptom: "Следы антифриза видны эндоскопом за выпускным коллектором.", consequence: "Перегрев двигателя и деформация головки блока.", severity: 3, skill: 3, equipment: "endoscope", equipmentLevel: 2, repair: 89000, impact: 138000 },
  { code: "wiring", category: "electrics", name: "Повреждение жгута проводки", symptom: "Сопротивление цепи меняется при движении жгута.", consequence: "Короткое замыкание и отказ нескольких систем.", severity: 3, skill: 2, equipment: "multimeter", equipmentLevel: 2, repair: 54000, impact: 86000 },
  { code: "uneven_tires", category: "tires", name: "Неравномерный износ комплекта шин", symptom: "Разница глубины протектора по внутренней и внешней кромке.", consequence: "Плохое сцепление и возможное нарушение геометрии подвески.", severity: 2, skill: 1, equipment: "treadGauge", equipmentLevel: 1, repair: 36000, impact: 49000 },
  { code: "old_tires", category: "tires", name: "Возрастные трещины боковин", symptom: "Маркировка даты выпуска старше восьми лет, резина задубела.", consequence: "Риск разрыва шины на высокой скорости.", severity: 3, skill: 2, equipment: "treadGauge", equipmentLevel: 2, repair: 48000, impact: 65000 },
  { code: "puncture", category: "tires", name: "Прокол правого переднего колеса", symptom: "Медленная потеря давления после стоянки.", consequence: "Разрушение боковины и потеря управления.", severity: 1, skill: 1, equipment: "treadGauge", equipmentLevel: 1, repair: 3500, impact: 8000, partName: "Ремкомплект бескамерной шины" },
  { code: "mileage", category: "documents", name: "Скрученный пробег", symptom: "Пробег в блоке ABS выше показаний приборной панели.", consequence: "Реальный износ автомобиля значительно выше заявленного.", severity: 2, skill: 2, equipment: "vinScanner", equipmentLevel: 2, repair: 15000, impact: 92000 },
  { code: "vin", category: "documents", name: "Следы вмешательства в маркировку VIN", symptom: "Шрифт и глубина символов отличаются от заводского образца.", consequence: "Отказ в регистрации и риск изъятия автомобиля.", severity: 3, skill: 3, equipment: "vinScanner", equipmentLevel: 3, repair: 180000, impact: 310000 }
];

const skillInfo = {
  diagnostics: { name: "Диагност", description: "Двигатель, подвеска и поиск скрытых симптомов", maxLevel: 5 },
  mechanics: { name: "Механик", description: "Ремонт двигателя, ходовой и колёс", maxLevel: 5 },
  electrics: { name: "Автоэлектрик", description: "Диагностика и ремонт электрооборудования", maxLevel: 5 },
  bodywork: { name: "Кузовной мастер", description: "Осмотр геометрии, сварка и окраска", maxLevel: 5 },
  appraisal: { name: "Оценщик", description: "VIN, история, пробег и рыночная стоимость", maxLevel: 5 }
};

const equipmentInfo = {
  diagnosticKit: { name: "Диагностический комплекс", description: "Сканер, эндоскоп и измерительные приборы", prices: [0, 28000, 82000, 175000] },
  workshop: { name: "Механическая мастерская", description: "Подъёмник, инструмент и динамоключ", prices: [0, 42000, 128000, 265000] },
  electricalBench: { name: "Стенд автоэлектрика", description: "Мультиметр, осциллограф и ремонт проводки", prices: [0, 22000, 68000, 145000] },
  bodyStation: { name: "Кузовная станция", description: "Толщиномер, сварка и покрасочное оборудование", prices: [0, 48000, 145000, 295000] },
  historyTerminal: { name: "Терминал истории", description: "VIN-базы, архивы пробегов и экспертиза документов", prices: [0, 18000, 56000, 120000] }
};

const inspectionRequirements = {
  engine: { skill: "diagnostics", equipment: "diagnosticKit" },
  chassis: { skill: "diagnostics", equipment: "workshop" },
  body: { skill: "bodywork", equipment: "bodyStation" },
  electrics: { skill: "electrics", equipment: "electricalBench" },
  tires: { skill: "mechanics", equipment: "workshop" },
  documents: { skill: "appraisal", equipment: "historyTerminal" }
};

const bots = [
  { id: "bot_igor", name: "Игорь с сервиса", type: "specialist", skill: 5, risk: 0.94, budget: 1150000, repairPremium: 0.07 },
  { id: "bot_marina", name: "Марина Автоподбор", type: "endBuyer", skill: 4, risk: 1.03, budget: 2100000, repairPremium: 0.13 },
  { id: "bot_timur", name: "Тимур, первая машина", type: "budget", skill: 2, risk: 0.97, budget: 720000, repairPremium: 0.08 },
  { id: "bot_dealer", name: "Автосалон Север", type: "dealer", skill: 4, risk: 0.87, budget: 2900000, repairPremium: 0.03 },
  { id: "bot_collector", name: "Клуб Старый гараж", type: "collector", skill: 3, risk: 1.08, budget: 1600000, repairPremium: 0.16 },
  { id: "bot_family", name: "Семья Орловых", type: "endBuyer", skill: 3, risk: 1.01, budget: 1450000, repairPremium: 0.12 },
  { id: "bot_invest", name: "ИнвестАвто", type: "dealer", skill: 5, risk: 0.93, budget: 18000000, repairPremium: 0.08 },
  { id: "bot_lux", name: "Премиум Коллекшн", type: "collector", skill: 5, risk: 1.06, budget: 120000000, repairPremium: 0.18 }
];

const partComponents = {
  engine: "Двигатель и навесное", chassis: "Ходовая и трансмиссия", body: "Кузовная деталь",
  electrics: "Электрооборудование", tires: "Колёса и шины", universal: "Расходные материалы"
};

const upgradeCatalog = [
  { key: "detailing", name: "Профессиональный детейлинг", description: "Глубокая очистка салона, полировка кузова и фото-подготовка.", skill: "bodywork", equipment: "bodyStation", skillLevel: 1, equipmentLevel: 1, cost: 22000, value: 36000, condition: 4 },
  { key: "maintenance", name: "Большое ТО", description: "Масла, фильтры и регламентные расходники с записью в историю.", skill: "mechanics", equipment: "workshop", skillLevel: 1, equipmentLevel: 1, cost: 34000, value: 52000, condition: 6 },
  { key: "suspension", name: "Настройка ходовой", description: "Развал-схождение и настройка подвески для уверенного хода.", skill: "mechanics", equipment: "workshop", skillLevel: 2, equipmentLevel: 2, cost: 76000, value: 112000, condition: 8 },
  { key: "electronics", name: "Профилактика электроники", description: "Проверка блоков, контактов и обновление сервисной истории.", skill: "electrics", equipment: "electricalBench", skillLevel: 2, equipmentLevel: 2, cost: 68000, value: 104000, condition: 5 },
  { key: "restoration", name: "Предпродажная реставрация", description: "Комплексная подготовка редкого автомобиля с подтверждёнными работами.", skill: "appraisal", equipment: "bodyStation", skillLevel: 3, equipmentLevel: 3, cost: 165000, value: 255000, condition: 10 }
];

const employeeCandidates = [
  { id: "employee_diagnostic_1", name: "Антон Лебедев", specialty: "diagnostics", title: "Диагност", rating: 72, hireCost: 65000 },
  { id: "employee_diagnostic_2", name: "Ольга Романова", specialty: "diagnostics", title: "Старший диагност", rating: 91, hireCost: 145000 },
  { id: "employee_mechanic_1", name: "Михаил Орлов", specialty: "mechanics", title: "Механик", rating: 76, hireCost: 78000 },
  { id: "employee_mechanic_2", name: "Рустам Саидов", specialty: "mechanics", title: "Мастер цеха", rating: 94, hireCost: 168000 },
  { id: "employee_appraiser", name: "Елена Волкова", specialty: "appraisal", title: "Оценщик", rating: 86, hireCost: 112000 },
  { id: "employee_manager", name: "Павел Серов", specialty: "sales", title: "Менеджер продаж", rating: 88, hireCost: 128000 }
];

const players = new Map();
const sessions = new Map();
const market = [];
const salesHistory = [];
const marketIndices = {};
const offers = new Map();
const chatMessages = [];
const groups = new Map();
const partsMarket = [];
const partsSalesHistory = [];
const partIndices = {};
const paymentOrders = new Map();
const containerAuctions = [];
const containerTiers = {
  cheap: { name: "Гаражная находка", minValue: 10000, maxValue: 650000, startMin: 5000, startMax: 90000, color: "#677568" },
  middle: { name: "Дилерский склад", minValue: 500000, maxValue: 8000000, startMin: 180000, startMax: 1200000, color: "#b07a2e" },
  premium: { name: "Коллекционный бокс", minValue: 6000000, maxValue: 100000000, startMin: 1500000, startMax: 15000000, color: "#8b3d35" }
};
const clients = new Set();
let revision = 0;
let marketRotationNextAt = Date.now() + NPC_ROTATION_MS;

function persistState() {
  const payload = JSON.stringify({
    players: [...players.entries()], sessions: [...sessions.entries()], market,
    offers: [...offers.entries()], salesHistory, marketIndices, chatMessages, groups: [...groups.entries()], partsMarket, partsSalesHistory, partIndices, paymentOrders: [...paymentOrders.entries()], containerAuctions
  });
  db.prepare("INSERT INTO game_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(payload, Date.now());
}

function loadState() {
  const row = db.prepare("SELECT payload FROM game_state WHERE id = 1").get();
  if (!row) return false;
  try {
    const saved = JSON.parse(row.payload);
    for (const [key, value] of saved.players || []) { ensurePlayerDefaults(value); players.set(key, value); }
    for (const [key, value] of saved.sessions || []) sessions.set(key, value);
    for (const car of saved.market || []) { ensureCarDefaults(car); market.push(car); }
    for (const [key, value] of saved.offers || []) offers.set(key, value);
    for (const sale of saved.salesHistory || []) salesHistory.push(sale);
    Object.assign(marketIndices, saved.marketIndices || {});
    chatMessages.push(...(saved.chatMessages || []).slice(-100));
    for (const [key, value] of saved.groups || []) { ensureGroupDefaults(value); groups.set(key, value); }
    partsMarket.push(...(saved.partsMarket || []).map(ensurePartLot));
    partsSalesHistory.push(...(saved.partsSalesHistory || []).slice(-500));
    Object.assign(partIndices, saved.partIndices || {});
    for (const [key, value] of saved.paymentOrders || []) paymentOrders.set(key, value);
    containerAuctions.push(...(saved.containerAuctions || []));
    return market.length > 0;
  } catch (error) {
    console.error("Failed to load saved game:", error.message);
    return false;
  }
}

function ensurePlayerDefaults(player) {
  player.skills ||= {};
  player.equipment ||= {};
  player.skills.diagnostics ??= Math.max(player.skills.engine || 0, player.skills.chassis || 0);
  player.skills.mechanics ??= Math.max(player.skills.mechanic || 0, player.skills.tires || 0);
  player.skills.bodywork ??= Math.max(player.skills.body || 0, player.skills.bodyRepair || 0);
  player.skills.appraisal ??= player.skills.documents || 0;
  player.skills.electrics ??= player.skills.electrician || 0;
  player.equipment.diagnosticKit ??= Math.max(player.equipment.scanner || 0, player.equipment.endoscope || 0, player.equipment.tools || 0);
  player.equipment.workshop ??= Math.max(player.equipment.lift || 0, player.equipment.torque || 0, player.equipment.tools || 0);
  player.equipment.electricalBench ??= Math.max(player.equipment.multimeter || 0, player.equipment.scanner || 0);
  player.equipment.bodyStation ??= Math.max(player.equipment.gauge || 0, player.equipment.welder || 0);
  player.equipment.historyTerminal ??= player.equipment.vinScanner || 0;
  for (const key of Object.keys(skillInfo)) player.skills[key] ??= 0;
  for (const key of Object.keys(equipmentInfo)) player.equipment[key] ??= 0;
  player.stats ||= { purchases: 0, inspections: 0, serviceDiagnostics: 0, selfRepairs: 0, assistedRepairs: 0, workshopRepairs: 0, auctionsWon: 0, bids: 0, partsSold: 0, partsBought: 0, upgrades: 0 };
  for (const key of ["purchases", "inspections", "serviceDiagnostics", "selfRepairs", "assistedRepairs", "workshopRepairs", "auctionsWon", "bids", "partsSold", "partsBought", "upgrades"]) player.stats[key] ??= 0;
  player.chatState ||= { sentAt: [], lastNormalized: "", lastDuplicateAt: 0, violations: 0, mutedUntil: 0 };
  player.reputation ||= { score: 50, completed: 0, failed: 0 };
  player.garageCapacity = Math.max(MAX_GARAGE, Math.min(GARAGE_CAPACITY_MAX, Number(player.garageCapacity) || MAX_GARAGE));
  player.parts ||= { common: 0, premium: 0 };
  player.partInventory ||= [];
  player.partInventory.forEach((part, index) => migratePart(part, index));
  player.groupId ??= null;
  player.groupRole ??= null;
  player.contracts ||= [];
  player.purchasedCash ||= 0;
  player.adminNotes ||= [];
  player.training ||= { lastAt: 0, completed: 0 };
  player.containerRewards ||= [];
  player.notifications ||= [];
  if (!player.contracts.length) player.contracts = generateContracts(player);
  player.garage ||= [];
  for (const car of player.garage) ensureCarDefaults(car);
}

function isAdmin(player) {
  return Boolean(player && ADMIN_NAMES.has(String(player.normalizedName || player.name).toLocaleLowerCase("ru-RU")));
}

function ensureCarDefaults(car) {
  car.discovered ||= [];
  car.repairs ||= [];
  car.checkedCategories ||= [];
  car.inspectionRecords ||= {};
  for (const category of car.checkedCategories) {
    car.inspectionRecords[category] ||= { bestScore: 1, attempts: 1, confidence: 15, foundCodes: [] };
  }
  for (const [category, record] of Object.entries(car.inspectionRecords)) {
    record.bestScore ??= 0;
    record.attempts ??= 1;
    record.confidence ??= Math.min(100, Math.round(record.bestScore / 8 * 100));
    record.foundCodes ||= car.discovered.filter((code) => car.defects.some((defect) => defect.code === code && defect.category === category));
  }
  car.checkedCategories = Object.keys(car.inspectionRecords);
  car.serviceDiagnosed ??= false;
  car.history ||= [{ type: "acquired", text: "Автомобиль поступил на рынок", at: Date.now() }];
  car.installedParts ||= [];
  car.upgrades ||= [];
  car.upgradeValue ||= 0;
  car.upgradeStage ||= car.upgrades.length;
  car.listedAt ||= car.history?.find((entry) => entry.type === "listed")?.at || Date.now();
  car.marketTag ??= null;
  car.participantIds ||= [];
  car.publicDiscovered ||= [];
  car.publicInspectionRecords ||= {};
}

function notifyOutbid(playerId, lotType, lotName, amount, lotId) {
  const player = players.get(playerId);
  if (!player) return;
  player.notifications ||= [];
  player.notifications.push({
    id: id("notification_"), type: "outbid", title: "Ваша ставка перебита",
    text: `${lotType === "container" ? "Контейнер" : "Автомобиль"} «${lotName}»: новая ставка ${amount.toLocaleString("ru-RU")} ₽`,
    lotType, lotId, amount, createdAt: Date.now(), read: false
  });
  player.notifications = player.notifications.slice(-50);
}

function migratePart(part, index = 0) {
  if (!part || typeof part !== "object") return part;
  if (part.component === "universal") part.component = ["engine", "chassis", "body", "electrics", "tires"][index % 5];
  part.compatibleModel ??= "all";
  if (!part.name || /универсал|расходные/i.test(part.name)) {
    const names = { engine: "Масло и ремкомплект двигателя", chassis: "Комплект ходовой", body: "Кузовная деталь", electrics: "Электрический разъём и лампы", tires: "Шинный ремкомплект" };
    part.name = names[part.component] || "Автомобильная деталь";
  }
  return part;
}

function ensureGroupDefaults(group) {
  group.treasury = Math.max(0, Number(group.treasury) || 0);
  group.rating = Math.max(0, Math.min(100, Number(group.rating) || 50));
  group.members ||= [];
  group.roles ||= {};
  group.garage ||= [];
  group.garageCapacity ||= 6;
  group.employees ||= [];
  group.log ||= [];
  for (const car of group.garage) ensureCarDefaults(car);
  return group;
}

function makePart(component = "universal", quality = "analog", conditionPct = 100, compatibleClass = "all", sourceCar = null) {
  const qualityFactor = quality === "original" ? 1.35 : quality === "restored" ? 0.72 : 1;
  const base = component === "engine" ? 65000 : component === "chassis" ? 38000 : component === "body" ? 32000 : component === "electrics" ? 27000 : component === "tires" ? 24000 : 12000;
  const compatibleModel = sourceCar && sourceCar !== "all" ? sourceCar : "all";
  const componentName = partComponents[component] || partComponents.universal;
  const specificNames = {
    engine: ["Моторное масло 5W-30", "Комплект ремня ГРМ", "Прокладка клапанной крышки"],
    chassis: ["Комплект сцепления", "Ступичный подшипник", "Втулки стабилизатора"],
    body: ["Кузовная панель", "Грунт и эмаль", "Комплект уплотнителей"],
    electrics: ["Лампа поворотника", "Датчик ABS", "Электрический разъём"],
    tires: ["Ремкомплект бескамерной шины", "Комплект вентилей", "Балансировочные грузики"]
  };
  const specificName = specificNames[component]?.[Math.floor(Math.random() * specificNames[component].length)] || componentName;
  return {
    id: `inventory_part_${crypto.randomBytes(7).toString("hex")}`, component,
    name: `${specificName}${compatibleModel !== "all" ? ` · ${compatibleModel}` : ""}`,
    quality, conditionPct: Math.max(20, Math.min(100, Math.round(conditionPct))), compatibleClass, compatibleModel,
    estimatedValue: Math.max(1000, Math.round(base * qualityFactor * conditionPct / 100 / 500) * 500), sourceCar
  };
}

function partStockType(part) {
  return part.quality === "original" ? "premium" : "common";
}

function makeSpecificPart(car, defect, quality = "analog") {
  const part = makePart(defect.category, quality, 100, car.className, car.model);
  part.name = `${defect.partName || partComponents[defect.category] || "Деталь"} · ${car.model}`;
  part.estimatedValue = Math.max(1000, Math.round(defect.repair * (quality === "original" ? 0.48 : 0.3) / 500) * 500);
  return part;
}

function ensurePartLot(lot) {
  if (!lot.item) {
    const quality = lot.type === "premium" ? "original" : lot.condition === "used" ? "restored" : "analog";
    lot.item = makePart(["engine", "chassis", "body", "electrics", "tires"][Math.abs(String(lot.id || "lot").length) % 5], quality, lot.condition === "used" ? 68 : 100, "all");
  }
  migratePart(lot.item);
  lot.item.compatibleModel ??= "all";
  lot.item.name ||= `${partComponents[lot.item.component] || partComponents.universal}${lot.item.compatibleModel !== "all" ? ` · ${lot.item.compatibleModel}` : ""}`;
  lot.sellerId ??= null;
  lot.createdAt ||= Date.now();
  return lot;
}

function generateContracts() {
  const models = catalog.slice().sort(() => Math.random() - 0.5);
  const contractId = () => `contract_${crypto.randomBytes(7).toString("hex")}`;
  return [
    { id: contractId(), title: "Быстрый оборот", description: `Купите и продайте ${models[0].model} с прибылью`, kind: "profit", model: models[0].model, reward: 42000, expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Честный подбор", description: `Продайте ${models[1].model} без скрытых проблем в описании`, kind: "honest", model: models[1].model, reward: 36000, expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Сервисная история", description: "Продайте диагностированную и отремонтированную машину", kind: "restored", reward: 58000, expiresAt: Date.now() + 7 * 86400000, status: "active" }
  ];
}

function inspectionCategories() {
  return Object.keys(inspectionRequirements);
}

const id = (prefix = "") => prefix + crypto.randomBytes(7).toString("hex");
const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function xpForLevel(level) {
  if (level <= 1) return 0;
  let total = 0;
  for (let current = 1; current < level; current += 1) total += 120 + current * 75;
  return total;
}

function levelForXp(xp) {
  let level = 1;
  while (level < 30 && xp >= xpForLevel(level + 1)) level += 1;
  return level;
}

function addXp(player, amount) {
  const oldLevel = levelForXp(player.xp);
  player.xp += amount;
  const newLevel = levelForXp(player.xp);
  if (newLevel > oldLevel) player.skillPoints += newLevel - oldLevel;
}

function currentValue(car) {
  ensureCarDefaults(car);
  const unresolved = car.defects.filter((defect) => !defect.repaired).reduce((sum, defect) => sum + defect.impact, 0);
  return Math.max(8000, Math.round((car.cleanValue + car.upgradeValue - unresolved) / 1000) * 1000);
}

function partsValue(car) {
  return Math.max(1000, Math.round((car.cleanValue * 0.07 + car.defects.length * 8500) / 1000) * 1000);
}

function inspectionSummary(car) {
  ensureCarDefaults(car);
  const records = inspectionCategories().map((category) => car.inspectionRecords[category]);
  const confidence = car.serviceDiagnosed ? 100 : Math.round(records.reduce((sum, record) => sum + (record?.confidence || 0), 0) / inspectionCategories().length);
  return {
    confidence,
    label: confidence >= 85 ? "высокая" : confidence >= 55 ? "средняя" : confidence >= 25 ? "базовая" : "не проверено",
    checked: records.filter(Boolean).length,
    complete: car.serviceDiagnosed
  };
}

function groupEmployeeRating(player, specialty) {
  const group = player?.groupId && groups.get(player.groupId);
  return group ? Math.max(0, ...group.employees.filter((employee) => employee.specialty === specialty).map((employee) => employee.rating)) : 0;
}

function groupCan(player, permission) {
  const group = player?.groupId && groups.get(player.groupId);
  if (!group) return false;
  if (group.ownerId === player.id) return true;
  const role = player.groupRole || group.roles[player.id] || "Участник";
  const permissions = {
    treasury: ["Управляющий", "Казначей"], garage: ["Управляющий", "Механик"],
    hire: ["Управляющий"], roles: [], listParts: ["Управляющий", "Механик"]
  };
  return (permissions[permission] || []).includes(role);
}

function saleEstimate(car, player = null) {
  ensureCarDefaults(car);
  const employeePlayer = player || (car.sellerId && players.get(car.sellerId)) || null;
  const technicalValue = currentValue(car);
  const marketPrice = marketIndices[car.model]?.price || technicalValue;
  const unresolved = car.defects.filter((defect) => !defect.repaired);
  const repaired = car.defects.filter((defect) => defect.repaired);
  const inspection = inspectionSummary(car);
  const repairValue = repaired.reduce((sum, defect) => sum + defect.impact, 0);
  const repairPremium = Math.min(marketPrice * 0.055, repairValue * 0.08);
  const documentationPremium = car.serviceDiagnosed ? marketPrice * 0.045 : inspection.confidence >= 70 ? marketPrice * 0.018 : 0;
  const restoredPremium = repaired.length && !unresolved.length ? marketPrice * 0.07 : 0;
  const upgradePremium = Math.min(marketPrice * 0.11, car.upgradeValue * 0.22);
  const conditionAdjustment = clamp((car.condition - 65) * marketPrice * 0.0022, -marketPrice * 0.08, marketPrice * 0.08);
  const repairLiquidityPenalty = repaired.length ? Math.min(marketPrice * 0.035, repaired.length * 7000) : 0;
  const employeePremium = marketPrice * (groupEmployeeRating(employeePlayer, "sales") / 100) * 0.04 + marketPrice * (groupEmployeeRating(employeePlayer, "appraisal") / 100) * 0.025;
  const installedPartsPremium = Math.min(marketPrice * 0.045, car.installedParts.reduce((sum, part) => sum + part.estimatedValue * 0.12, 0));
  const expectedNpcPrice = Math.max(1, Math.round((technicalValue * 0.58 + marketPrice * 0.42 + repairPremium + documentationPremium + restoredPremium + upgradePremium + conditionAdjustment - repairLiquidityPenalty + employeePremium + installedPartsPremium) / 1000) * 1000);
  const recommendedLow = Math.max(1, Math.round(expectedNpcPrice * 0.94 / 1000) * 1000);
  const recommendedHigh = Math.max(recommendedLow, Math.round(expectedNpcPrice * 1.09 / 1000) * 1000);
  const breakEven = Math.max(1, Math.ceil(car.invested * 1.02 / 1000) * 1000);
  return {
    technicalValue, marketPrice, repairPremium: Math.round(repairPremium), documentationPremium: Math.round(documentationPremium + restoredPremium), upgradePremium: Math.round(upgradePremium),
    expectedNpcPrice, recommendedLow, recommendedHigh, breakEven, invested: car.invested,
    unresolvedCount: unresolved.length, repairedCount: repaired.length,
    inspectionConfidence: inspection.confidence, inspectionLabel: inspection.label, upgradeValue: car.upgradeValue, upgradeCount: car.upgrades.length,
    employeePremium: Math.round(employeePremium), installedPartsPremium: Math.round(installedPartsPremium)
  };
}

function upgradeOptions(car, player) {
  ensureCarDefaults(car);
  return upgradeCatalog.map((upgrade) => ({
    ...upgrade,
    installed: car.upgrades.includes(upgrade.key),
    canAfford: Boolean(player && player.cash >= upgrade.cost),
    serviceCost: Math.round(upgrade.cost * 1.55 / 1000) * 1000,
    canUse: Boolean(player && player.skills[upgrade.skill] >= upgrade.skillLevel && player.equipment[upgrade.equipment] >= upgrade.equipmentLevel)
  }));
}

function initializeMarketIndices() {
  for (const item of catalog) {
    if (marketIndices[item.model]?.price) continue;
    const history = salesHistory.filter((sale) => sale.model === item.model).map((sale) => sale.price);
    const comparable = market.find((car) => car.model === item.model);
    marketIndices[item.model] = {
      price: average(history) || (comparable ? currentValue(comparable) : Math.round(item.base * 0.75 / 1000) * 1000),
      previousPrice: 0, trend: 0, transactions: history.length
    };
  }
}

function recordMarketSale(car, amount) {
  const index = marketIndices[car.model] || { price: currentValue(car), previousPrice: currentValue(car), trend: 0, transactions: 0 };
  const before = Math.max(1, index.price);
  const guardedAmount = clamp(amount, before * 0.65, before * 1.5);
  const indexStep = before < 100000 ? 100 : 1000;
  let after = Math.max(1, Math.round((before * 0.78 + guardedAmount * 0.22) / indexStep) * indexStep);
  if (after === before && guardedAmount !== before) after = Math.max(1, before + (guardedAmount > before ? indexStep : -indexStep));
  index.previousPrice = before;
  index.price = after;
  index.trend = Math.round(((after - before) / before) * 1000) / 10;
  index.transactions += 1;
  marketIndices[car.model] = index;
}

function serviceDiagnosticCost(car) {
  return Math.round((5000 + car.cleanValue * 0.006) / 500) * 500;
}

function serviceDiagnosticPrice(player, car) {
  const discount = groupEmployeeRating(player, "diagnostics") / 100 * 0.2;
  return Math.max(1000, Math.round(serviceDiagnosticCost(car) * (1 - discount) / 500) * 500);
}

function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function marketStatistics() {
  const relevantModels = new Set([...market.map((car) => car.model), ...salesHistory.slice(-200).map((sale) => sale.model)]);
  return Object.fromEntries(catalog.filter((item) => relevantModels.has(item.model)).map((item) => {
    const listingPrices = market.filter((car) => car.model === item.model).map((car) => car.price);
    const dealPrices = salesHistory.filter((sale) => sale.model === item.model).slice(-20).map((sale) => sale.price);
    const recordedAverage = average(dealPrices);
    const index = marketIndices[item.model] || { price: recordedAverage, trend: 0, transactions: dealPrices.length };
    const dealAverage = recordedAverage || index.price;
    return [item.model, {
      model: item.model,
      year: item.year,
      listings: listingPrices.length,
      askingAverage: average(listingPrices),
      askingMin: listingPrices.length ? Math.min(...listingPrices) : 0,
      askingMax: listingPrices.length ? Math.max(...listingPrices) : 0,
      dealAverage,
      marketPrice: index.price,
      trend: index.trend || 0,
      normalLow: Math.max(1, Math.round(index.price * 0.9 / 1000) * 1000),
      normalHigh: Math.max(1, Math.round(index.price * 1.1 / 1000) * 1000),
      dealCount: dealPrices.length,
      indexTransactions: index.transactions || 0
    }];
  }));
}

function partsMarketStatistics() {
  const recent = partsSalesHistory.slice(-60);
  return Object.fromEntries(["engine", "chassis", "body", "electrics", "tires"].map((component) => {
    const values = recent.filter((sale) => sale.component === component).map((sale) => sale.price);
    const active = partsMarket.filter((lot) => lot.item?.component === component).map((lot) => lot.price);
    const averagePrice = average(values) || average(active) || 10000;
    return [component, { component, averagePrice, active: active.length, deals: values.length }];
  }));
}

function npcPricingProfile(roll = Math.random()) {
  if (roll < 0.12) return { key: "urgent", tag: "Срочная продажа", min: 0.78, max: 0.89 };
  if (roll < 0.22) return { key: "project", tag: "Проект", min: 0.68, max: 0.82 };
  if (roll < 0.8) return { key: "fair", tag: "Рыночная цена", min: 0.9, max: 1.04 };
  return { key: "optimistic", tag: "Есть торг", min: 1.05, max: 1.14 };
}

function makeCar(index, seller = "Авторынок") {
  const item = catalog[index % catalog.length];
  const age = 2026 - item.year;
  const mileage = randomInt(Math.max(45, age * 9), Math.max(95, age * 19)) * 1000;
  const pricing = npcPricingProfile();
  const naturalDefects = randomInt(1, Math.min(4, Math.floor(age / 4) + 1));
  const count = pricing.key === "project" ? Math.max(3, naturalDefects) : naturalDefects;
  const pool = [...defectCatalog].sort(() => Math.random() - 0.5).slice(0, count);
  const wear = Math.min(0.4, mileage / 850000);
  const cleanValue = Math.round(item.base * (1 - wear) / 1000) * 1000;
  const provisional = { cleanValue, defects: pool.map((d) => ({ ...d, repaired: false })) };
  const fair = currentValue(provisional);
  const indexed = marketIndices[item.model]?.price;
  const pricingBase = indexed || fair;
  const asking = Math.max(1, Math.round((pricingBase * (pricing.min + Math.random() * (pricing.max - pricing.min))) / 1000) * 1000);
  const listedAt = Date.now();
  return {
    id: id("car_"), model: item.model, year: item.year, mileage, price: asking,
    purchasePrice: asking, invested: asking, seller, sellerId: null, ownerId: null,
    color: item.color, className: item.className, cleanValue,
    condition: clamp(95 - Math.round(wear * 100) - count * 7, 28, 92),
    defects: provisional.defects, discovered: [], checkedCategories: [], inspectionRecords: {}, serviceDiagnosed: false, repairs: [],
    description: pricing.key === "project" ? "Цена снижена: автомобиль под восстановление, состояние проверяйте внимательно." : count <= 1 ? "Ухоженная машина, сел и поехал." : ["Едет бодро, есть возрастные моменты.", "Продажа без спешки. Торг у капота.", "На ходу каждый день, требует внимания."][randomInt(0, 2)],
    marketTag: pricing.tag, listedAt,
    history: [{ type: "listed", text: "Первичное объявление на рынке", at: listedAt }]
  };
}

function publicDefect(defect) {
  const repairSkill = defect.category === "body" ? "bodywork" : defect.category === "electrics" ? "electrics" : "mechanics";
  const repairEquipment = defect.category === "body" ? "bodyStation" : defect.category === "electrics" ? "electricalBench" : "workshop";
  const selfRepairable = defect.category !== "documents";
  return {
    code: defect.code, category: defect.category, name: defect.name, symptom: defect.symptom,
    consequence: defect.consequence, severity: defect.severity, skill: defect.skill,
    partName: defect.partName || null,
    equipment: defect.equipment, equipmentLevel: defect.equipmentLevel,
    repair: defect.repair, repaired: defect.repaired,
    selfRepairable,
    assistedRepairCost: Math.max(500, Math.round(defect.repair * 0.58 / 500) * 500),
    selfRepairCost: Math.max(500, Math.round(defect.repair * 0.3 / 500) * 500),
    repairSkill, repairSkillLevel: Math.min(5, defect.severity + 1),
    repairEquipment, repairEquipmentLevel: defect.severity,
    assistedSkillLevel: defect.severity,
    assistedEquipmentLevel: Math.max(0, defect.severity - 1)
  };
}

function publicCar(car, ownerView = false, viewer = null) {
  ensureCarDefaults(car);
  const visibleCodes = new Set([...(car.publicDiscovered || []), ...(ownerView ? car.discovered : [])]);
  const result = {
    id: car.id, model: car.model, year: car.year, mileage: car.mileage, price: car.price,
    seller: car.seller, sellerId: car.sellerId, color: car.color, className: car.className,
    condition: car.condition, description: car.description, repairs: car.repairs,
    marketTag: car.sellerId ? null : car.marketTag, listedAt: car.listedAt,
    offerCount: [...offers.values()].filter((offer) => offer.carId === car.id && ["active", "counter"].includes(offer.status)).length,
    saleType: car.saleType || "fixed", auctionEnd: car.auctionEnd || null,
    startingPrice: car.startingPrice || null, highestBid: car.highestBid || 0,
    highestBidderName: car.highestBidderName || null, highestBidderType: car.highestBidderType || null, bidCount: car.bidCount || 0,
    viewerLeading: Boolean(viewer && car.highestBidderType === "player" && car.highestBidderId === viewer.id),
    viewerParticipated: Boolean(viewer && car.participantIds.includes(viewer.id))
  };
  result.publicInspectionRecords = car.publicInspectionRecords || {};
  if (car.groupContributorId) { result.groupContributorId = car.groupContributorId; result.groupContributorName = car.groupContributorName; }
  if (ownerView || (viewer && car.ownerId === viewer.id)) {
    result.defects = car.defects.filter((defect) => visibleCodes.has(defect.code)).map(publicDefect);
    result.checkedCategories = car.checkedCategories;
    result.inspectionRecords = car.inspectionRecords;
    result.inspection = inspectionSummary(car);
    result.serviceDiagnosed = car.serviceDiagnosed;
    result.serviceDiagnosticCost = viewer ? serviceDiagnosticPrice(viewer, car) : serviceDiagnosticCost(car);
    result.purchasePrice = car.purchasePrice;
    result.invested = car.invested;
    result.saleEstimate = saleEstimate(car, viewer);
    result.history = car.history.slice(-20);
    result.installedParts = car.installedParts;
    result.upgrades = car.upgrades;
    result.upgradeValue = car.upgradeValue;
    result.upgradeOptions = upgradeOptions(car, viewer);
  } else {
    result.defects = car.defects.filter((defect) => visibleCodes.has(defect.code)).map(publicDefect);
    result.publicInspection = { checked: Object.keys(car.publicInspectionRecords || {}), confidence: Object.values(car.publicInspectionRecords || {}).reduce((sum, record) => sum + record.confidence, 0) };
  }
  return result;
}

function offerView(offer) {
  const car = market.find((item) => item.id === offer.carId);
  return { ...offer, car: car ? { id: car.id, model: car.model, price: car.price, color: car.color, year: car.year } : offer.car };
}

function publicGroupView(group, viewer) {
  ensureGroupDefaults(group);
  return {
    id: group.id, name: group.name, ownerId: group.ownerId, rating: group.rating, treasury: group.treasury,
    garageCapacity: group.garageCapacity, garage: group.garage.map((car) => publicCar(car, true, viewer)), employees: group.employees,
    members: group.members.map((playerId) => {
      const member = players.get(playerId);
      return { id: playerId, name: member?.name || "Неизвестный игрок", role: group.roles[playerId] || member?.groupRole || "Участник" };
    }),
    log: group.log.slice(-30), permissions: {
      treasury: groupCan(viewer, "treasury"), garage: groupCan(viewer, "garage"), hire: groupCan(viewer, "hire"), roles: group.ownerId === viewer.id
    }
  };
}

function playerView(player) {
  const reserved = reservedCash(player);
  return {
    id: player.id, name: player.name, cash: player.cash, profit: player.profit, deals: player.deals, isAdmin: isAdmin(player), purchasedCash: player.purchasedCash, training: player.training,
    availableCash: player.cash - reserved, reservedCash: reserved,
    xp: player.xp, level: levelForXp(player.xp), levelStartXp: xpForLevel(levelForXp(player.xp)), nextLevelXp: levelForXp(player.xp) >= 30 ? player.xp : xpForLevel(levelForXp(player.xp) + 1),
    skillPoints: player.skillPoints, skills: player.skills, equipment: player.equipment, stats: player.stats,
    reputation: player.reputation, contracts: player.contracts, garageCapacity: player.garageCapacity, parts: player.parts,
    group: player.groupId && groups.get(player.groupId) ? publicGroupView(groups.get(player.groupId), player) : null, groupRole: player.groupRole,
    garage: player.garage.map((car) => publicCar(car, true, player)), partInventory: player.partInventory,
    incomingOffers: [...offers.values()].filter((offer) => offer.sellerId === player.id && ["active", "counter"].includes(offer.status)).map(offerView),
    outgoingOffers: [...offers.values()].filter((offer) => offer.buyerId === player.id && ["active", "counter"].includes(offer.status)).map(offerView),
    containerRewards: player.containerRewards.filter((reward) => !reward.acknowledged).slice(-3),
    notifications: player.notifications.slice(-20).reverse(), unreadNotifications: player.notifications.filter((item) => !item.read).length
  };
}

function snapshot(player) {
  return {
    revision,
    player: player ? playerView(player) : null,
    market: market.map((car) => publicCar(car, car.sellerId === player?.id, player)),
    skillInfo,
    equipmentInfo,
    inspectionCategories: inspectionCategories(),
    inspectionRequirements,
    marketStats: marketStatistics(),
    partsMarketStats: partsMarketStatistics(),
    chatMessages: chatMessages.slice(-100),
    partsMarket: partsMarket.slice(-100),
    marketRotation: { nextAt: marketRotationNextAt, intervalSeconds: Math.round(NPC_ROTATION_MS / 1000), replaceCount: NPC_ROTATION_COUNT },
    groups: [...groups.values()].map((group) => ({ id: group.id, name: group.name, rating: group.rating, members: group.members.length })),
    npcProfiles: bots.map((bot) => ({ id: bot.id, name: bot.name, type: bot.type, rating: Math.round((bot.risk * 80 + bot.skill * 4) * 10) / 10, budget: bot.budget })),
    employeeCandidates,
    store: { enabled: Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY), provider: "YooKassa", packages: cashPackages },
    catalogCount: catalog.length,
    containerAuctions: containerAuctions.map((container) => publicContainer(container, player)),
    leaderboard: [...players.values()].sort((a, b) => b.profit - a.profit).slice(0, 8)
      .map((p) => ({ id: p.id, name: p.name, profit: p.profit, deals: p.deals, level: levelForXp(p.xp) }))
  };
}

function broadcast() {
  revision += 1;
  persistState();
  for (const client of clients) client.res.write(`event: update\ndata: ${JSON.stringify(snapshot(client.player))}\n\n`);
}

function seedMarket() {
  for (let i = 0; i < 100; i += 1) market.push(makeCar(i));
  for (const item of catalog) {
    const comparable = market.find((car) => car.model === item.model);
    const anchor = comparable ? currentValue(comparable) : Math.round(item.base * 0.78 / 1000) * 1000;
    for (let i = 0; i < 7; i += 1) {
      salesHistory.push({ model: item.model, price: Math.max(1, Math.round(anchor * (0.9 + Math.random() * 0.2) / 1000) * 1000), at: Date.now() - randomInt(1, 30) * 86400000 });
    }
  }
}
if (!loadState()) {
  seedMarket();
  persistState();
}
initializeMarketIndices();
restock();
rebalanceNpcMarket();
function publishPartLot(itemOrType, condition = "new", price = null, seller = "Магазин", sellerId = null) {
  const legacyType = typeof itemOrType === "string" ? itemOrType : null;
  const item = legacyType
    ? makePart(["engine", "chassis", "body", "electrics", "tires"][randomInt(0, 4)], legacyType === "premium" ? "original" : condition === "used" ? "restored" : "analog", condition === "used" ? randomInt(48, 82) : 100, randomInt(0, catalog.length - 1) % 3 ? "all" : catalog[randomInt(0, catalog.length - 1)].className, catalog[randomInt(0, catalog.length - 1)].model)
    : itemOrType;
  const lot = { id: id("part_"), item, type: item.quality === "original" ? "premium" : "common", condition: item.conditionPct < 100 ? "used" : "new", price: price || item.estimatedValue, seller, sellerId, createdAt: Date.now() };
  partsMarket.push(lot);
  return lot;
}
if (!partsMarket.length) {
  for (let i = 0; i < 12; i += 1) publishPartLot(i % 3 === 0 ? "premium" : "common", i % 2 ? "new" : "used");
}
persistState();

function runNpcPartBuyers() {
  let changed = false;
  for (const lot of partsMarket.slice()) {
    if (Math.random() > 0.22) continue;
    const item = ensurePartLot(lot).item;
    const candidates = bots.filter((bot) => bot.budget >= lot.price && lot.price <= item.estimatedValue * (0.78 + bot.risk * 0.12));
    const buyer = candidates.sort(() => Math.random() - 0.5)[0];
    if (!buyer) continue;
    const seller = lot.sellerId && players.get(lot.sellerId);
    if (seller) seller.cash += Math.round(lot.price * 0.95);
    partsSalesHistory.push({ component: item.component, model: item.compatibleModel, price: lot.price, buyer: buyer.name, at: Date.now() });
    partsMarket.splice(partsMarket.indexOf(lot), 1);
    changed = true;
  }
  while (partsMarket.length < 12) publishPartLot(Math.random() < 0.22 ? "premium" : "common", Math.random() < 0.5 ? "used" : "new");
  if (changed) broadcast();
}
setInterval(runNpcPartBuyers, 12000).unref();

function reservedCash(player) {
  const carsReserved = market.filter((car) => car.saleType === "auction" && car.highestBidderId === player.id && car.auctionEnd > Date.now()).reduce((sum, car) => sum + car.highestBid, 0);
  const containersReserved = containerAuctions.filter((item) => item.highestBidderId === player.id && item.endAt > Date.now()).reduce((sum, item) => sum + item.highestBid, 0);
  return carsReserved + containersReserved;
}

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pin, salt, 32).toString("hex") };
}

function verifyPin(pin, player) {
  if (!player.pinSalt || !player.pinHash) return false;
  const candidate = Buffer.from(hashPin(pin, player.pinSalt).hash, "hex");
  const expected = Buffer.from(player.pinHash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function createPlayer(name, pin = null) {
  const credentials = pin ? hashPin(pin) : {};
  const player = {
    id: id("player_"), name, normalizedName: name.toLocaleLowerCase("ru-RU"),
    pinSalt: credentials.salt || null, pinHash: credentials.hash || null,
    cash: STARTING_CASH, profit: 0, deals: 0, garage: [], xp: 0, skillPoints: 1,
    skills: {}, equipment: {}, garageCapacity: MAX_GARAGE, parts: { common: 0, premium: 0 }, groupId: null, groupRole: null,
    stats: { purchases: 0, inspections: 0, serviceDiagnostics: 0, selfRepairs: 0, assistedRepairs: 0, workshopRepairs: 0, auctionsWon: 0, bids: 0 }
  };
  ensurePlayerDefaults(player);
  return player;
}

function restock() {
  const npcCount = market.filter((car) => !car.sellerId).length;
  for (let i = npcCount; i < 100; i += 1) market.push(makeCar(randomInt(0, catalog.length - 1)));
}

function createContainerAuction(tierKey) {
  const tier = containerTiers[tierKey];
  return { id: id("container_"), tier: tierKey, name: tier.name, color: tier.color, startingPrice: randomInt(tier.startMin, tier.startMax), highestBid: 0, highestBidderId: null, highestBidderName: null, highestBidderType: null, participantIds: [], bidCount: 0, endAt: Date.now() + randomInt(180, 420) * 1000, createdAt: Date.now() };
}

function restockContainers() {
  for (const tier of Object.keys(containerTiers)) while (containerAuctions.filter((item) => item.tier === tier).length < 3) containerAuctions.push(createContainerAuction(tier));
}

function containerRewardCar(tierKey, invested) {
  const tier = containerTiers[tierKey];
  const pool = catalog.filter((item) => item.base >= tier.minValue && item.base <= tier.maxValue);
  const item = pool[randomInt(0, pool.length - 1)] || catalog[0];
  const car = makeCar(catalog.indexOf(item), "Контейнерный аукцион");
  car.price = invested; car.purchasePrice = invested; car.invested = invested; car.seller = "Контейнерный аукцион"; car.ownerId = null;
  car.history = [{ type: "container", text: `Получена из контейнера «${tier.name}» за ${invested.toLocaleString("ru-RU")} ₽`, at: Date.now() }];
  return car;
}

function publicContainer(container, viewer = null) {
  const tier = containerTiers[container.tier];
  container.participantIds ||= [];
  const { participantIds, ...safeContainer } = container;
  return { ...safeContainer, minValue: tier.minValue, maxValue: tier.maxValue, viewerLeading: Boolean(viewer && container.highestBidderType === "player" && container.highestBidderId === viewer.id), viewerParticipated: Boolean(viewer && participantIds.includes(viewer.id)) };
}

function finalizeContainers() {
  let changed = false;
  for (const auction of containerAuctions.filter((item) => item.endAt <= Date.now())) {
    if (auction.highestBidderType === "player") {
      const winner = players.get(auction.highestBidderId);
      if (winner && winner.cash >= auction.highestBid && winner.garage.length < winner.garageCapacity) {
        const rewardCar = containerRewardCar(auction.tier, auction.highestBid);
        winner.cash -= auction.highestBid; winner.garage.push(rewardCar); winner.stats.auctionsWon += 1; addXp(winner, 90);
        const item = catalog.find((entry) => entry.model === rewardCar.model);
        const marketPrice = marketIndices[rewardCar.model]?.price || rewardCar.cleanValue;
        winner.containerRewards.push({ id: id("reward_"), containerId: auction.id, tier: auction.tier, containerName: auction.name, paid: auction.highestBid, awardedAt: Date.now(), acknowledged: false, car: { id: rewardCar.id, model: rewardCar.model, year: rewardCar.year, mileage: rewardCar.mileage, condition: rewardCar.condition, className: rewardCar.className, color: rewardCar.color, cleanValue: rewardCar.cleanValue, estimatedValue: currentValue(rewardCar), marketPrice, defectCount: rewardCar.defects.length, rarity: item?.base >= 30000000 ? "Легендарный" : item?.base >= 8000000 ? "Редкий" : item?.base >= 1000000 ? "Необычный" : "Обычный" } });
      }
    }
    containerAuctions.splice(containerAuctions.indexOf(auction), 1); changed = true;
  }
  if (changed) { restockContainers(); broadcast(); }
}

function runContainerBots() {
  let changed = false;
  for (const auction of containerAuctions.filter((item) => item.endAt > Date.now() + 2000)) {
    if (Math.random() > 0.38) continue;
    const tier = containerTiers[auction.tier]; const current = auction.highestBid || auction.startingPrice;
    const minimum = auction.highestBid ? current + Math.max(1000, Math.ceil(current * 0.02)) : current;
    const ceiling = tier.maxValue * (0.18 + Math.random() * 0.22);
    const bot = bots.filter((item) => item.budget >= minimum && item.id !== auction.highestBidderId).sort(() => Math.random() - 0.5)[0];
    if (!bot || minimum > ceiling) continue;
    const previousPlayerId = auction.highestBidderType === "player" ? auction.highestBidderId : null;
    auction.highestBid = Math.max(minimum, Math.round(Math.min(Math.round((minimum + Math.random() * Math.max(1000, minimum * 0.06)) / 1000) * 1000, ceiling)));
    auction.highestBidderId = bot.id; auction.highestBidderName = bot.name; auction.highestBidderType = "bot"; auction.bidCount += 1; changed = true;
    if (previousPlayerId) notifyOutbid(previousPlayerId, "container", auction.name, auction.highestBid, auction.id);
  }
  if (changed) broadcast();
}

restockContainers();
setInterval(finalizeContainers, 1000).unref();
setInterval(runContainerBots, 3500).unref();

function rebalanceNpcMarket() {
  const npcCars = market.filter((car) => !car.sellerId && car.saleType !== "auction").sort(() => Math.random() - 0.5);
  npcCars.forEach((car, index) => {
    const ratio = (index + 0.5) / Math.max(1, npcCars.length);
    const pricing = npcPricingProfile(ratio);
    const reference = marketIndices[car.model]?.price || currentValue(car);
    const multiplier = pricing.min + Math.random() * (pricing.max - pricing.min);
    car.price = Math.max(1, Math.round(reference * multiplier / 1000) * 1000);
    car.purchasePrice = car.price;
    car.invested = car.price;
    car.marketTag = pricing.tag;
    car.listedAt = Date.now() - randomInt(0, NPC_ROTATION_MS);
  });
}

function rotateNpcMarket() {
  const candidates = market.filter((car) => !car.sellerId && car.saleType !== "auction")
    .sort((a, b) => (a.listedAt || 0) - (b.listedAt || 0));
  const removed = candidates.slice(0, Math.min(NPC_ROTATION_COUNT, candidates.length));
  for (const car of removed) market.splice(market.indexOf(car), 1);
  restock();
  marketRotationNextAt = Date.now() + NPC_ROTATION_MS;
  broadcast();
}

function getPlayer(req) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") || requestUrl.searchParams.get("token");
  const playerId = token && sessions.get(token);
  return playerId ? players.get(playerId) : null;
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function yookassaRequest(pathname, options = {}) {
  const authorization = Buffer.from(`${YOOKASSA_SHOP_ID}:${YOOKASSA_SECRET_KEY}`).toString("base64");
  const response = await fetch(`https://api.yookassa.ru/v3${pathname}`, {
    ...options,
    headers: { Authorization: `Basic ${authorization}`, "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.description || "Платёжный сервис временно недоступен");
  return data;
}

async function confirmPayment(paymentId) {
  const order = paymentOrders.get(paymentId);
  if (!order || order.status === "succeeded" || !YOOKASSA_SHOP_ID) return false;
  const payment = await yookassaRequest(`/payments/${encodeURIComponent(paymentId)}`);
  if (payment.status !== "succeeded" || payment.paid !== true || payment.metadata?.orderId !== order.orderId) return false;
  const player = players.get(order.playerId);
  if (!player) return false;
  player.cash += order.cash;
  player.purchasedCash += order.cash;
  order.status = "succeeded";
  order.paidAt = Date.now();
  persistState();
  broadcast();
  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); } });
    req.on("error", reject);
  });
}

function completeSale(car, buyer, amount) {
  const marketIndex = market.findIndex((item) => item.id === car.id);
  if (marketIndex < 0) return false;
  if (buyer && (buyer.cash < amount || buyer.garage.length >= buyer.garageCapacity)) return false;
  const seller = car.sellerId ? players.get(car.sellerId) : null;
  if (buyer) {
    buyer.cash -= amount;
    buyer.garage.push(car);
    buyer.stats.purchases += 1;
    if (car.saleType === "auction") buyer.stats.auctionsWon += 1;
    addXp(buyer, 25);
  }
  if (seller) {
    seller.cash += amount;
    seller.profit += amount - car.invested;
    seller.deals += 1;
    addXp(seller, 100);
    const honest = !(/идеал|без проблем|вложений не требует/i.test(car.description) && car.defects.some((defect) => !defect.repaired));
    seller.reputation.score = clamp(seller.reputation.score + (honest ? 1 : -5), 0, 100);
    seller.reputation.completed += 1;
    for (const contract of seller.contracts) {
      if (contract.status !== "active" || contract.expiresAt < Date.now() || contract.model && contract.model !== car.model) continue;
      const qualifies = contract.kind === "profit" ? amount > car.invested : contract.kind === "honest" ? honest : car.serviceDiagnosed && car.repairs.length > 0;
      if (qualifies) { contract.status = "completed"; seller.cash += contract.reward; seller.profit += contract.reward; seller.reputation.score = clamp(seller.reputation.score + 2, 0, 100); }
    }
  }
  salesHistory.push({ model: car.model, price: amount, at: Date.now() });
  recordMarketSale(car, amount);
  market.splice(marketIndex, 1);
  for (const offer of offers.values()) if (offer.carId === car.id && ["active", "counter"].includes(offer.status)) offer.status = "closed";
  car.price = amount;
  car.purchasePrice = amount;
  car.invested = amount;
  car.seller = buyer ? buyer.name : "NPC-покупатель";
  car.sellerId = null;
  car.ownerId = buyer?.id || null;
  car.history.push({ type: "sold", text: `Сделка завершена за ${amount} ₽`, at: Date.now() });
  car.discovered = [];
  car.checkedCategories = [];
  car.inspectionRecords = {};
  car.serviceDiagnosed = false;
  car.saleType = "fixed";
  car.startingPrice = null;
  car.auctionEnd = null;
  car.highestBid = 0;
  car.highestBidderId = null;
  car.highestBidderName = null;
  car.highestBidderType = null;
  car.bidCount = 0;
  restock();
  return true;
}

function evaluateBots(car) {
  if (!market.some((item) => item.id === car.id) || !car.sellerId) return;
  const lie = /вложений не требует|идеал|без проблем/i.test(car.description) && car.defects.some((defect) => !defect.repaired);
  const candidates = [...bots].sort(() => Math.random() - 0.5).slice(0, randomInt(2, 4));
  for (const bot of candidates) {
    if (car.price > bot.budget) continue;
    const detected = car.defects.filter((defect) => !defect.repaired && defect.skill + defect.equipmentLevel <= bot.skill + 2);
    const ceiling = botAuctionCeiling(car, bot);
    if (ceiling < 1 || car.price > ceiling * 1.35) continue;
    if (car.price <= ceiling * 0.96 && Math.random() < (car.repairs.length ? 0.72 : 0.48)) {
      completeSale(car, null, car.price);
      broadcast();
      return;
    }
    const amount = clamp(Math.round(Math.min(car.price * 0.96, ceiling)), 1, car.price - 1);
    if (amount >= car.price) continue;
    const issue = detected.sort((a, b) => b.impact - a.impact)[0];
    const reason = lie && issue
      ? `В описании всё идеально, но я вижу: ${issue.name.toLowerCase()}. Моя цена ниже.`
      : issue ? `Учёл риск: ${issue.name.toLowerCase()}. Готов забрать сегодня.`
        : car.repairs.length ? `Вижу подтверждённые работы (${car.repairs.length}). За подготовленную машину готов платить выше среднего.`
          : car.price > saleEstimate(car).expectedNpcPrice ? "Цена выше моей оценки. Предлагаю сумму ближе к реальной стоимости." : "Готов быстро оформить сделку без дальнейшего торга.";
    const offer = {
      id: id("offer_"), carId: car.id, sellerId: car.sellerId,
      buyerId: bot.id, buyerName: bot.name, buyerType: "bot", amount,
      status: "active", reason, createdAt: Date.now(), attempts: 0, lastOfferAt: Date.now()
    };
    offers.set(offer.id, offer);
  }
  broadcast();
}

function scheduleBots(car) {
  setTimeout(() => evaluateBots(car), 900 + randomInt(0, 900));
}

function refreshNpcOffers() {
  for (const car of market.filter((item) => item.sellerId && item.saleType === "fixed")) {
    const active = [...offers.values()].filter((offer) => offer.carId === car.id && offer.buyerType === "bot" && ["active", "counter"].includes(offer.status));
    if (active.length >= 2) continue;
    if (Math.random() > 0.38) continue;
    evaluateBots(car);
  }
}
setInterval(refreshNpcOffers, 18000).unref();

function finalizeAuctions() {
  const expired = market.filter((car) => car.saleType === "auction" && car.auctionEnd <= Date.now());
  if (!expired.length) return;
  for (const car of expired) {
    if (car.highestBidderType === "bot" && car.highestBid > 0) {
      completeSale(car, null, car.highestBid);
      continue;
    }
    const buyer = car.highestBidderId ? players.get(car.highestBidderId) : null;
    if (buyer && buyer.cash >= car.highestBid && buyer.garage.length < buyer.garageCapacity) {
      completeSale(car, buyer, car.highestBid);
      continue;
    }
    const seller = players.get(car.sellerId);
    const index = market.findIndex((item) => item.id === car.id);
    if (index >= 0 && seller && seller.garage.length < seller.garageCapacity) {
      market.splice(index, 1);
      car.saleType = "fixed";
      car.auctionEnd = null;
      car.highestBid = 0;
      car.highestBidderId = null;
      car.highestBidderName = null;
      car.highestBidderType = null;
      car.bidCount = 0;
      car.participantIds = [];
      seller.garage.push(car);
    } else if (index >= 0) {
      car.auctionEnd = Date.now() + 60000;
    }
  }
  broadcast();
}

setInterval(finalizeAuctions, 1000).unref();

function botAuctionCeiling(car, bot) {
  const estimate = saleEstimate(car);
  const unresolved = car.defects.filter((defect) => !defect.repaired);
  const detected = unresolved.filter((defect) => defect.skill + defect.equipmentLevel <= bot.skill + 2);
  const unknownCount = unresolved.length - detected.length;
  const liePenalty = /идеал|без проблем|вложений не требует/i.test(car.description) && unresolved.length ? 0.06 : 0;
  const uncertaintyPenalty = unknownCount * 0.018;
  const repairBonus = car.repairs.length ? bot.repairPremium : 0;
  const collectorMatch = bot.type === "collector" && ["classic", "coupe", "roadster", "premium"].includes(car.className) ? 0.1 : bot.type === "collector" ? -0.12 : 0;
  const budgetPenalty = bot.type === "budget" && car.price > bot.budget * 0.8 ? 0.06 : 0;
  const dealerMargin = bot.type === "dealer" ? 0.08 : 0;
  const multiplier = bot.risk + repairBonus + collectorMatch - liePenalty - uncertaintyPenalty - budgetPenalty - dealerMargin;
  return Math.min(bot.budget, Math.max(1, Math.round(estimate.expectedNpcPrice * multiplier / 1000) * 1000));
}

function runAuctionBots() {
  let changed = false;
  const active = market.filter((car) => car.saleType === "auction" && car.auctionEnd > Date.now() + 1500 && car.sellerId);
  for (const car of active) {
    if (Math.random() > BOT_BID_CHANCE) continue;
    const candidates = bots.filter((bot) => bot.id !== car.highestBidderId).sort(() => Math.random() - 0.5);
    for (const bot of candidates) {
      const current = car.highestBid || car.startingPrice;
      const minimum = car.highestBid ? current + Math.max(1, Math.ceil(current * 0.01)) : current;
      const ceiling = botAuctionCeiling(car, bot);
      if (minimum > ceiling) continue;
      const jump = Math.min(ceiling - minimum, Math.max(1000, ceiling * 0.025));
      const bid = Math.min(ceiling, Math.max(minimum, Math.round((minimum + Math.random() * jump) / 1000) * 1000));
      const previousPlayerId = car.highestBidderType === "player" ? car.highestBidderId : null;
      car.highestBid = Math.max(minimum, bid);
      car.highestBidderId = bot.id;
      car.highestBidderName = bot.name;
      car.highestBidderType = "bot";
      car.price = car.highestBid;
      car.bidCount += 1;
      if (previousPlayerId) notifyOutbid(previousPlayerId, "car", car.model, car.highestBid, car.id);
      changed = true;
      break;
    }
  }
  if (changed) broadcast();
}

setInterval(runAuctionBots, 2200).unref();
setInterval(rotateNpcMarket, NPC_ROTATION_MS).unref();

function normalizeChatText(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

function censorChatText(value) {
  const patterns = [/бл(?:я|ять|ин)[а-яё]*/giu, /х(?:у|y)[йеёяию][а-яё]*/giu, /п(?:и|е)зд[а-яё]*/giu, /(?:е|ё)б[а-яё]*/giu, /сук[аи][а-яё]*/giu, /муд(?:ак|ил)[а-яё]*/giu];
  let censored = value;
  for (const pattern of patterns) censored = censored.replace(pattern, (word) => "*".repeat(Math.min(12, word.length)));
  return censored;
}

function moderateChat(player, rawText) {
  const text = normalizeChatText(rawText);
  const now = Date.now();
  const chat = player.chatState;
  if (chat.mutedUntil > now) throw new Error(`Чат временно недоступен ещё ${Math.ceil((chat.mutedUntil - now) / 1000)} сек.`);
  if (text.length < 2) throw new Error("Сообщение слишком короткое");
  if ((text.match(/https?:\/\/|www\.|\.ru\b|\.com\b/gi) || []).length > 1) throw new Error("В сообщении слишком много ссылок");
  if (/(.)\1{7,}/iu.test(text)) throw new Error("Не повторяйте один символ много раз");
  const normalized = text.toLocaleLowerCase("ru-RU").replace(/[^а-яёa-z0-9]+/gi, "");
  chat.sentAt = chat.sentAt.filter((time) => now - time < 30000);
  const violation = (message) => {
    chat.violations += 1;
    if (chat.violations >= 3) { chat.mutedUntil = now + 60000; chat.violations = 0; }
    throw new Error(message);
  };
  if (chat.sentAt.length && now - chat.sentAt.at(-1) < 1500) violation("Слишком быстро. Подождите пару секунд");
  if (chat.sentAt.length >= 5) violation("Лимит: 5 сообщений за 30 секунд");
  if (normalized && normalized === chat.lastNormalized && now - chat.lastDuplicateAt < 60000) violation("Одинаковые сообщения нельзя отправлять подряд");
  chat.sentAt.push(now);
  chat.lastNormalized = normalized;
  chat.lastDuplicateAt = now;
  return censorChatText(text);
}

async function api(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/health") {
    return json(res, 200, { status: "ok", service: "perekup-market", revision, uptimeSeconds: Math.round(process.uptime()) });
  }
  if (req.method === "POST" && pathname === "/api/payments/webhook") {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) return json(res, 503, { error: "Платежи не настроены" });
    const payload = await readBody(req);
    const paymentId = String(payload.object?.id || "");
    if (!paymentId) return json(res, 400, { error: "Некорректное уведомление" });
    try { await confirmPayment(paymentId); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 502, { error: "Не удалось проверить платёж" }); }
  }
  if (req.method === "POST" && pathname === "/api/register") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 20);
    const pin = String(body.pin || "");
    if (name.length < 2) return json(res, 400, { error: "Введите имя от 2 символов" });
    if (!/^\d{4,12}$/.test(pin)) return json(res, 400, { error: "PIN должен содержать от 4 до 12 цифр" });
    const normalized = name.toLocaleLowerCase("ru-RU");
    if ([...players.values()].some((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === normalized && item.pinHash)) {
      return json(res, 409, { error: "Аккаунт с таким именем уже существует" });
    }
    const player = createPlayer(name, pin);
    const token = id("session_");
    players.set(player.id, player);
    sessions.set(token, player.id);
    broadcast();
    return json(res, 200, { token, ...snapshot(player) });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().toLocaleLowerCase("ru-RU");
    const pin = String(body.pin || "");
    const player = [...players.values()].find((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === name && item.pinHash);
    if (!player || !verifyPin(pin, player)) return json(res, 401, { error: "Неверное имя или PIN" });
    const token = id("session_");
    sessions.set(token, player.id);
    persistState();
    return json(res, 200, { token, ...snapshot(player) });
  }

  if (req.method === "POST" && pathname === "/api/join") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 20);
    if (name.length < 2) return json(res, 400, { error: "Введите имя от 2 символов" });
    const token = id("session_");
    const player = createPlayer(name);
    players.set(player.id, player);
    sessions.set(token, player.id);
    broadcast();
    return json(res, 200, { token, ...snapshot(player) });
  }

  const player = getPlayer(req);
  if (!player) return json(res, 401, { error: "Сессия не найдена" });
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, snapshot(player));
  if (req.method === "GET" && pathname === "/api/admin/state") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    return json(res, 200, {
      players: [...players.values()].map((item) => ({ id: item.id, name: item.name, cash: item.cash, profit: item.profit, deals: item.deals, level: levelForXp(item.xp), garage: item.garage.length, reputation: item.reputation?.score || 50, purchasedCash: item.purchasedCash || 0 })),
      economy: { players: players.size, marketCars: market.length, deals: salesHistory.length, activeOffers: [...offers.values()].filter((offer) => ["active", "counter"].includes(offer.status)).length, payments: [...paymentOrders.values()].filter((order) => order.status === "succeeded").length }
    });
  }
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: update\ndata: ${JSON.stringify(snapshot(player))}\n\n`);
    const client = { res, player };
    clients.add(client);
    req.on("close", () => clients.delete(client));
    return;
  }

  const body = await readBody(req);
  if (req.method === "POST" && pathname === "/api/container/reward/ack") {
    const reward = player.containerRewards.find((item) => item.id === body.rewardId && !item.acknowledged);
    if (!reward) return json(res, 404, { error: "Награда уже получена или не найдена" });
    reward.acknowledged = true;
    broadcast();
    return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/notifications/read") {
    for (const notification of player.notifications) notification.read = true;
    broadcast();
    return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/store/create-payment") {
    if (!YOOKASSA_SHOP_ID || !YOOKASSA_SECRET_KEY) return json(res, 503, { error: "Приём рублей ещё не подключён. Нужны ключи YooKassa." });
    const pack = cashPackages.find((item) => item.id === body.packageId);
    if (!pack) return json(res, 404, { error: "Пакет не найден" });
    const orderId = id("order_");
    try {
      const payment = await yookassaRequest("/payments", {
        method: "POST", headers: { "Idempotence-Key": orderId },
        body: JSON.stringify({ amount: { value: pack.rubles.toFixed(2), currency: "RUB" }, capture: true, confirmation: { type: "redirect", return_url: `${PUBLIC_URL}/#store` }, description: `${pack.name}: ${pack.cash.toLocaleString("ru-RU")} игровых рублей`, metadata: { orderId, playerId: player.id, packageId: pack.id } })
      });
      paymentOrders.set(payment.id, { orderId, paymentId: payment.id, playerId: player.id, packageId: pack.id, rubles: pack.rubles, cash: pack.cash, status: payment.status, createdAt: Date.now() });
      persistState();
      return json(res, 200, { confirmationUrl: payment.confirmation?.confirmation_url });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/player") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    const target = players.get(String(body.playerId || ""));
    if (!target) return json(res, 404, { error: "Игрок не найден" });
    const delta = Math.round(Number(body.cashDelta));
    if (!Number.isFinite(delta) || Math.abs(delta) > 10000000 || target.cash + delta < 0) return json(res, 400, { error: "Некорректное изменение баланса" });
    target.cash += delta;
    target.adminNotes.push({ adminId: player.id, delta, reason: String(body.reason || "Корректировка администратора").slice(0, 100), at: Date.now() });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/chat") {
    try {
      const text = moderateChat(player, body.message);
      chatMessages.push({ id: id("msg_"), playerId: player.id, playerName: player.name, text, createdAt: Date.now() });
      if (chatMessages.length > 100) chatMessages.splice(0, chatMessages.length - 100);
      broadcast();
      return json(res, 200, snapshot(player));
    } catch (error) {
      persistState();
      return json(res, 429, { error: error.message });
    }
  }
  if (req.method === "POST" && pathname === "/api/group/create") {
    if (player.groupId) return json(res, 400, { error: "Вы уже состоите в группе" });
    const name = String(body.name || "").trim().slice(0, 30);
    if (name.length < 3) return json(res, 400, { error: "Название группы слишком короткое" });
    const group = ensureGroupDefaults({ id: id("group_"), name, ownerId: player.id, rating: 50, treasury: 0, members: [player.id], roles: { [player.id]: "Владелец" } });
    group.log.push({ at: Date.now(), text: `${player.name} создал группу` });
    groups.set(group.id, group); player.groupId = group.id; player.groupRole = "Владелец";
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/join") {
    if (player.groupId) return json(res, 400, { error: "Сначала выйдите из текущей группы" });
    const group = groups.get(String(body.groupId || ""));
    if (!group) return json(res, 404, { error: "Группа не найдена" });
    group.members.push(player.id); group.roles[player.id] = "Участник"; player.groupId = group.id; player.groupRole = "Участник";
    group.log.push({ at: Date.now(), text: `${player.name} вступил в группу` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/transfer") {
    const amount = Math.round(Number(body.amount)); const group = player.groupId && groups.get(player.groupId);
    if (!group) return json(res, 400, { error: "Вы не состоите в группе" });
    if (!Number.isFinite(amount) || amount < 1 || amount > player.cash) return json(res, 400, { error: "Некорректная сумма перевода" });
    player.cash -= amount; group.treasury += amount; group.rating = clamp(group.rating + Math.min(3, amount / 100000), 0, 100);
    group.log.push({ at: Date.now(), text: `${player.name} внёс ${amount} ₽` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/pay") {
    const group = player.groupId && groups.get(player.groupId); const amount = Math.round(Number(body.amount));
    if (!group || !groupCan(player, "treasury")) return json(res, 403, { error: "У вашей роли нет доступа к общей кассе" });
    const target = players.get(String(body.playerId || ""));
    if (!target || target.groupId !== group.id) return json(res, 404, { error: "Участник группы не найден" });
    if (!Number.isFinite(amount) || amount < 1 || amount > group.treasury) return json(res, 400, { error: "В кассе недостаточно денег" });
    group.treasury -= amount; target.cash += amount;
    group.log.push({ at: Date.now(), text: `${player.name} выдал ${target.name} ${amount} ₽` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/role") {
    const group = player.groupId && groups.get(player.groupId);
    if (!group || group.ownerId !== player.id) return json(res, 403, { error: "Только владелец группы меняет статусы" });
    const target = players.get(String(body.playerId || "")); const role = String(body.role || "Участник");
    if (!["Участник", "Управляющий", "Казначей", "Механик", "Оценщик"].includes(role)) return json(res, 400, { error: "Неизвестная роль" });
    if (!target || target.groupId !== group.id) return json(res, 404, { error: "Участник не найден" });
    if (target.id === group.ownerId) return json(res, 400, { error: "Роль владельца нельзя изменить" });
    target.groupRole = role; group.roles[target.id] = role; group.log.push({ at: Date.now(), text: `${target.name} получил роль «${role}»` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/garage/deposit") {
    const group = player.groupId && groups.get(player.groupId); const index = player.garage.findIndex((car) => car.id === body.carId);
    if (!group) return json(res, 400, { error: "Вы не состоите в группе" });
    if (index < 0) return json(res, 404, { error: "Машина не найдена в личном гараже" });
    if (group.garage.length >= group.garageCapacity) return json(res, 400, { error: "Общий гараж заполнен" });
    const car = player.garage.splice(index, 1)[0]; car.groupContributorId = player.id; car.groupContributorName = player.name;
    car.history.push({ type: "group", text: `Передана в общий гараж группы «${group.name}»`, at: Date.now() });
    group.garage.push(car); group.log.push({ at: Date.now(), text: `${player.name} передал ${car.model} в общий гараж` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/garage/withdraw") {
    const group = player.groupId && groups.get(player.groupId); const index = group?.garage.findIndex((car) => car.id === body.carId) ?? -1;
    if (!group || index < 0) return json(res, 404, { error: "Машина не найдена в общем гараже" });
    const car = group.garage[index];
    if (!groupCan(player, "garage") && car.groupContributorId !== player.id) return json(res, 403, { error: "У вашей роли нет права забрать эту машину" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: "Личный гараж заполнен" });
    group.garage.splice(index, 1); player.garage.push(car);
    car.history.push({ type: "group", text: `${player.name} забрал автомобиль из общего гаража`, at: Date.now() });
    group.log.push({ at: Date.now(), text: `${player.name} забрал ${car.model} из общего гаража` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/garage/work") {
    const group = player.groupId && groups.get(player.groupId); const car = group?.garage.find((item) => item.id === body.carId);
    if (!group || !car) return json(res, 404, { error: "Машина не найдена в общем гараже" });
    if (!groupCan(player, "garage") && car.groupContributorId !== player.id) return json(res, 403, { error: "У вашей роли нет доступа к обслуживанию этой машины" });
    const mechanic = group.employees.find((employee) => employee.specialty === "mechanics");
    const diagnostician = group.employees.find((employee) => employee.specialty === "diagnostics");
    if (!mechanic && !diagnostician) return json(res, 400, { error: "Наймите механика или диагноста: NPC в группе пока некому работать" });
    const workCost = 8000;
    if (group.treasury < workCost) return json(res, 400, { error: `В общей кассе нужно ${workCost.toLocaleString("ru-RU")} ₽` });
    group.treasury -= workCost;
    ensureCarDefaults(car);
    const skill = Math.max(mechanic?.rating || 0, diagnostician?.rating || 0);
    const hidden = car.defects.filter((defect) => !car.publicDiscovered.includes(defect.code) && defect.skill + defect.equipmentLevel <= Math.ceil(skill / 25) + 2).slice(0, 2);
    hidden.forEach((defect) => { car.publicDiscovered.push(defect.code); if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code); });
    const repairable = mechanic && car.defects.find((defect) => car.discovered.includes(defect.code) && !defect.repaired && defect.category !== "documents");
    if (repairable) { repairable.repaired = true; car.condition = Math.min(100, car.condition + repairable.severity * 3); car.repairs.push(repairable.name); car.invested += workCost; }
    car.history.push({ type: "group", text: `Сотрудники группы провели обслуживание${repairable ? `: ${repairable.name}` : " и диагностику"}`, at: Date.now() });
    group.log.push({ at: Date.now(), text: `${player.name} отправил ${car.model} к сотрудникам группы` });
    group.rating = clamp(group.rating + (hidden.length || repairable ? 1 : 0), 0, 100);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/employee/hire") {
    const group = player.groupId && groups.get(player.groupId);
    if (!group || !groupCan(player, "hire")) return json(res, 403, { error: "Нанимать сотрудников может владелец или управляющий" });
    const candidate = employeeCandidates.find((employee) => employee.id === body.employeeId);
    if (!candidate) return json(res, 404, { error: "Кандидат больше недоступен" });
    if (group.employees.some((employee) => employee.id === candidate.id)) return json(res, 400, { error: "Этот сотрудник уже работает в группе" });
    if (group.treasury < candidate.hireCost) return json(res, 400, { error: "В общей кассе недостаточно денег" });
    group.treasury -= candidate.hireCost; group.employees.push({ ...candidate, hiredAt: Date.now(), employerId: player.id });
    group.log.push({ at: Date.now(), text: `${player.name} нанял: ${candidate.name}, ${candidate.title}` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/parts/sell") {
    const type = body.type === "premium" ? "premium" : "common";
    if (player.parts[type] < 1) return json(res, 400, { error: "На складе нет такой детали" });
    player.parts[type] -= 1; publishPartLot(type, "used", type === "premium" ? 26000 : 11000, player.name);
    player.cash += type === "premium" ? 26000 : 11000; broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/parts/buy-market") {
    const lot = partsMarket.find((item) => item.id === body.partId);
    if (!lot) return json(res, 404, { error: "Лот запчастей уже продан" });
    if (player.cash < lot.price) return json(res, 400, { error: "Не хватает денег на запчасть" });
    if (lot.sellerId === player.id) return json(res, 400, { error: "Нельзя купить собственный лот" });
    player.cash -= lot.price; player.partInventory.push(lot.item); player.parts[lot.type] += 1; player.stats.partsBought += 1;
    const seller = lot.sellerId && players.get(lot.sellerId);
    if (seller) seller.cash += Math.round(lot.price * 0.95);
    partsSalesHistory.push({ component: lot.item.component, model: lot.item.compatibleModel, price: lot.price, buyer: player.name, at: Date.now() });
    partsMarket.splice(partsMarket.indexOf(lot), 1);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/parts/list") {
    const index = player.partInventory.findIndex((part) => part.id === body.inventoryPartId); const price = Math.round(Number(body.price));
    if (index < 0) return json(res, 404, { error: "Деталь не найдена на складе" });
    if (!Number.isFinite(price) || price < 1 || price > 1000000) return json(res, 400, { error: "Цена детали должна быть от 1 ₽ до 1 000 000 ₽" });
    const part = player.partInventory.splice(index, 1)[0];
    player.parts[partStockType(part)] = Math.max(0, player.parts[partStockType(part)] - 1);
    publishPartLot(part, part.conditionPct < 100 ? "used" : "new", price, player.name, player.id);
    player.stats.partsSold += 1;
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/car/dismantle") {
    const index = player.garage.findIndex((car) => car.id === body.carId);
    if (index < 0) return json(res, 404, { error: "Машина не найдена в гараже" });
    const car = player.garage[index]; const payout = partsValue(car);
    const componentPool = ["engine", "chassis", "body", "electrics", "tires"];
    const salvaged = componentPool.slice().sort(() => Math.random() - 0.5).slice(0, Math.max(2, Math.min(4, car.defects.length + 1)))
      .map((component) => makePart(component, Math.random() < 0.22 ? "original" : "restored", randomInt(42, Math.max(48, car.condition)), car.className, car.model));
    player.garage.splice(index, 1); player.cash += Math.round(payout * 0.38); player.parts.common += salvaged.length; player.partInventory.push(...salvaged);
    car.history.push({ type: "dismantled", text: `Разобрана на запчасти, получено ${Math.round(payout * 0.62)} ₽`, at: Date.now() });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/buy") {
    const car = market.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Лот уже продан или снят с рынка. Обновите список автомобилей." });
    if (car.sellerId === player.id) return json(res, 400, { error: "Это ваше объявление" });
    if (car.saleType === "auction") return json(res, 400, { error: "Эту машину можно купить только через ставку" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: `Гараж заполнен: ${player.garage.length}/${player.garageCapacity}. Продайте или разберите автомобиль.` });
    if (player.cash - reservedCash(player) < car.price) return json(res, 400, { error: `Не хватает свободных денег: нужно ${car.price.toLocaleString("ru-RU")} ₽, доступно ${(player.cash - reservedCash(player)).toLocaleString("ru-RU")} ₽.` });
    if (!completeSale(car, player, car.price)) return json(res, 409, { error: "Лот только что купил другой игрок. Обновите рынок." });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/check") {
    const car = player.garage.find((item) => item.id === body.carId);
    const category = String(body.category || "");
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    if (!inspectionRequirements[category]) return json(res, 400, { error: "Неизвестная система автомобиля" });
    ensureCarDefaults(car);
    if (car.serviceDiagnosed) return json(res, 400, { error: "Сервис уже выдал полное заключение" });
    const requirement = inspectionRequirements[category];
    const score = player.skills[requirement.skill] + player.equipment[requirement.equipment];
    const previous = car.inspectionRecords[category];
    if (previous && score <= previous.bestScore) return json(res, 400, { error: "Для повторной проверки сначала повысьте навык или оборудование" });
    const cost = 1500;
    if (player.cash < cost) return json(res, 400, { error: "Не хватает денег на расходники" });
    player.cash -= cost;
    player.stats.inspections += 1;
    car.invested += cost;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.discovered.includes(defect.code));
    for (const defect of found) if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
    const confidence = Math.min(100, Math.round(score / 6 * 100));
    car.inspectionRecords[category] = { bestScore: score, attempts: (previous?.attempts || 0) + 1, confidence, foundCodes: found.map((defect) => defect.code) };
    car.checkedCategories = Object.keys(car.inspectionRecords);
    addXp(player, 20 + newFound.length * 15);
    broadcast();
    return json(res, 200, { ...snapshot(player), checkResult: { category, found: newFound.map(publicDefect), confidence, improvedFrom: previous?.bestScore || 0, canImprove: score < 6 } });
  }

  if (req.method === "POST" && pathname === "/api/market-check") {
    const car = market.find((item) => item.id === body.carId);
    const category = String(body.category || "");
    if (!car) return json(res, 404, { error: "Автомобиль уже ушёл с рынка" });
    if (!inspectionRequirements[category]) return json(res, 400, { error: "Неизвестная система автомобиля" });
    ensureCarDefaults(car);
    const requirement = inspectionRequirements[category];
    const score = player.skills[requirement.skill] + player.equipment[requirement.equipment];
    const previous = car.publicInspectionRecords[category];
    if (previous && score <= previous.bestScore) return json(res, 400, { error: "Эту систему уже проверили на доступной глубине" });
    const cost = 1000;
    if (player.cash < cost) return json(res, 400, { error: "Нужны 1 000 ₽ на осмотр и расходники" });
    player.cash -= cost;
    player.stats.inspections += 1;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.publicDiscovered.includes(defect.code));
    for (const defect of found) if (!car.publicDiscovered.includes(defect.code)) car.publicDiscovered.push(defect.code);
    const confidence = Math.min(100, Math.round(score / 6 * 100));
    car.publicInspectionRecords[category] = { bestScore: score, confidence, inspector: player.name, at: Date.now() };
    addXp(player, 12 + newFound.length * 10);
    broadcast();
    return json(res, 200, { ...snapshot(player), checkResult: { category, found: newFound.map(publicDefect), confidence } });
  }

  if (req.method === "POST" && pathname === "/api/service-diagnostic") {
    const car = player.garage.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    if (car.serviceDiagnosed) return json(res, 400, { error: "Полная диагностика уже проведена" });
    const cost = serviceDiagnosticPrice(player, car);
    if (player.cash < cost) return json(res, 400, { error: "Не хватает денег на диагностику в сервисе" });
    player.cash -= cost;
    player.stats.serviceDiagnostics += 1;
    car.invested += cost;
    car.serviceDiagnosed = true;
    car.checkedCategories = inspectionCategories();
    for (const category of inspectionCategories()) car.inspectionRecords[category] = { bestScore: 6, attempts: (car.inspectionRecords[category]?.attempts || 0) + 1, confidence: 100, foundCodes: car.defects.filter((defect) => defect.category === category).map((defect) => defect.code) };
    for (const defect of car.defects) if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
    addXp(player, 10);
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/repair") {
    const car = player.garage.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    const defect = car.defects.find((item) => item.code === body.defect && !item.repaired && car.discovered.includes(item.code));
    if (!defect) return json(res, 404, { error: "Сначала обнаружьте эту неисправность" });
    const requirements = publicDefect(defect);
    const selfRepair = body.mode === "self";
    const assistedRepair = body.mode === "assisted";
    let repairCost = defect.repair;
    if (selfRepair || assistedRepair) {
      if (!requirements.selfRepairable) return json(res, 400, { error: "Эту проблему нельзя законно устранить самостоятельно" });
      const skillLevel = selfRepair ? requirements.repairSkillLevel : requirements.assistedSkillLevel;
      const equipmentLevel = selfRepair ? requirements.repairEquipmentLevel : requirements.assistedEquipmentLevel;
      if (player.skills[requirements.repairSkill] < skillLevel) return json(res, 400, { error: `Нужна профессия «${skillInfo[requirements.repairSkill].name}» уровня ${skillLevel}` });
      if (player.equipment[requirements.repairEquipment] < equipmentLevel) return json(res, 400, { error: `Нужен комплект «${equipmentInfo[requirements.repairEquipment].name}» уровня ${equipmentLevel}` });
      repairCost = selfRepair ? requirements.selfRepairCost : requirements.assistedRepairCost;
    }
    const mechanicDiscount = groupEmployeeRating(player, "mechanics") / 100 * (selfRepair ? 0.08 : 0.18);
    repairCost = Math.max(500, Math.round(repairCost * (1 - mechanicDiscount) / 500) * 500);
    let installedPart = null;
    if (body.partId) {
      const partIndex = player.partInventory.findIndex((part) => part.id === body.partId);
      if (partIndex < 0) return json(res, 404, { error: "Выбранная деталь не найдена на складе" });
      const part = player.partInventory[partIndex];
      if (![defect.category, "universal"].includes(part.component)) return json(res, 400, { error: "Эта деталь не подходит для выбранного узла" });
      if (!["all", car.className].includes(part.compatibleClass)) return json(res, 400, { error: "Деталь несовместима с классом автомобиля" });
      if (part.compatibleModel && part.compatibleModel !== "all" && part.compatibleModel !== car.model) return json(res, 400, { error: `Деталь предназначена для модели ${part.compatibleModel}` });
      if (defect.partName && !part.name.includes(defect.partName)) return json(res, 400, { error: `Для ремонта нужна деталь «${defect.partName}»` });
      installedPart = player.partInventory[partIndex];
      repairCost = Math.max(500, Math.round((repairCost - installedPart.estimatedValue * 0.65) / 500) * 500);
    }
    if (player.cash < repairCost) return json(res, 400, { error: "Не хватает денег на ремонт" });
    if (installedPart) {
      player.partInventory.splice(player.partInventory.findIndex((part) => part.id === installedPart.id), 1);
      player.parts[partStockType(installedPart)] = Math.max(0, player.parts[partStockType(installedPart)] - 1);
    }
    player.cash -= repairCost;
    car.invested += repairCost;
    defect.repaired = true;
    car.condition = Math.min(100, car.condition + defect.severity * 4);
    car.repairs.push(defect.name);
    if (installedPart) car.installedParts.push(installedPart);
    car.history.push({ type: "repair", text: `Ремонт: ${defect.name}${installedPart ? ` · установлена деталь «${installedPart.name}», ресурс ${installedPart.conditionPct}%` : ""}`, at: Date.now() });
    if (selfRepair) player.stats.selfRepairs += 1;
    else if (assistedRepair) player.stats.assistedRepairs += 1;
    else player.stats.workshopRepairs += 1;
    addXp(player, (selfRepair ? 60 : assistedRepair ? 40 : 25) + defect.severity * 10);
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/skill") {
    const skill = String(body.skill || "");
    if (!skillInfo[skill]) return json(res, 400, { error: "Навык не найден" });
    if (player.skillPoints < 1) return json(res, 400, { error: "Нет свободных очков навыков" });
    if (player.skills[skill] >= skillInfo[skill].maxLevel) return json(res, 400, { error: "Профессия уже максимального уровня" });
    player.skillPoints -= 1;
    player.skills[skill] += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/training") {
    const now = Date.now(); const cooldown = 45000;
    if (now - player.training.lastAt < cooldown) return json(res, 429, { error: `Следующее задание будет доступно через ${Math.ceil((cooldown - (now - player.training.lastAt)) / 1000)} сек.` });
    player.training.lastAt = now; player.training.completed += 1;
    player.cash += 7000; addXp(player, 75);
    if (player.training.completed % 4 === 0) player.skillPoints += 1;
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/equipment") {
    const equipment = String(body.equipment || "");
    const info = equipmentInfo[equipment];
    if (!info) return json(res, 400, { error: "Оборудование не найдено" });
    const nextLevel = player.equipment[equipment] + 1;
    if (nextLevel > 3) return json(res, 400, { error: "Оборудование уже максимального уровня" });
    const price = info.prices[nextLevel];
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на оборудование" });
    player.cash -= price;
    player.equipment[equipment] = nextLevel;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/garage/expand") {
    if (player.garageCapacity >= GARAGE_CAPACITY_MAX) return json(res, 400, { error: "Гараж уже максимального размера" });
    const price = 140000 + (player.garageCapacity - MAX_GARAGE) * 65000;
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на расширение гаража" });
    player.cash -= price;
    player.garageCapacity += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/parts/buy") {
    const type = body.type === "premium" ? "premium" : "common";
    const model = catalog.some((item) => item.model === body.model) ? body.model : catalog[randomInt(0, catalog.length - 1)].model;
    const price = type === "premium" ? 42000 : 18000;
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на комплект деталей" });
    player.cash -= price;
    player.parts[type] += 1; player.stats.partsBought += 1;
    player.partInventory.push(makePart(["engine", "chassis", "body", "electrics", "tires"][randomInt(0, 4)], type === "premium" ? "original" : "analog", 100, "all", model));
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/parts/order") {
    const car = player.garage.find((item) => item.id === body.carId); const defect = car?.defects.find((item) => item.code === body.defect);
    if (!car || !defect || !defect.partName) return json(res, 404, { error: "Для этой неисправности отдельная деталь не требуется" });
    const quality = body.quality === "original" ? "original" : "analog"; const part = makeSpecificPart(car, defect, quality);
    const price = Math.round(part.estimatedValue * (quality === "original" ? 1.15 : 1));
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на заказ детали" });
    player.cash -= price; player.partInventory.push(part); player.parts[partStockType(part)] += 1; player.stats.partsBought += 1;
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/car/upgrade") {
    const car = player.garage.find((item) => item.id === body.carId);
    const upgrade = upgradeCatalog.find((item) => item.key === body.upgrade);
    if (!car || !upgrade) return json(res, 404, { error: "Автомобиль или улучшение не найдено" });
    ensureCarDefaults(car);
    if (car.upgrades.includes(upgrade.key)) return json(res, 400, { error: "Это улучшение уже установлено" });
    const canSelf = player.skills[upgrade.skill] >= upgrade.skillLevel && player.equipment[upgrade.equipment] >= upgrade.equipmentLevel;
    const upgradeCost = canSelf ? upgrade.cost : Math.round(upgrade.cost * 1.55 / 1000) * 1000;
    if (player.cash < upgradeCost) return json(res, 400, { error: "Не хватает денег на улучшение" });
    player.cash -= upgradeCost;
    car.invested += upgradeCost;
    car.upgrades.push(upgrade.key);
    car.upgradeStage = car.upgrades.length;
    car.upgradeValue += upgrade.value;
    car.condition = Math.min(100, car.condition + upgrade.condition);
    car.history.push({ type: "upgrade", text: `${upgrade.name}${canSelf ? " самостоятельно" : " в тюнинг-ателье"}: +${upgrade.value.toLocaleString("ru-RU")} ₽ к ценности`, at: Date.now() });
    player.stats.upgrades += 1;
    addXp(player, 55 + upgrade.skillLevel * 15);
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/list") {
    const index = player.garage.findIndex((item) => item.id === body.carId);
    if (index < 0) return json(res, 404, { error: "Машины нет в гараже" });
    const price = Math.round(Number(body.price));
    if (!Number.isFinite(price) || price < 1 || price > 150000000) return json(res, 400, { error: "Цена должна быть от 1 ₽ до 150 000 000 ₽" });
    const car = player.garage[index];
    const saleType = body.saleType === "auction" ? "auction" : "fixed";
    car.price = price;
    car.seller = player.name;
    car.sellerId = player.id;
    car.description = String(body.description || "").trim().slice(0, 120) || "Осмотр у гаража, разумный торг.";
    car.listedAt = Date.now();
    car.marketTag = null;
    car.history.push({ type: "listed", text: `Выставлено игроком ${player.name} за ${price} ₽`, at: Date.now() });
    car.saleType = saleType;
    if (saleType === "auction") {
      const durationSeconds = clamp(Math.round(Number(body.durationSeconds) || 300), 2, 86400);
      car.startingPrice = price;
      car.auctionEnd = Date.now() + durationSeconds * 1000;
      car.highestBid = 0;
      car.highestBidderId = null;
      car.highestBidderName = null;
      car.highestBidderType = null;
      car.bidCount = 0;
      car.participantIds = [];
    } else {
      car.startingPrice = null;
      car.auctionEnd = null;
      car.highestBid = 0;
      car.highestBidderId = null;
      car.highestBidderName = null;
      car.highestBidderType = null;
      car.bidCount = 0;
      car.participantIds = [];
    }
    player.garage.splice(index, 1);
    market.unshift(car);
    broadcast();
    if (saleType === "fixed") scheduleBots(car);
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/unlist") {
    const index = market.findIndex((item) => item.id === body.carId && item.sellerId === player.id);
    if (index < 0) return json(res, 404, { error: "Ваше объявление не найдено" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: "В гараже нет места" });
    const car = market[index];
    if (car.saleType === "auction" && car.highestBidderId) return json(res, 400, { error: "Нельзя снять аукцион после первой ставки" });
    market.splice(index, 1);
    player.garage.push(car);
    for (const offer of offers.values()) if (offer.carId === car.id && ["active", "counter"].includes(offer.status)) offer.status = "closed";
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/bid") {
    const car = market.find((item) => item.id === body.carId && item.saleType === "auction");
    if (!car || car.auctionEnd <= Date.now()) return json(res, 404, { error: "Аукцион уже завершён" });
    if (car.sellerId === player.id) return json(res, 400, { error: "Нельзя делать ставки на свою машину" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: "Освободите место в гараже перед ставкой" });
    const amount = Math.round(Number(body.amount));
    const current = car.highestBid || car.startingPrice;
    const minimum = car.highestBid ? current + Math.max(1, Math.ceil(current * 0.01)) : current;
    if (!Number.isFinite(amount) || amount < minimum) return json(res, 400, { error: `Минимальная ставка: ${minimum} ₽` });
    const ownReservation = car.highestBidderId === player.id ? car.highestBid : 0;
    if (amount > player.cash - reservedCash(player) + ownReservation) return json(res, 400, { error: "Недостаточно свободных денег для этой ставки" });
    const previousPlayerId = car.highestBidderType === "player" && car.highestBidderId !== player.id ? car.highestBidderId : null;
    car.highestBid = amount;
    car.highestBidderId = player.id;
    car.highestBidderName = player.name;
    car.highestBidderType = "player";
    car.price = amount;
    car.bidCount += 1;
    if (!car.participantIds.includes(player.id)) car.participantIds.push(player.id);
    if (previousPlayerId) notifyOutbid(previousPlayerId, "car", car.model, amount, car.id);
    player.stats.bids += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/container/bid") {
    const auction = containerAuctions.find((item) => item.id === body.containerId);
    if (!auction || auction.endAt <= Date.now()) return json(res, 404, { error: "Аукцион контейнера завершён" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: "Освободите место в гараже перед ставкой" });
    const current = auction.highestBid || auction.startingPrice;
    const minimum = auction.highestBid ? current + Math.max(1000, Math.ceil(current * 0.02)) : current;
    const amount = Math.round(Number(body.amount)); const ownReservation = auction.highestBidderId === player.id ? auction.highestBid : 0;
    if (!Number.isFinite(amount) || amount < minimum) return json(res, 400, { error: `Минимальная ставка: ${minimum.toLocaleString("ru-RU")} ₽` });
    if (amount > player.cash - reservedCash(player) + ownReservation) return json(res, 400, { error: "Недостаточно свободных денег для ставки" });
    const previousPlayerId = auction.highestBidderType === "player" && auction.highestBidderId !== player.id ? auction.highestBidderId : null;
    auction.participantIds ||= [];
    auction.highestBid = amount; auction.highestBidderId = player.id; auction.highestBidderName = player.name; auction.highestBidderType = "player"; auction.bidCount += 1; player.stats.bids += 1;
    if (!auction.participantIds.includes(player.id)) auction.participantIds.push(player.id);
    if (previousPlayerId) notifyOutbid(previousPlayerId, "container", auction.name, amount, auction.id);
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer") {
    const car = market.find((item) => item.id === body.carId);
    const amount = Math.round(Number(body.amount));
    if (!car || !car.sellerId || car.saleType === "auction") return json(res, 404, { error: "Торг доступен только в обычном объявлении другого игрока" });
    if (car.sellerId === player.id) return json(res, 400, { error: "Нельзя торговаться с собой" });
    if (!Number.isFinite(amount) || amount < 1 || amount >= car.price) return json(res, 400, { error: "Предложение должно быть от 1 ₽ и ниже цены объявления" });
    if (amount > player.cash - reservedCash(player)) return json(res, 400, { error: "Свободных денег недостаточно: часть суммы зарезервирована в ставках" });
    for (const old of offers.values()) if (old.carId === car.id && old.buyerId === player.id && ["active", "counter"].includes(old.status)) old.status = "closed";
    const offer = { id: id("offer_"), carId: car.id, sellerId: car.sellerId, buyerId: player.id, buyerName: player.name, buyerType: "player", amount, status: "active", reason: "Предложение другого игрока", createdAt: Date.now() };
    offers.set(offer.id, offer);
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer/respond") {
    const offer = offers.get(body.offerId);
    if (!offer || offer.sellerId !== player.id || !["active", "counter"].includes(offer.status)) return json(res, 404, { error: "Предложение уже недоступно" });
    const car = market.find((item) => item.id === offer.carId);
    if (!car) return json(res, 404, { error: "Автомобиль уже продан" });
    if (body.action === "reject") offer.status = "rejected";
    else if (body.action === "counter") {
      const amount = Math.round(Number(body.amount));
      if (offer.buyerType === "bot") {
        if (!Number.isFinite(amount) || amount <= offer.amount || amount >= car.price) return json(res, 400, { error: "Встречная цена должна быть между предложением и ценой объявления" });
        const botAccepts = amount <= offer.amount * 1.055;
        if (botAccepts) completeSale(car, null, amount);
        else { offer.status = "rejected"; offer.reason = "Покупатель отказался от встречной цены."; }
      } else {
        if (!Number.isFinite(amount) || amount <= offer.amount || amount >= car.price) return json(res, 400, { error: "Встречная цена должна быть между предложением и ценой объявления" });
        offer.amount = amount;
        offer.status = "counter";
        offer.reason = "Продавец предложил встречную цену";
      }
    } else if (body.action === "accept") {
      if (offer.buyerType === "bot") completeSale(car, null, offer.amount);
      else {
        const buyer = players.get(offer.buyerId);
        if (!buyer || buyer.cash - reservedCash(buyer) < offer.amount || !completeSale(car, buyer, offer.amount)) return json(res, 400, { error: "У покупателя недостаточно свободных денег или места" });
      }
    } else return json(res, 400, { error: "Неизвестный ответ" });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer/accept-counter") {
    const offer = offers.get(body.offerId);
    if (!offer || offer.buyerId !== player.id || offer.status !== "counter") return json(res, 404, { error: "Встречное предложение недоступно" });
    const car = market.find((item) => item.id === offer.carId);
    if (!car || player.cash - reservedCash(player) < offer.amount || !completeSale(car, player, offer.amount)) return json(res, 400, { error: "Не хватает свободных денег или места в гараже" });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  return json(res, 404, { error: "Команда не найдена" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname);
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    console.error(error);
    json(res, 500, { error: "Ошибка сервера" });
  }
});

server.listen(PORT, "0.0.0.0", () => console.log(`Perekup Market: http://0.0.0.0:${PORT}`));

function shutdown(signal) {
  console.log(`${signal}: saving game state`);
  persistState();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
