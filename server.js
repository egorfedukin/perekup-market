const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { cosmetics, stylePackages, profileAppearance, ownsCosmetic, paymentMatches, grantPurchase } = require("./cosmetics");
const { acquisitionPrice, buyerPrice } = require("./economy");
const { vehicleRule, vehicleName } = require("./vehicle-rules");
const { randomInspectionSkills, npcFaults, saleBlockReason } = require('./trade-rules');
const { createInspection, gradeInspection } = require("./inspection");
const inspectionSessions = new Map();
const { prerequisites, requiredSkillLevel, workplaceBenefits, npcProfile, npcFit, negotiate } = require("./progression");
const balance = require("./balance");
const fraud = require("./fraud");
const bank = require("./bank");
function useWorkplace(player, roles) {
  for (const asset of player?.ownedAssets || []) if (asset.rentalStatus === "workplace" && roles.includes(asset.propertyRole)) asset.maintenance = Math.max(20, (asset.maintenance ?? 100) - 1);
}

function inspectionResult(player, car, category, body, quote) {
  if (!body.challengeId) return { depth: quote.depth, accuracy: quote.confidence };
  const session = inspectionSessions.get(player.id);
  if (!session || session.id !== body.challengeId || session.carId !== car.id || session.category !== category || session.method !== body.method || session.expires < Date.now()) throw new Error("Осмотр устарел. Начните проверку заново");
  const skill = player.skills[inspectionRequirements[category].skill] || 0;
  const grade = gradeInspection(session.challenge, body.answers, skill);
  inspectionSessions.delete(player.id);
  return { depth: Math.min(8, quote.depth + grade.bonus), accuracy: grade.accuracy };
}
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4173);
const MAX_ADMIN_VALUE = Number.MAX_SAFE_INTEGER;
const PUBLIC_DIR = path.join(__dirname, "public");
// Игрок стартует с 50 000 ₽: весь ранний баланс (стартовый сегмент рынка, льготы на
// услуги, награды контрактов, кредиты) выстроен вокруг этой цифры — см. balance.js.
const STARTING_CASH = balance.STARTING_CASH;
const MAX_GARAGE = 4;
const BOT_BID_CHANCE = process.env.PEREKUP_BOT_ALWAYS === "1" ? 1 : 0.48;
const AUCTION_EXTENSION_MS = Math.max(1000, Number(process.env.PEREKUP_ANTI_SNIPE_MS) || 30000);
const NPC_ROTATION_MS = Math.max(60000, Number(process.env.PEREKUP_ROTATION_MS) || 180000);
const NPC_ROTATION_COUNT = 10;
// Мошенничество: кулдаун серых схем, скорость остывания подозрения и длительность блока рынка.
const FRAUD_FAST = process.env.PEREKUP_FRAUD_FAST === "1";
// Доля обманных лотов на рынке: по умолчанию считается по цене и состоянию, тесты могут задать свою.
const FRAUD_RATE = process.env.PEREKUP_FRAUD_RATE === undefined ? null : Math.max(0, Math.min(1, Number(process.env.PEREKUP_FRAUD_RATE)));
// Доля «покупателей», приходящих с разводом на предоплате. По умолчанию — по репутации и уровню продавца.
const SCAM_RATE = process.env.PEREKUP_SCAM_RATE === undefined ? null : Math.max(0, Math.min(1, Number(process.env.PEREKUP_SCAM_RATE)));
const FRAUD_SCHEME_COOLDOWN_MS = FRAUD_FAST ? 0 : 45000;
const FRAUD_BLOCK_MS = FRAUD_FAST ? 5000 : 10 * 60000;
const FRAUD_RAID_INTERVAL_MS = FRAUD_FAST ? 500 : 15000;
const FRAUD_EXPOSE_COOLDOWN_MS = FRAUD_FAST ? 0 : 20000;
const GROUP_JOB_TIME_SCALE = process.env.PEREKUP_FAST_JOBS === "1" ? 0.02 : 1;
const ASSET_INCOME_CYCLE_MS = process.env.PEREKUP_FAST_ASSETS === "1" ? 600 : 60000;
const TRAINING_REWARD_CASH = Math.max(0, Number(process.env.PEREKUP_TRAINING_REWARD_CASH ?? 7000));
const REFERRAL_BONUS_CASH = Math.max(0, Number(process.env.PEREKUP_REFERRAL_BONUS_CASH ?? 15000));
const REFERRAL_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ADMIN_NAMES = new Set(String(process.env.PEREKUP_ADMIN_NAMES || "Егор пк, federuk-new").split(",").map((name) => name.trim().toLocaleLowerCase("ru-RU")).filter(Boolean));
const CONFIGURED_ADMIN_LOGIN = "federuk";
const CONFIGURED_ADMIN_EMAIL = "fedukinegor@gmail.com";
const FALLBACK_ADMIN_LOGIN = "marketadmin";
const FALLBACK_ADMIN_PASSWORD = "MarketAdmin2026!";
const FALLBACK_ADMIN_TOKEN = "perekup-fixed-admin-session-v1";
const ALLOW_FALLBACK_ADMIN = process.env.NODE_ENV !== "production";
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const PUBLIC_URL = String(process.env.PEREKUP_PUBLIC_URL || "https://perekup-market.ru").replace(/\/$/, "");
const requestedAdProvider = String(process.env.PEREKUP_AD_PROVIDER ?? "sape").trim().toLowerCase();
const AD_PROVIDER = ["yandex", "adsense", "sape"].includes(requestedAdProvider) ? requestedAdProvider : "";
const PUBLIC_AD_CONFIG = {
  provider: AD_PROVIDER,
  marketSlot: process.env.PEREKUP_AD_MARKET_SLOT || "",
  garageSlot: process.env.PEREKUP_AD_GARAGE_SLOT || "",
  adsenseClient: process.env.PEREKUP_ADSENSE_CLIENT || "",
  sapeScript: process.env.PEREKUP_SAPE_SCRIPT || "https://cdn-rtb.sape.ru/rtb-b/js/u/997/873974997.js",
  sapeTag: process.env.PEREKUP_SAPE_TAG || "srtb-tag-873974997"
};
const ADS_TXT = String(process.env.PEREKUP_ADS_TXT || "").trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const AUTH_FROM_EMAIL = String(process.env.AUTH_FROM_EMAIL || "Рынок <onboarding@resend.dev>").trim();
const cashPackages = [
  { id: "starter", rubles: 20, cash: 40000, name: "Пробный заезд", tag: "Поддержка", description: "Небольшой запас на первую диагностику и торг", benefits: ["Проверить первый лот", "Статус Бронза в профиле"], bonus: "+ статус Бронза", supporterTier: "bronze" },
  { id: "dealer", rubles: 79, cash: 220000, name: "Первый оборот", tag: "Старт", description: "На ремонт бюджетной машины и выгодную перепродажу", benefits: ["Диагностика и ремонт", "Участие в торгах"], bonus: "+ статус Серебро", supporterTier: "silver" },
  { id: "business", rubles: 199, cash: 650000, name: "Гараж дилера", tag: "Популярный", description: "Запас на несколько сделок и развитие гаража", benefits: ["Автомобили среднего сегмента", "Номера и обслуживание"], bonus: "+ статус Золото", supporterTier: "gold", popular: true },
  { id: "holding", rubles: 499, cash: 1900000, name: "Большой гараж", tag: "Для активной игры", description: "Капитал для дорогих лотов, торгов и недвижимости", benefits: ["Премиальные автомобили", "Покупка доходного объекта"], bonus: "+ статус Платина", supporterTier: "platinum" },
  { id: "founder", rubles: 999, cash: 4500000, name: "Партнёр рынка", tag: "Максимум", description: "Большой запас для коллекционных машин и собственного холдинга", benefits: ["Коллекционные автомобили", "Статус Партнёр в чате"], bonus: "+ статус Партнёр", supporterTier: "founder" }
];
const supporterTierRank = { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4, founder: 5 };
const supporterTierBenefits = { none: [], bronze: ["Бронзовый бейдж в профиле и чате"], silver: ["Серебряный бейдж", "Приоритетный цвет имени в чате"], gold: ["Золотой бейдж", "Выделение профиля среди участников"], platinum: ["Платиновый бейдж", "Особая отметка постоянного партнёра"], founder: ["Бейдж партнёра", "Особая отметка раннего участника проекта"] };
const s3Sync = require("./s3-sync");
function resolveDataDir() {
  const preferred = process.env.PEREKUP_DATA_DIR ? path.resolve(process.env.PEREKUP_DATA_DIR) : path.join(__dirname, "data");
  for (const candidate of [preferred, "/tmp/perekup-data"]) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.writeFileSync(path.join(candidate, ".write-probe"), String(Date.now()), "utf8");
      return candidate;
    } catch (error) {
      console.warn(`DATA_DIR_UNAVAILABLE: ${candidate} (${error.code || error.message})`);
    }
  }
  throw new Error("Нет доступного каталога для базы данных: проверьте PEREKUP_DATA_DIR и права на запись");
}
const DATA_DIR = resolveDataDir();
const preferredDataDir = process.env.PEREKUP_DATA_DIR ? path.resolve(process.env.PEREKUP_DATA_DIR) : path.join(__dirname, "data");
if (DATA_DIR !== preferredDataDir) console.warn(`DATA_DIR_FALLBACK: используем ${DATA_DIR}. Без PEREKUP_S3_* данные исчезнут при перезапуске контейнера`);
const DB_PATH = path.join(DATA_DIR, "game.db");
let s3SyncDirty = false;
function hasSavedRow(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    const probe = new DatabaseSync(filePath);
    try { return Boolean(probe.prepare("SELECT 1 FROM game_state WHERE id = 1").get()); }
    finally { probe.close(); }
  } catch { return false; }
}
function restoreSnapshotFromS3() {
  const restore = s3Sync.restoreSync(DB_PATH);
  if (restore.restored) {
    if (hasSavedRow(DB_PATH)) { console.log(`S3_RESTORE_OK: база восстановлена из ${s3Sync.describeTarget()}`); return true; }
    console.warn("S3_RESTORE_INVALID: файл из хранилища не похож на базу игры, начинаем с чистой базы");
    try { fs.rmSync(DB_PATH, { force: true }); } catch {}
  } else if (restore.missing) console.log(`S3_RESTORE_EMPTY: в ${s3Sync.describeTarget()} снимка пока нет, начинаем с чистой базы`);
  else if (restore.error) console.warn(`S3_RESTORE_FAILED: ${restore.error}`);
  return false;
}
if (s3Sync.configured()) {
  if (hasSavedRow(DB_PATH)) console.log("S3_RESTORE_SKIP: локальная база уже содержит сохранение");
  else restoreSnapshotFromS3();
}
function quarantineCorruptDatabase(reason) {
  const backup = `${DB_PATH}.corrupt-${Date.now()}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.renameSync(DB_PATH + suffix, backup + suffix); }
    catch { try { fs.rmSync(DB_PATH + suffix, { force: true }); } catch {} }
  }
  console.warn(`DB_CORRUPT: база повреждена (${reason}). Файлы отложены как ${backup}.*, запускаемся с чистой базы или снимка из хранилища`);
}
function openDatabase() {
  for (let attempt = 0; ; attempt += 1) {
    let handle = null;
    try {
      handle = new DatabaseSync(DB_PATH);
      const check = handle.prepare("PRAGMA quick_check").get();
      const verdict = String((check && check.quick_check) || "ok").toLowerCase();
      if (verdict !== "ok") throw new Error(`quick_check: ${verdict}`);
      handle.exec("CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      // WAL устойчивее к внезапному завершению контейнера: основная база не ломается на середине записи
      handle.exec("PRAGMA journal_mode=WAL");
      handle.exec("PRAGMA synchronous=NORMAL");
      return handle;
    } catch (error) {
      if (handle) { try { handle.close(); } catch {} }
      if (attempt >= 2) throw error;
      console.warn(`DB_RECOVER: попытка открыть базу не удалась (${error.message}), восстанавливаем`);
      quarantineCorruptDatabase(error.message);
      if (s3Sync.configured()) restoreSnapshotFromS3();
    }
  }
}
const db = openDatabase();

const realVehicleSeeds = [
  ["Lada", "2107", "classic", 1988, 2012, 230000, ["1.5 MT", "1.6 MT"]], ["Lada", "Samara", "hatch", 1987, 2013, 280000, ["1.5 MT", "1.6 MT"]],
  ["Lada", "Niva Legend", "suv", 1995, 2026, 1150000, ["1.7 MT", "Bronto"]], ["Lada", "Granta", "sedan", 2012, 2026, 1100000, ["Standard", "Comfort", "Club"]],
  ["Lada", "Vesta", "sedan", 2015, 2026, 2100000, ["Comfort", "Life", "Techno", "Sport"]], ["Lada", "Largus", "wagon", 2012, 2026, 1900000, ["Classic", "Comfort", "Cross"]],
  ["UAZ", "Patriot", "suv", 2005, 2026, 2200000, ["Base", "Comfort", "Expedition"]], ["GAZ", "Sobol", "van", 2003, 2026, 2600000, ["Business", "4WD"]],
  ["Renault", "Logan", "sedan", 2005, 2022, 1050000, ["1.4 MT", "1.6 MT", "1.6 AT"]], ["Renault", "Duster", "suv", 2012, 2022, 1850000, ["1.6 MT", "2.0 4WD", "1.5 dCi"]],
  ["Volkswagen", "Polo", "sedan", 2010, 2022, 1600000, ["Trendline", "Comfortline", "Highline", "GT"]], ["Volkswagen", "Golf", "hatch", 1998, 2026, 2400000, ["1.4 TSI", "1.6 MPI", "GTI", "R"]],
  ["Volkswagen", "Passat", "sedan", 1997, 2026, 3300000, ["1.4 TSI", "1.8 TSI", "2.0 TDI", "R-Line"]], ["Volkswagen", "Tiguan", "suv", 2008, 2026, 4100000, ["1.4 TSI", "2.0 TSI 4Motion", "2.0 TDI"]],
  ["Skoda", "Rapid", "sedan", 2014, 2023, 1650000, ["Active", "Ambition", "Style"]], ["Skoda", "Octavia", "sedan", 2004, 2026, 2600000, ["1.6 MPI", "1.4 TSI", "2.0 TSI", "Scout"]],
  ["Hyundai", "Solaris", "sedan", 2011, 2026, 1750000, ["Active", "Comfort", "Elegance"]], ["Hyundai", "Creta", "suv", 2016, 2026, 2700000, ["1.6 AT", "2.0 AT 4WD", "Prime"]],
  ["Hyundai", "Santa Fe", "suv", 2006, 2026, 4900000, ["2.5 MPI", "2.2 CRDi", "Calligraphy"]], ["Kia", "Rio", "sedan", 2005, 2023, 1700000, ["Classic", "Comfort", "Prestige"]],
  ["Kia", "Ceed", "hatch", 2007, 2026, 2400000, ["1.6 AT", "GT-Line", "GT"]], ["Kia", "Sportage", "suv", 2005, 2026, 3600000, ["2.0 MPI", "2.4 GDI", "GT-Line"]],
  ["Toyota", "Corolla", "sedan", 1998, 2026, 2500000, ["1.6 CVT", "Comfort", "Prestige"]], ["Toyota", "Camry", "sedan", 1996, 2026, 4700000, ["2.0 AT", "2.5 AT", "3.5 V6", "GR Sport"]],
  ["Toyota", "RAV4", "suv", 1998, 2026, 5000000, ["2.0 CVT", "2.5 AT", "Hybrid"]], ["Toyota", "Land Cruiser Prado", "suv", 1996, 2026, 8500000, ["2.7 AT", "4.0 V6", "2.8 Diesel"]],
  ["Toyota", "Land Cruiser 300", "premium", 2021, 2026, 16500000, ["GR Sport", "ZX", "Executive"]], ["Lexus", "RX", "premium", 2003, 2026, 8200000, ["RX 300", "RX 350", "RX 450h", "F Sport"]],
  ["Nissan", "Almera", "sedan", 2000, 2018, 850000, ["1.5 MT", "1.6 AT", "Tekna"]], ["Nissan", "Qashqai", "suv", 2007, 2026, 3100000, ["1.2 DIG-T", "2.0 CVT", "4WD"]],
  ["Nissan", "X-Trail", "suv", 2001, 2026, 3900000, ["2.0 CVT", "2.5 CVT", "2.0 dCi"]], ["Mazda", "3", "hatch", 2004, 2026, 2700000, ["1.5 AT", "2.0 AT", "Sport"]],
  ["Mazda", "6", "sedan", 2003, 2026, 3400000, ["2.0 AT", "2.5 AT", "Executive"]], ["Mazda", "CX-5", "suv", 2012, 2026, 4300000, ["2.0 AT", "2.5 AT 4WD", "Executive"]],
  ["Honda", "Civic", "sedan", 1996, 2026, 2900000, ["1.5 Turbo", "2.0 CVT", "Type R"]], ["Honda", "CR-V", "suv", 1997, 2026, 4500000, ["2.0 CVT", "2.4 AT", "Hybrid"]],
  ["Mitsubishi", "Lancer", "sedan", 1996, 2017, 1100000, ["1.6 AT", "2.0 MT", "Evolution"]], ["Mitsubishi", "Pajero Sport", "suv", 1998, 2026, 5300000, ["2.4 Diesel", "3.0 V6", "Ultimate"]],
  ["Subaru", "Forester", "suv", 1998, 2026, 4600000, ["2.0 CVT", "2.5 CVT", "XT Turbo"]], ["Subaru", "WRX", "sedan", 2001, 2026, 6500000, ["WRX", "WRX STI", "Premium"]],
  ["Ford", "Focus", "hatch", 1999, 2022, 1500000, ["1.6 MT", "1.6 AT", "ST", "RS"]], ["Ford", "Mondeo", "sedan", 1997, 2022, 1900000, ["2.0 AT", "2.0 EcoBoost", "Titanium"]],
  ["Ford", "Kuga", "suv", 2008, 2026, 3300000, ["1.5 EcoBoost", "2.0 EcoBoost", "Titanium"]], ["Chevrolet", "Niva", "suv", 2003, 2020, 850000, ["L", "GLC", "LE+"]],
  ["Chevrolet", "Tahoe", "suv", 2000, 2026, 9800000, ["5.3 V8", "6.2 V8", "High Country"]], ["Opel", "Astra", "hatch", 1998, 2022, 1450000, ["1.6 AT", "1.4 Turbo", "OPC"]],
  ["Peugeot", "308", "hatch", 2008, 2026, 1900000, ["1.6 AT", "1.6 Turbo", "GT"]], ["Geely", "Coolray", "suv", 2020, 2026, 3000000, ["Comfort", "Luxury", "Flagship"]],
  ["Haval", "Jolion", "suv", 2021, 2026, 2900000, ["Comfort", "Elite", "Premium 4WD"]], ["Chery", "Tiggo 7 Pro", "suv", 2020, 2026, 3200000, ["Luxury", "Elite", "Ultimate"]],
  ["BMW", "3 Series", "sedan", 1995, 2026, 5200000, ["318i", "320i", "330i", "M340i"]], ["BMW", "5 Series", "premium", 1995, 2026, 7800000, ["520d", "530i", "540i", "M550i"]],
  ["BMW", "X5", "premium", 2000, 2026, 11500000, ["xDrive30d", "xDrive40i", "M50i", "M"]], ["Mercedes-Benz", "C-Class", "sedan", 1995, 2026, 5900000, ["C 180", "C 200", "C 300", "AMG C 43"]],
  ["Mercedes-Benz", "E-Class", "premium", 1995, 2026, 9000000, ["E 200", "E 220d", "E 450", "AMG E 53"]], ["Mercedes-Benz", "G-Class", "premium", 1995, 2026, 24000000, ["G 350d", "G 500", "AMG G 63"]],
  ["Audi", "A4", "sedan", 1996, 2026, 4800000, ["35 TFSI", "40 TFSI quattro", "S4", "RS 4"]], ["Audi", "A6", "premium", 1996, 2026, 7600000, ["40 TDI", "45 TFSI", "55 TFSI quattro", "RS 6"]],
  ["Audi", "Q7", "premium", 2006, 2026, 10500000, ["45 TDI", "55 TFSI", "S line"]], ["Volvo", "XC90", "premium", 2003, 2026, 9000000, ["D5", "T6", "T8 Recharge"]],
  ["Tesla", "Model 3", "electric", 2018, 2026, 5200000, ["RWD", "Long Range", "Performance"]], ["Tesla", "Model Y", "electric", 2020, 2026, 6200000, ["RWD", "Long Range", "Performance"]],
  ["Porsche", "Cayenne", "premium", 2003, 2026, 15000000, ["Cayenne", "S", "GTS", "Turbo"]], ["Porsche", "911", "coupe", 1997, 2026, 26000000, ["Carrera", "Carrera S", "Turbo S", "GT3"]],
  ["Land Rover", "Range Rover", "premium", 2002, 2026, 18000000, ["SE", "HSE", "Autobiography", "SV"]], ["Jeep", "Wrangler", "suv", 1997, 2026, 8500000, ["Sport", "Sahara", "Rubicon"]],
  ["Mini", "Cooper", "hatch", 2001, 2026, 3900000, ["Cooper", "Cooper S", "John Cooper Works"]], ["Bentley", "Continental GT", "premium", 2004, 2026, 32000000, ["V8", "Speed", "Mulliner"]],
  ["Ferrari", "Roma", "coupe", 2020, 2026, 48000000, ["Roma", "Spider"]], ["Lamborghini", "Urus", "premium", 2019, 2026, 52000000, ["Urus", "S", "Performante"]]
];
const VEHICLE_CATALOG_FILE = path.join(__dirname, "vehicle-catalog.tsv");
const VEHICLE_YEARS_FILE = path.join(__dirname, "vehicle-production-years.json");
const vehicleProductionYears = fs.existsSync(VEHICLE_YEARS_FILE) ? JSON.parse(fs.readFileSync(VEHICLE_YEARS_FILE, "utf8")) : {};
const vehicleMakeNames = [
  "Mercedes-Benz", "Alfa Romeo", "Land Rover", "Range Rover", "Rolls-Royce", "Aston Martin", "Great Wall",
  "Volkswagen", "Mitsubishi", "Chevrolet", "SsangYong", "Lamborghini", "Koenigsegg", "Oldsmobile",
  "Citroën", "Renault", "Peugeot", "Škoda", "Suzuki", "Hyundai", "Toyota", "Nissan", "Honda", "Mazda",
  "Subaru", "Chrysler", "Cadillac", "Infiniti", "Maserati", "Porsche", "Ferrari", "Bentley", "McLaren",
  "Bugatti", "Pagani", "Maybach", "Dacia", "Daewoo", "Fiat", "Opel", "SEAT", "Kia", "Lada", "Ford",
  "Volvo", "Jeep", "GMC", "Isuzu", "Chery", "Geely", "Haval", "BYD", "Acura", "Lexus", "Audi", "BMW",
  "Tesla", "Polestar", "Rivian", "Lucid", "Saab", "Rover", "Vauxhall", "Mercury", "Plymouth", "Holden",
  "Mini", "Smart", "Tata", "Proton", "Daihatsu", "Lotus", "Alpine", "Genesis", "Dodge", "Buick", "Pontiac", "MG"
].sort((a, b) => b.length - a.length);
const budgetMakes = new Set(["Lada", "Dacia", "Daewoo", "Proton", "Daihatsu", "Tata"]);
const valueMakes = new Set(["Fiat", "Renault", "Peugeot", "Citroën", "Škoda", "Suzuki", "Hyundai", "Kia", "Opel", "SEAT", "Vauxhall", "Chery", "Geely", "Haval", "BYD", "SsangYong"]);
const premiumMakes = new Set(["Audi", "BMW", "Mercedes-Benz", "Lexus", "Infiniti", "Acura", "Cadillac", "Lincoln", "Genesis", "Land Rover", "Range Rover", "Jaguar", "Alfa Romeo", "Maserati", "Tesla", "Polestar", "Rivian", "Lucid"]);
const exoticMakes = new Set(["Porsche", "Ferrari", "Lamborghini", "Bentley", "Rolls-Royce", "Aston Martin", "McLaren", "Bugatti", "Pagani", "Koenigsegg", "Lotus", "Alpine", "Maybach"]);
const VEHICLE_PRICING_VERSION = 8;
const MAX_VEHICLE_VALUE = 2000000000;

function parseVehicleCatalog() {
  if (!fs.existsSync(VEHICLE_CATALOG_FILE)) throw new Error(`Каталог автомобилей не найден: ${VEHICLE_CATALOG_FILE}`);
  const lines = fs.readFileSync(VEHICLE_CATALOG_FILE, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = lines.shift().split("\t");
  const column = (name) => headers.indexOf(name);
  const modelColumn = column("АВТОМОБИЛЬ");
  const photoColumn = column("ССЫЛКА_НА_ФОТО");
  const sourceColumn = column("ИСТОЧНИК");
  if (modelColumn < 0 || photoColumn < 0) throw new Error("В vehicle-catalog.tsv отсутствуют обязательные колонки");
  const seen = new Set();
  return lines.map((line) => {
    const cells = line.split("\t");
    const model = String(cells[modelColumn] || "").trim();
    const make = vehicleMakeNames.find((name) => model === name || model.startsWith(`${name} `)) || model.split(" ")[0];
    const priceColumn = column("ЦЕНА_2026");
    const collectibleColumn = column("КОЛЛЕКЦИОННАЯ");
    const tierColumn = column("КОНТЕЙНЕР");
    const referencePrice = priceColumn >= 0 ? Number(cells[priceColumn]) : 0;
    return {
      model, make, photoUrl: String(cells[photoColumn] || "").trim(), photoSource: String(cells[sourceColumn] || "").trim(),
      referencePrice: Number.isFinite(referencePrice) && referencePrice > 0 ? referencePrice : null,
      collectible: collectibleColumn >= 0 && String(cells[collectibleColumn] || "") === "1",
      preferredTier: tierColumn >= 0 ? String(cells[tierColumn] || "").trim() : ""
    };
  }).filter((item) => item.model && item.photoUrl && !seen.has(item.model) && seen.add(item.model));
}

function stableVehicleUnit(value, salt = "") {
  const digest = crypto.createHash("sha256").update(`${value}:${salt}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

function vehicleClass(model, make) {
  const value = model.toLowerCase();
  if (["Tesla", "Polestar", "Rivian", "Lucid", "BYD"].includes(make) || /\b(ev|electric|électrique|e-tron|ioniq)\b/i.test(value)) return "electric";
  if (/\b(roadster|spider|spyder|cabrio|cabriolet|convertible)\b/i.test(value)) return "roadster";
  if (/\b(pickup|pick-up|ranger|amarok|hilux|colorado|silverado|ram)\b/i.test(value)) return "pickup";
  if (/\b(van|transit|transporter|multivan|starex|caravan|voyager|berlingo|partner|doblo|ducato|sprinter|vito)\b/i.test(value)) return "van";
  if (/\b(suv|cross|crossover|land cruiser|range rover|patrol|pajero|outlander|forester|rav4|cr-v|x-trail|qashqai|tiguan|touareg|cayenne|x[1-7]|q[2-9]|gl[abcdeks]|wrangler|cherokee|tahoe|escalade|captiva|sportage|sorento|santa fe|terracan|duster|niva|4x4)\b/i.test(value)) return "suv";
  if (exoticMakes.has(make) || /\b(coupe|coupé|gt|gtr|gt-r|sport)\b/i.test(value)) return "coupe";
  if (/\b(type|litre|hp|cv)\b/i.test(value)) return "classic";
  if (premiumMakes.has(make)) return "premium";
  if (/\b(wagon|estate|touring|variant|avant|allroad)\b/i.test(value)) return "wagon";
  if (/\b(hatch|golf|polo|focus|fiesta|corsa|astra|ceed|rio|picanto|swift|yaris|micra)\b/i.test(value)) return "hatch";
  const bodyUnit = stableVehicleUnit(model, "body");
  return bodyUnit < 0.24 ? "hatch" : bodyUnit < 0.34 ? "wagon" : "sedan";
}

const makeReferencePrices = {
  Lada: 1200000, Dacia: 1500000, Daewoo: 900000, Tata: 1400000, Proton: 1300000, Daihatsu: 1500000,
  Fiat: 2100000, Renault: 2300000, Peugeot: 2500000, "Citroën": 2500000, "Škoda": 2700000, Suzuki: 2500000,
  Hyundai: 3000000, Kia: 3000000, Opel: 2300000, SEAT: 2400000, Vauxhall: 2400000, Chery: 3100000,
  Geely: 3300000, Haval: 3500000, BYD: 4300000, SsangYong: 2900000, Toyota: 4200000, Honda: 3700000,
  Nissan: 3500000, Mazda: 3400000, Mitsubishi: 3600000, Subaru: 4200000, Volkswagen: 3500000, Ford: 3000000,
  Chevrolet: 3500000, Jeep: 5500000, Volvo: 5200000, GMC: 5000000, Dodge: 4300000, Buick: 4000000,
  Pontiac: 3200000, Chrysler: 3800000, Isuzu: 3300000, Holden: 2800000, Mini: 3800000, Smart: 2400000,
  Audi: 7200000, BMW: 7600000, "Mercedes-Benz": 8200000, Lexus: 7000000, Infiniti: 5400000, Acura: 5200000,
  Cadillac: 7800000, Genesis: 7200000, "Land Rover": 12000000, "Range Rover": 15000000, Jaguar: 9000000,
  "Alfa Romeo": 6000000, Maserati: 16000000, Tesla: 6500000, Polestar: 6500000, Rivian: 12000000, Lucid: 13000000,
  Porsche: 22000000, Ferrari: 65000000, Lamborghini: 70000000, Bentley: 42000000, "Rolls-Royce": 65000000,
  "Aston Martin": 38000000, McLaren: 70000000, Bugatti: 350000000, Pagani: 300000000, Koenigsegg: 450000000,
  Lotus: 15000000, Alpine: 8000000, Maybach: 70000000
};
const modelPriceOverrides = {
  "Maybach 57": 70000000, "Maybach 57 and 62": 85000000, "Maybach Exelero": 650000000,
  "McLaren 570S": 32000000, "McLaren F1": 1500000000, "McLaren F1 LM": 2000000000,
  "Bugatti EB110": 280000000, "Bugatti 18/3 Chiron": 500000000,
  "Pagani Huayra": 420000000, "Pagani Zonda": 320000000, "Pagani Zonda C 12 S": 360000000,
  "Pagani Zonda C12 6.0": 330000000, "Pagani Zonda C12-S 7.0": 380000000,
  "Pagani Zonda C12-S Monza": 480000000, "Pagani Zonda Cinque": 750000000, "Pagani Zonda R": 520000000,
  "Lamborghini Aventador": 75000000, "Lamborghini Murciélago": 60000000, "Lamborghini Gallardo": 30000000,
  "Lamborghini Countach": 180000000, "Lamborghini Egoista": 1200000000,
  "Rolls-Royce Ghost": 55000000, "Rolls-Royce Phantom Coupé": 80000000,
  "Bentley Bentayga": 42000000, "Bentley Continental Flying Spur": 35000000,
  "Ferrari 250 GT 2+2": 250000000
};
const collectibleValueFloors = {
  "Maybach 57": 0.82, "Maybach 57 and 62": 0.84, "Maybach Exelero": 0.82,
  "McLaren F1": 0.82, "McLaren F1 LM": 0.88,
  "Bugatti EB110": 0.72, "Bugatti 18/3 Chiron": 0.85, "Pagani Huayra": 0.78,
  "Pagani Zonda": 0.75, "Pagani Zonda C 12 S": 0.76, "Pagani Zonda C12 6.0": 0.75,
  "Pagani Zonda C12-S 7.0": 0.76, "Pagani Zonda C12-S Monza": 0.82, "Pagani Zonda Cinque": 0.86,
  "Pagani Zonda R": 0.82, "Lamborghini Egoista": 0.88, "Ferrari 250 GT 2+2": 0.78
};

function domesticMarketProfile(model) {
  const value = vehicleName(model).toLowerCase().replace(/[^a-zа-яё0-9]+/giu, " ").trim();
  const exact = {
    "moskvich 408": [1964, 1975, 180000], "moskvich 410": [1957, 1961, 260000], "moskvich 412": [1967, 2001, 190000],
    "moskvich 430": [1958, 1963, 220000], "moskvich 433": [1966, 1973, 210000], "moskvich 434": [1968, 1975, 220000],
    "moskvich 2136": [1976, 1981, 190000], "moskvich 2137": [1976, 1985, 210000], "moskvich 2138": [1976, 1982, 170000],
    "moskvich 2141": [1986, 2002, 170000], "moskvich 2335": [1994, 2002, 260000], "moskvich svyatogor": [1997, 2001, 210000],
    "moskvich knyazvladimir": [1997, 2001, 260000], "moskvich yuridolgorukiy": [1997, 2001, 240000],
    "moskvich 3": [2022, 2026, 2150000], "moskvich 3e": [2022, 2026, 3550000], "moskvich 6": [2023, 2026, 2750000], "moskvich 8": [2024, 2026, 3300000],
    "lada 2101": [1970, 1988, 220000], "lada 2102": [1971, 1986, 210000], "lada 2103": [1972, 1984, 270000],
    "lada 2104": [1984, 2012, 190000], "lada 2105": [1980, 2010, 170000], "lada 2106": [1976, 2006, 230000], "lada 2107": [1982, 2012, 250000],
    "lada 2108": [1984, 2004, 180000], "lada 2109": [1987, 2004, 180000], "lada 21099": [1990, 2004, 190000],
    "lada 2110": [1995, 2007, 210000], "lada 2111": [1997, 2009, 220000], "lada 2112": [1998, 2008, 230000],
    "lada 2113": [2004, 2013, 220000], "lada 2114": [2001, 2013, 230000], "lada 2115": [1997, 2012, 220000],
    "gaz 3102": [1982, 2008, 480000], "gaz 31029": [1992, 1997, 230000], "gaz 3110": [1997, 2005, 260000], "gaz 31105": [2004, 2009, 340000],
    "uaz 452": [1965, 2026, 620000], "uaz 469": [1972, 2007, 520000], "uaz hunter": [2003, 2026, 780000], "uaz patriot": [2005, 2026, 1250000]
  };
  if (exact[value]) { const [startYear, endYear, marketAnchor] = exact[value]; return { startYear, endYear, marketAnchor }; }
  if (/^lada (?:210[1-9]|211[0-5]|212[0-3]|2302|2323|2329|4x4|riva|samara|ale[kк]o|forma|signet|t 134|1922|1121|1152)\b/.test(value)) return { startYear: 1970, endYear: 2013, marketAnchor: 230000 };
  if (/^lada (?:granta|kalina|priora|largus)\b/.test(value)) return { startYear: 2004, endYear: 2026, marketAnchor: 920000 };
  if (/^lada (?:vesta|xray|iskra|azimut|niva)\b/.test(value)) return { startYear: 2015, endYear: 2026, marketAnchor: 1450000 };
  if (/^toyota avensis\b/.test(value)) return { startYear: 1997, endYear: 2018, marketAnchor: 1450000 };
  if (/^ferrari 412\b/.test(value)) return { startYear: 1985, endYear: 1989, marketAnchor: 28000000 };
  if (/^moskvich 21(?:3[6-8]|4[134])\b/.test(value)) return { startYear: 1976, endYear: 2002, marketAnchor: 190000 };
  if (/^lada 21(?:0[1-9]|099|1[0-5])\b/.test(value)) return { startYear: 1975, endYear: 2013, marketAnchor: 220000 };
  if (/^gaz 31(?:02|029|10|105)\b/.test(value)) return { startYear: 1982, endYear: 2009, marketAnchor: 320000 };
  if (/^uaz (?:2206|3151|3159|3160|3162|39094)\b/.test(value)) return { startYear: 1985, endYear: 2015, marketAnchor: 480000 };
  return null;
}

function vehicleProfile(entry) {
  const rule = vehicleRule(entry.model);
  const domesticProfile = domesticMarketProfile(entry.model);
  const unit = stableVehicleUnit(entry.model, "price");
  const className = vehicleClass(entry.model, entry.make);
  const makeBase = makeReferencePrices[entry.make] || (premiumMakes.has(entry.make) ? 7500000 : exoticMakes.has(entry.make) ? 30000000 : budgetMakes.has(entry.make) ? 1400000 : valueMakes.has(entry.make) ? 2700000 : 3800000);
  let currentBase = makeBase * (0.76 + unit * (exoticMakes.has(entry.make) ? 0.72 : 0.48));
  if (["suv", "pickup"].includes(className)) currentBase *= 1.18;
  if (["coupe", "roadster"].includes(className)) currentBase *= 1.12;
  if (className === "van") currentBase *= 1.08;
  if (/\b(360|600|700|800|1000|1100|1200|1300|1400|1500|1600)\b/.test(entry.model) && !premiumMakes.has(entry.make) && !exoticMakes.has(entry.make)) currentBase *= 0.78;
  if (/\b(flagship|turbo|performance|super|continental|phantom|veyron|chiron|aventador|murciélago|911|gallardo|corvette)\b/i.test(entry.model)) currentBase *= 1.32;
  currentBase = rule.referencePrice || domesticProfile?.marketAnchor || modelPriceOverrides[entry.model] || entry.referencePrice || currentBase;
  currentBase = Math.round(Math.max(60000, Math.min(MAX_VEHICLE_VALUE, currentBase)) / 10000) * 10000;
  const classicHint = /\b(type|hp|cv|litre|zeppelin|phantom i|phantom ii|silver ghost)\b/i.test(entry.model)
    || /^(?:Ferrari (?:2\d\d|3\d\d|4(?:0\d|12)|5(?:0\d|12)|6(?:12))|Lamborghini (?:350|400|Countach|Miura)|Toyota 2000GT)\b/i.test(entry.model);
  const modernHint = /\b(ev|electric|électrique|e-tron|ioniq|model [3sxy]|polestar|rivian|lucid)\b/i.test(entry.model) || ["BYD", "Genesis"].includes(entry.make);
  const knownYears = rule.startYear ? rule : domesticProfile || vehicleProductionYears[entry.model];
  const inferredStartYear = classicHint ? 1950 + Math.floor(stableVehicleUnit(entry.model, "year") * 28) : modernHint ? 2012 + Math.floor(stableVehicleUnit(entry.model, "year") * 10) : 1988 + Math.floor(stableVehicleUnit(entry.model, "year") * 27);
  const startYear = knownYears?.startYear || inferredStartYear;
  const endYear = knownYears?.endYear || Math.min(2026, startYear + 8 + Math.floor(stableVehicleUnit(entry.model, "span") * 15));
  return { ...entry, collectible: rule.collectible ?? entry.collectible, className, startYear, endYear, currentBase, marketAnchor: domesticProfile ? rule.referencePrice || domesticProfile.marketAnchor : null };
}

const vehicleModels = parseVehicleCatalog().map(vehicleProfile);
if (vehicleModels.length < 100) throw new Error(`В каталоге слишком мало автомобилей: ${vehicleModels.length}`);
const vehicleColors = ["#b9473d", "#35698c", "#4e7652", "#d39232", "#555f6d", "#292b30", "#7b4e78", "#6999a4", "#806247", "#8d927e", "#e2e0d5", "#1f2022"];
const depreciationFloor = { classic: 0.38, hatch: 0.15, sedan: 0.16, suv: 0.2, coupe: 0.24, van: 0.22, electric: 0.2, premium: 0.22, wagon: 0.17, pickup: 0.25, roadster: 0.28 };
const CATALOG_SIZE = 10000;
const CATALOG_VARIANTS_PER_MODEL = Math.ceil(CATALOG_SIZE / vehicleModels.length);
const catalog = Array.from({ length: CATALOG_SIZE }, (_, index) => {
  const seed = vehicleModels[index % vehicleModels.length];
  const { make, model, className, startYear, endYear, currentBase, marketAnchor, photoUrl, photoSource, collectible, preferredTier } = seed;
  const cycle = Math.floor(index / vehicleModels.length);
  const yearSpan = endYear - startYear + 1;
  const year = startYear + Math.round(cycle * Math.max(0, yearSpan - 1) / Math.max(1, CATALOG_VARIANTS_PER_MODEL - 1));
  const age = Math.max(0, 2026 - year);
  const floor = depreciationFloor[className] || 0.18;
  const depreciation = floor + (1 - floor) * Math.pow(className === "electric" ? 0.91 : 0.945, age);
  const trimMultiplier = 0.91 + stableVehicleUnit(`${model}:${year}`, "variant") * 0.18;
  const rarityPremium = age > 24 && ["classic", "coupe", "premium"].includes(className) ? 1 + Math.min(0.65, (age - 24) * 0.025) : 1;
  const calculatedBase = marketAnchor ? marketAnchor * (0.88 + stableVehicleUnit(`${model}:${year}`, "market") * 0.24) : currentBase * depreciation * trimMultiplier * rarityPremium;
  const collectibleFloor = currentBase * (collectibleValueFloors[model] || (collectible ? 0.78 : 0));
  return {
    make, model, photoQuery: model, photoUrl, photoSource, year, collectible: Boolean(collectible), preferredTier: preferredTier || "",
    base: Math.max(60000, Math.min(MAX_VEHICLE_VALUE, Math.round(Math.max(calculatedBase, collectibleFloor) / 1000) * 1000)),
    className, color: vehicleColors[(index * 7 + cycle) % vehicleColors.length]
  };
});

const catalogByModel = new Map(catalog.map((item) => [item.model, item]));
const modelReferenceValues = new Map();
const modelCurrentValues = new Map(vehicleModels.map(({ model, currentBase }) => [model, currentBase]));
for (const item of catalog) {
  const values = modelReferenceValues.get(item.model) || [];
  values.push(item.base);
  modelReferenceValues.set(item.model, values);
}
for (const [model, values] of modelReferenceValues) {
  values.sort((a, b) => a - b);
  modelReferenceValues.set(model, values[Math.floor(values.length / 2)]);
}

function minimumNpcPrice(model) {
  const reference = modelReferenceValues.get(model) || modelCurrentValues.get(model) || 100000;
  return Math.max(40000, Math.round(reference * 0.38 / 1000) * 1000);
}
let marketStatsCache = null;
let marketStatsCacheAt = 0;

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

const { repairPlans, repairQuote, repairReliability, inspectionMethods, inspectionQuote, careerProgress } = require("./gameplay");

const skillInfo = {
  negotiation: { name: "Переговорщик", description: "Каждый уровень: +0,9% к уступке покупателя при торге", maxLevel: 5 },
  tuning: { name: "Настройщик", description: "Каждый уровень: −4% к цене работ в тюнинг-ателье", maxLevel: 5 },
  diagnostics: { name: "Диагност", description: "Двигатель, подвеска и поиск скрытых симптомов", maxLevel: 5 },
  mechanics: { name: "Механик", description: "Каждый уровень: −2% к цене работ; открывает моториста, ходовую и шиномонтаж", maxLevel: 5 },
  engineRepair: { name: "Моторист", description: "Самостоятельный ремонт двигателя и его навесного оборудования", maxLevel: 5 },
  chassisRepair: { name: "Мастер ходовой", description: "Тормоза, рулевое управление, подвеска и трансмиссия", maxLevel: 5 },
  tireService: { name: "Шиномонтажник", description: "Ремонт, подбор и установка колёс и шин", maxLevel: 5 },
  electrics: { name: "Автоэлектрик", description: "Диагностика и ремонт электрооборудования", maxLevel: 5 },
  bodywork: { name: "Кузовной мастер", description: "Осмотр геометрии, сварка и окраска", maxLevel: 5 },
  appraisal: { name: "Оценщик", description: "VIN, история, пробег и рыночная стоимость", maxLevel: 5 },
  assetTrading: { name: "Товаровед", description: "Оценка техники, коллекционных вещей и быстрый перепродажный оборот", maxLevel: 5 },
  collectibles: { name: "Эксперт редкостей", description: "Проверка подлинности часов, искусства и коллекционных предметов", maxLevel: 5 },
  propertyAppraisal: { name: "Риелтор", description: "Оценка локации, состояния и справедливой цены недвижимости", maxLevel: 5 },
  propertyManagement: { name: "Управляющий", description: "Повышает чистый пассивный доход от недвижимости", maxLevel: 5 },
  cryptoTrading: { name: "Криптотрейдер", description: "Снижает комиссию при продаже цифровых активов", maxLevel: 5 },
  riskManagement: { name: "Риск-менеджер", description: "Даёт более точную оценку волатильных криптоактивов", maxLevel: 5 }
};

const skillPaths = {
  diagnostics: { title: "Диагностика", summary: "Находите риски до покупки и экономьте на полной проверке.", unlocks: ["Больше точных проверок", "Скрытые симптомы", "Бесплатный базовый тест"] },
  mechanics: { title: "Механика", summary: "Ремонтируйте машины самостоятельно и повышайте надёжность.", unlocks: ["Дешевле ремонт", "Сложные узлы", "Гарантия на работу"] },
  bodywork: { title: "Кузов и тюнинг", summary: "Восстанавливайте внешний вид и собирайте профиль машины.", unlocks: ["Кузовные работы", "Городской пакет", "Редкий тюнинг"] },
  appraisal: { title: "Оценка и документы", summary: "Понимайте реальную цену, историю и юридические риски.", unlocks: ["Точный индекс", "Проверка VIN", "Коллекционные заказы"] },
  sales: { title: "Переговоры", summary: "Находите подходящего клиента и защищайте маржу сделки.", unlocks: ["Встречные предложения", "Постоянные клиенты", "Премиальные продажи"] }
};

const achievementCatalog = [
  { key: "first_purchase", title: "Первый гараж", description: "Купите первый автомобиль.", icon: "01", rewardXp: 40, test: (p) => p.stats.purchases >= 1 },
  { key: "first_sale", title: "Сделка состоялась", description: "Продайте первый автомобиль.", icon: "02", rewardXp: 60, test: (p) => p.deals >= 1 },
  { key: "profit_100k", title: "Первая серьёзная маржа", description: "Получите 100 000 ₽ прибыли на сделках.", icon: "₽", rewardXp: 90, test: (p) => p.profit >= 100000 },
  { key: "self_repair_10", title: "Своими руками", description: "Выполните 10 самостоятельных ремонтов.", icon: "М", rewardXp: 120, test: (p) => p.stats.selfRepairs >= 10 },
  { key: "perfect_inspection", title: "Вижу насквозь", description: "Проведите точную диагностику с результатом 100%.", icon: "D", rewardXp: 100, test: (p) => p.stats.perfectInspections >= 1 },
  { key: "tuner", title: "Свой почерк", description: "Установите 5 улучшений на автомобили.", icon: "T", rewardXp: 100, test: (p) => p.stats.upgrades >= 5 },
  { key: "reputation_75", title: "Мне доверяют", description: "Достигните 75 репутации.", icon: "★", rewardXp: 140, test: (p) => (p.reputation?.score || 0) >= 75 },
  { key: "auction_winner", title: "Последняя ставка", description: "Выиграйте первый автомобильный аукцион.", icon: "A", rewardXp: 100, test: (p) => p.stats.auctionsWon >= 1 },
  { key: "million_profit", title: "Автомобильный бизнес", description: "Заработайте 1 000 000 ₽ прибыли.", icon: "1M", rewardXp: 250, test: (p) => p.profit >= 1000000 }
];

function syncAchievements(player) {
  player.achievements ||= { unlocked: [], claimed: [] };
  const unlocked = new Set(player.achievements.unlocked);
  for (const achievement of achievementCatalog) {
    if (unlocked.has(achievement.key) || !achievement.test(player)) continue;
    unlocked.add(achievement.key);
    player.achievements.unlocked.push(achievement.key);
    const oldLevel = levelForXp(player.xp || 0);
    player.xp = (player.xp || 0) + achievement.rewardXp;
    player.skillPoints += levelForXp(player.xp) - oldLevel;
    player.notifications ||= [];
    player.notifications.push({ id: id("notice_"), type: "achievement", title: `Достижение: ${achievement.title}`, text: `${achievement.description} +${achievement.rewardXp} XP`, at: Date.now(), read: false });
    if (player.notifications.length > 80) player.notifications.splice(0, player.notifications.length - 80);
  }
}

const equipmentInfo = {
  diagnosticKit: { name: "Диагностический комплекс", description: "Сканер, эндоскоп и измерительные приборы", prices: [0, 28000, 82000, 175000] },
  workshop: { name: "Механическая мастерская", description: "Подъёмник, инструмент и динамоключ", prices: [0, 42000, 128000, 265000] },
  engineStand: { name: "Моторный участок", description: "Стенд двигателя, съёмники и инструмент ГРМ", prices: [0, 38000, 118000, 248000] },
  chassisTools: { name: "Пост ходовой", description: "Прессы, съёмники и стенд тормозной системы", prices: [0, 32000, 96000, 215000] },
  tireStation: { name: "Шиномонтажный пост", description: "Станок, балансировка и ремонт бескамерных шин", prices: [0, 24000, 72000, 158000] },
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
  { id: "bot_lux", name: "Премиум Коллекшн", type: "collector", skill: 5, risk: 1.06, budget: 350000000, repairPremium: 0.18 },
  { id: "bot_museum", name: "Частный автомобильный музей", type: "collector", skill: 5, risk: 1.11, budget: 2000000000, repairPremium: 0.22 }
];

db.exec('CREATE TABLE IF NOT EXISTS npc_skills (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
for (const bot of bots) {
  const saved = db.prepare('SELECT payload FROM npc_skills WHERE id = ?').get(bot.id);
  bot.inspectionSkills = saved ? JSON.parse(saved.payload) : randomInspectionSkills();
  if (!saved) db.prepare('INSERT INTO npc_skills (id, payload) VALUES (?, ?)').run(bot.id, JSON.stringify(bot.inspectionSkills));
}

const partComponents = {
  engine: "Двигатель и навесное", chassis: "Ходовая и трансмиссия", body: "Кузовная деталь",
  electrics: "Электрооборудование", tires: "Колёса и шины", universal: "Расходные материалы"
};
const partQualityCatalog = {
  economy: { key: "economy", name: "Бюджет", priceFactor: 0.68, valueFactor: 0.5, reliability: 72, warrantyKm: 0, brands: ["StartLine", "RoadBase", "AvtoNorm"] },
  analog: { key: "analog", name: "Надёжный аналог", priceFactor: 1, valueFactor: 0.88, reliability: 88, warrantyKm: 20000, brands: ["NordParts", "Vector Auto", "KraftWerk"] },
  original: { key: "original", name: "Оригинал", priceFactor: 1.58, valueFactor: 1.22, reliability: 100, warrantyKm: 50000, brands: ["OEM Genuine", "Factory Parts"] },
  restored: { key: "restored", name: "Восстановленная", priceFactor: 0.55, valueFactor: 0.42, reliability: 68, warrantyKm: 3000, brands: ["ReParts", "SecondDrive"] }
};
const defectPartCatalog = {
  oil_low: { sku: "ENG-OIL-5W30", name: "Моторное масло 5W-30", component: "engine" },
  timing_belt: { sku: "ENG-TIMING-BELT", name: "Комплект ремня ГРМ", component: "engine" },
  oil_leak: { sku: "ENG-VALVE-GASKET", name: "Прокладка клапанной крышки", component: "engine" },
  compression: { sku: "ENG-PISTON-KIT", name: "Поршневая ремонтная группа", component: "engine" },
  timing: { sku: "ENG-TIMING-CHAIN", name: "Комплект цепи ГРМ", component: "engine" },
  clutch: { sku: "CHS-CLUTCH-KIT", name: "Комплект сцепления", component: "chassis" },
  bearing: { sku: "CHS-WHEEL-BEARING", name: "Ступичный подшипник", component: "chassis" },
  rack: { sku: "CHS-STEERING-RACK", name: "Рулевая рейка", component: "chassis" },
  brakes: { sku: "CHS-BRAKE-DISCS", name: "Комплект тормозных дисков", component: "chassis" },
  paint: { sku: "BDY-PAINT-KIT", name: "Комплект краски и грунта", component: "body" },
  frame: { sku: "BDY-FRAME-SECTION", name: "Ремонтная секция лонжерона", component: "body" },
  rust: { sku: "BDY-SILL-PANEL", name: "Ремонтная панель порога", component: "body" },
  airbag: { sku: "ELC-AIRBAG-MODULE", name: "Модуль подушки безопасности", component: "electrics" },
  generator: { sku: "ELC-ALTERNATOR", name: "Генератор в сборе", component: "electrics" },
  turn_signal: { sku: "ELC-TURN-LAMP", name: "Лампа поворотника", component: "electrics" },
  can_bus: { sku: "ELC-CAN-HARNESS", name: "Жгут CAN-шины", component: "electrics" },
  coolant: { sku: "ENG-COOLANT-PIPE", name: "Патрубок системы охлаждения", component: "engine" },
  wiring: { sku: "ELC-WIRING-HARNESS", name: "Жгут проводки", component: "electrics" },
  uneven_tires: { sku: "TIR-ROAD-SET", name: "Комплект дорожных шин", component: "tires" },
  old_tires: { sku: "TIR-ROAD-SET", name: "Комплект дорожных шин", component: "tires" },
  puncture: { sku: "TIR-PUNCTURE-KIT", name: "Ремкомплект бескамерной шины", component: "tires" }
};

const upgradeCatalog = [
  { key: "detailing", name: "Профессиональный детейлинг", profile: "comfort", demand: ["endBuyer", "budget"], description: "Глубокая очистка салона, полировка кузова и фото-подготовка.", skill: "bodywork", equipment: "bodyStation", skillLevel: 1, equipmentLevel: 1, cost: 22000, value: 36000, condition: 4 },
  { key: "maintenance", name: "Большое ТО", profile: "utility", demand: ["endBuyer", "dealer", "budget"], description: "Масла, фильтры и регламентные расходники с записью в историю.", skill: "mechanics", equipment: "workshop", skillLevel: 1, equipmentLevel: 1, cost: 34000, value: 52000, condition: 6 },
  { key: "suspension", name: "Настройка ходовой", profile: "sport", demand: ["specialist", "dealer"], description: "Развал-схождение и настройка подвески для уверенного хода.", skill: "mechanics", equipment: "workshop", skillLevel: 2, equipmentLevel: 2, cost: 76000, value: 112000, condition: 8 },
  { key: "electronics", name: "Профилактика электроники", profile: "comfort", demand: ["endBuyer", "specialist"], description: "Проверка блоков, контактов и обновление сервисной истории.", skill: "electrics", equipment: "electricalBench", skillLevel: 2, equipmentLevel: 2, cost: 68000, value: 104000, condition: 5 },
  { key: "restoration", name: "Предпродажная реставрация", profile: "classic", demand: ["collector", "specialist"], description: "Комплексная подготовка редкого автомобиля с подтверждёнными работами.", skill: "appraisal", equipment: "bodyStation", skillLevel: 3, equipmentLevel: 3, cost: 165000, value: 255000, condition: 10 }
];

const employeeCandidates = [
  { id: "employee_diagnostic_1", name: "Антон Лебедев", specialty: "diagnostics", title: "Диагност", rating: 72, hireCost: 65000, salary: 4500 },
  { id: "employee_diagnostic_2", name: "Ольга Романова", specialty: "diagnostics", title: "Старший диагност", rating: 91, hireCost: 145000, salary: 8500 },
  { id: "employee_mechanic_1", name: "Михаил Орлов", specialty: "mechanics", title: "Механик", rating: 76, hireCost: 78000, salary: 5500 },
  { id: "employee_mechanic_2", name: "Рустам Саидов", specialty: "mechanics", title: "Мастер цеха", rating: 94, hireCost: 168000, salary: 9500 },
  { id: "employee_appraiser", name: "Елена Волкова", specialty: "appraisal", title: "Оценщик", rating: 86, hireCost: 112000, salary: 7000 },
  { id: "employee_manager", name: "Павел Серов", specialty: "sales", title: "Менеджер продаж", rating: 88, hireCost: 128000, salary: 7500 }
];
const groupJobCatalog = {
  inspection: { key: "inspection", specialty: "diagnostics", name: "Выездная диагностика", description: "Проверить автомобиль клиента перед покупкой", durationSeconds: 45, cost: 9000, rewardLow: 18000, rewardHigh: 29000, xp: 45, energy: 22 },
  repair: { key: "repair", specialty: "mechanics", name: "Срочный ремонт", description: "Вернуть клиентскую машину на ход", durationSeconds: 70, cost: 18000, rewardLow: 35000, rewardHigh: 56000, xp: 65, energy: 30 },
  appraisal: { key: "appraisal", specialty: "appraisal", name: "Подбор автомобиля", description: "Найти выгодный лот и проверить документы", durationSeconds: 60, cost: 14000, rewardLow: 28000, rewardHigh: 44000, xp: 55, energy: 25 },
  sale: { key: "sale", specialty: "sales", name: "Продажа под ключ", description: "Подготовить объявление и провести переговоры", durationSeconds: 85, cost: 22000, rewardLow: 43000, rewardHigh: 68000, xp: 75, energy: 32 }
};

const assetCatalog = [
  { key: "negotiation_office", name: "Офис переговоров", type: "property", category: "commercial", propertyRole: "negotiation", roleName: "Офис", description: "Место встреч с покупателями и постоянными клиентами.", basePrice: 1800000, income: 18000, liquidity: 75, risk: 1, skill: "propertyManagement", carBonus: 0 },
  { key: "phone_lot", type: "item", category: "electronics", name: "Партия смартфонов", description: "Возвраты магазина: часть комплектов вскрыта, документы в порядке.", basePrice: 145000, liquidity: 92, risk: 2, skill: "assetTrading" },
  { key: "gaming_pc", type: "item", category: "electronics", name: "Игровая рабочая станция", description: "Мощный компьютер после закрытия дизайн-студии.", basePrice: 310000, liquidity: 84, risk: 2, skill: "assetTrading" },
  { key: "camera_kit", type: "item", category: "electronics", name: "Комплект фототехники", description: "Камера, три объектива и студийный свет одним лотом.", basePrice: 480000, liquidity: 76, risk: 3, skill: "assetTrading" },
  { key: "watch", type: "item", category: "collectibles", name: "Механические часы 1987 года", description: "Редкая серия с сервисной историей, подлинность требует экспертизы.", basePrice: 1250000, liquidity: 61, risk: 4, skill: "collectibles" },
  { key: "vinyl", type: "item", category: "collectibles", name: "Архив виниловых пластинок", description: "Коллекция из 240 изданий, среди которых встречаются редкие тиражи.", basePrice: 620000, liquidity: 68, risk: 3, skill: "collectibles" },
  { key: "painting", type: "item", category: "collectibles", name: "Картина регионального авангарда", description: "Работа с аукционной историей и неподтверждённой атрибуцией.", basePrice: 3900000, liquidity: 43, risk: 5, skill: "collectibles" },
  { key: "equipment", type: "item", category: "business", name: "Комплект кофейного оборудования", description: "Две кофемашины, кофемолки и холодильные витрины.", basePrice: 780000, liquidity: 73, risk: 2, skill: "assetTrading" },
  { key: "tools", type: "item", category: "business", name: "Склад профессионального инструмента", description: "Ликвидный товар после закрытия строительной фирмы.", basePrice: 2100000, liquidity: 88, risk: 2, skill: "assetTrading" },
  { key: "studio", type: "property", category: "residential", name: "Студия у университета", description: "Небольшая квартира с устойчивым спросом на аренду.", basePrice: 4200000, income: 42000, liquidity: 91, risk: 1, skill: "propertyAppraisal" },
  { key: "apartment", type: "property", category: "residential", name: "Двухкомнатная квартира", description: "Жилой район, косметический ремонт и долгосрочный арендатор.", basePrice: 7800000, income: 68000, liquidity: 83, risk: 2, skill: "propertyAppraisal" },
  { key: "country_house", type: "property", category: "residential", name: "Загородный дом", description: "Дом с участком, сезонная аренда даёт повышенную доходность.", basePrice: 14500000, income: 128000, liquidity: 57, risk: 3, skill: "propertyAppraisal" },
  { key: "garage_block", name: "Блок из шести гаражей", type: "property", category: "commercial", propertyRole: "workshop", roleName: "Гаражный блок", description: "Полностью заняты арендаторами и подходит для первых ремонтных постов.", basePrice: 6100000, income: 74000, liquidity: 78, risk: 1, skill: "propertyManagement", carBonus: 0.025 },
  { key: "office", name: "Шоурум", type: "property", category: "commercial", propertyRole: "showroom", roleName: "Шоурум", description: "Первый этаж бизнес-центра с витриной для подготовленных автомобилей.", basePrice: 18500000, income: 195000, liquidity: 64, risk: 2, skill: "propertyManagement", carBonus: 0.06 },
  { key: "warehouse", name: "Тёплый склад", type: "property", category: "commercial", propertyRole: "parts", roleName: "Склад запчастей", description: "Тёплый склад с удобным подъездом и запасом под ремонтные сделки.", basePrice: 32000000, income: 365000, liquidity: 59, risk: 3, skill: "propertyManagement", carBonus: 0.04 },
  { key: "retail", name: "Премиальный салон", type: "property", category: "commercial", propertyRole: "premium_showroom", roleName: "Премиальный салон", description: "Первая линия и дорогая эксплуатация, зато сюда приходят коллекционеры.", basePrice: 68000000, income: 790000, liquidity: 52, risk: 4, skill: "propertyManagement", carBonus: 0.1 },
  { key: "crypton", type: "crypto", category: "crypto", symbol: "CRN", name: "Crypton", description: "Самый ликвидный цифровой актив игрового рынка.", basePrice: 285000, liquidity: 96, risk: 3, volatility: 0.035, skill: "riskManagement" },
  { key: "ethera", type: "crypto", category: "crypto", symbol: "ETHR", name: "Ethera", description: "Платформа игровых контрактов со средней волатильностью.", basePrice: 48000, liquidity: 90, risk: 3, volatility: 0.052, skill: "riskManagement" },
  { key: "solaris", type: "crypto", category: "crypto", symbol: "SLR", name: "Solaris", description: "Быстрый, но более рискованный цифровой актив.", basePrice: 7200, liquidity: 79, risk: 4, volatility: 0.075, skill: "riskManagement" },
  { key: "garage_coin", type: "crypto", category: "crypto", symbol: "GRC", name: "Garage Coin", description: "Спекулятивный токен сообщества с резкими движениями курса.", basePrice: 145, liquidity: 63, risk: 5, volatility: 0.12, skill: "riskManagement" }
];

const clothingFallback = [
  { id: "fallback-1", key: "uniqlo_tee", brand: "Uniqlo", model: "U", name: "Uniqlo U футболка", category: "Футболка", rarity: "common", chance: 52, value: 1800, description: "Базовая хлопковая футболка из повседневной коллекции.", photoUrl: "" },
  { id: "fallback-2", key: "nike_hoodie", brand: "Nike", model: "Sportswear", name: "Nike Sportswear худи", category: "Худи", rarity: "uncommon", chance: 28, value: 5200, description: "Спортивное худи с мягким начёсом.", photoUrl: "" },
  { id: "fallback-3", key: "adidas_track", brand: "Adidas", model: "Originals", name: "Adidas Originals олимпийка", category: "Одежда", rarity: "rare", chance: 14, value: 9800, description: "Олимпийка из лимитированной цветовой серии.", photoUrl: "" },
  { id: "fallback-4", key: "carhartt_jacket", brand: "Carhartt WIP", model: "Detroit", name: "Carhartt WIP Detroit Jacket", category: "Куртка", rarity: "epic", chance: 5, value: 24500, description: "Плотная рабочая куртка из популярной streetwear-линейки.", photoUrl: "" },
  { id: "fallback-5", key: "supreme_box", brand: "Supreme", model: "Box Logo", name: "Supreme Box Logo Hoodie", category: "Худи", rarity: "legendary", chance: 1, value: 68000, description: "Редкий коллекционный дроп с узнаваемым логотипом.", photoUrl: "" }
];
const clothingRarityKeys = { "Обычная": "common", "Необычная": "uncommon", "Редкая": "rare", "Эпическая": "epic", "Легендарная": "legendary" };
const clothingCatalog = (() => {
  try {
    const source = JSON.parse(fs.readFileSync(path.join(__dirname, "каталог-одежды-с-фото.json"), "utf8"));
    const parsed = source.map((item) => ({ ...item, key: item.id, name: `${item.brand} ${item.model} · ${item.category}`, rarity: clothingRarityKeys[item.rarity] || "common", chance: Number.parseFloat(String(item.chance).replace(",", ".")) || 0, value: Number(String(item.price).replace(/[^0-9]/g, "")) || 1000, type: "item", category: "clothing", seller: "Мастерская" }));
    return parsed.length ? parsed : clothingFallback;
  } catch (error) {
    console.warn("Clothing catalog file unavailable, using fallback:", error.message);
    return clothingFallback;
  }
})();
const clothingRarityNames = { common: "Обычная", uncommon: "Необычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная" };
const clothingCrafts = new Map();
const clothingMarket = [];
const itemContainerAuctions = [];
const cryptoHistory = {};
const businessCatalog = [
  { key: "coffee", name: "Кофейня у метро", industry: "Общепит", price: 850000, revenue: 62000, expenses: 39000, staffCost: 18000, description: "Небольшая точка с устойчивым утренним потоком." },
  { key: "service", name: "Детейлинг-центр", industry: "Автосервис", price: 2400000, revenue: 165000, expenses: 94000, staffCost: 42000, description: "Мойка, полировка и подготовка машин к продаже." },
  { key: "store", name: "Магазин у дома", industry: "Розница", price: 4200000, revenue: 285000, expenses: 186000, staffCost: 68000, description: "Повседневный спрос и понятная операционная модель." },
  { key: "logistics", name: "Городская доставка", industry: "Логистика", price: 7800000, revenue: 520000, expenses: 346000, staffCost: 112000, description: "Курьерская служба для магазинов и ресторанов." },
  { key: "hotel", name: "Мини-отель", industry: "Гостеприимство", price: 18500000, revenue: 1280000, expenses: 805000, staffCost: 260000, description: "Двадцать номеров с сезонной загрузкой." }
];

const players = new Map();
const sessions = new Map();
const emailVerifications = new Map();
const passwordResets = new Map();
const market = [];
const salesHistory = [];
const marketIndices = {};
const offers = new Map();
const chatMessages = [];
const directMessages = [];
const moderationReports = [];
const assetMarket = [];
const groups = new Map();
const partsMarket = [];
const partsSalesHistory = [];
const plateMarket = [];
const partIndices = {};
const paymentOrders = new Map();
const containerAuctions = [];
const containerTiers = {
  salvage: { label: "Разборка", name: "Забытый бокс", description: "Дешёвые проекты с большим количеством неисправностей", minValue: 50000, maxValue: 450000, startMin: 5000, startMax: 70000, color: "#6f736b" },
  cheap: { label: "Бюджетный", name: "Гаражная находка", description: "Массовые автомобили для первого оборота", minValue: 180000, maxValue: 1800000, startMin: 40000, startMax: 280000, color: "#52715d" },
  middle: { label: "Дилерский", name: "Дилерский склад", description: "Ликвидные машины среднего сегмента", minValue: 1200000, maxValue: 15000000, startMin: 300000, startMax: 2500000, color: "#aa792d" },
  performance: { label: "Спортивный", name: "Трековый ангар", description: "Купе, родстеры и мощные проекты", minValue: 7000000, maxValue: 80000000, startMin: 1500000, startMax: 12000000, color: "#356d78" },
  premium: { label: "Коллекционный", name: "Коллекционный бокс", description: "Редкие и премиальные автомобили верхнего сегмента", minValue: 35000000, maxValue: MAX_VEHICLE_VALUE, startMin: 8000000, startMax: 180000000, color: "#8b3d35" }
};
const clients = new Set();
let revision = 0;
let marketRotationNextAt = Date.now() + NPC_ROTATION_MS;
let persistTimer = null;
let loadedVehiclePricingVersion = 0;

function persistState() {
  const payload = JSON.stringify({
    players: [...players.entries()], sessions: [...sessions.entries()], emailVerifications: [...emailVerifications.entries()], passwordResets: [...passwordResets.entries()], market,
    offers: [...offers.entries()], salesHistory, marketIndices, chatMessages, directMessages, moderationReports, assetMarket,
    groups: [...groups.entries()], partsMarket, partsSalesHistory, plateMarket, partIndices, paymentOrders: [...paymentOrders.entries()], containerAuctions, clothingCrafts: [...clothingCrafts.entries()], clothingMarket, itemContainerAuctions, cryptoHistory,
    vehiclePricingVersion: VEHICLE_PRICING_VERSION
  });
  db.prepare("INSERT INTO game_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(payload, Date.now());
  s3SyncDirty = true;
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistState();
  }, 350);
  persistTimer.unref?.();
}

function loadState() {
  let row;
  try { row = db.prepare("SELECT payload FROM game_state WHERE id = 1").get(); }
  catch (error) { console.error(`STATE_READ_FAILED: ${error.message}`); return false; }
  if (!row) {
    console.warn(`STATE_EMPTY: database has no saved row at ${path.join(DATA_DIR, "game.db")}`);
    return false;
  }
  try {
    const saved = JSON.parse(row.payload);
    loadedVehiclePricingVersion = Number(saved.vehiclePricingVersion || 0);
    for (const [key, value] of saved.players || []) { ensurePlayerDefaults(value); players.set(key, value); }
    for (const [key, value] of saved.sessions || []) sessions.set(key, value);
    for (const [key, value] of saved.emailVerifications || []) emailVerifications.set(key, value);
    for (const [key, value] of saved.passwordResets || []) passwordResets.set(key, value);
    for (const car of saved.market || []) { ensureCarDefaults(car); market.push(car); }
    for (const [key, value] of saved.offers || []) offers.set(key, value);
    for (const sale of saved.salesHistory || []) salesHistory.push(sale);
    Object.assign(marketIndices, saved.marketIndices || {});
    chatMessages.push(...(saved.chatMessages || []).slice(-100));
    directMessages.push(...(saved.directMessages || []).slice(-1000));
    moderationReports.push(...(saved.moderationReports || []).slice(-500));
    assetMarket.push(...(saved.assetMarket || []).map(migrateProperty));
    for (const [key, value] of saved.groups || []) { ensureGroupDefaults(value); groups.set(key, value); }
    partsMarket.push(...(saved.partsMarket || []).map(ensurePartLot));
    partsSalesHistory.push(...(saved.partsSalesHistory || []).slice(-500));
    plateMarket.push(...(saved.plateMarket || []).map(ensurePlateLot));
    Object.assign(partIndices, saved.partIndices || {});
    for (const [key, value] of saved.paymentOrders || []) paymentOrders.set(key, value);
  containerAuctions.push(...(saved.containerAuctions || []));
  for (const [playerId, craft] of (saved.clothingCrafts || [])) clothingCrafts.set(playerId, craft);
  clothingMarket.push(...(saved.clothingMarket || [])); itemContainerAuctions.push(...(saved.itemContainerAuctions || [])); Object.assign(cryptoHistory, saved.cryptoHistory || {});
    console.log(`STATE_LOADED: ${players.size} players, ${market.length} market cars from ${path.join(DATA_DIR, "game.db")}`);
    return true;
  } catch (error) {
    console.error("Failed to load saved game:", error.message);
    return false;
  }
}

function ensurePlayerDefaults(player) {
  player.avatar ||= "";
  player.profileBadge ||= "";
  player.adminGranted ??= false;
  player.referralCode ??= generateReferralCode();
  player.referredBy ??= null;
  player.referralAppliedAt ??= null;
  player.referralCount ??= 0;
  player.referralCash ??= 0;
  player.email ||= null;
  player.passwordSalt ||= null;
  player.passwordHash ||= null;
  player.emailVerified ??= Boolean(player.email ? false : true);
  player.skills ||= {};
  player.equipment ||= {};
  player.skills.diagnostics ??= Math.max(player.skills.engine || 0, player.skills.chassis || 0);
  player.skills.mechanics ??= Math.max(player.skills.mechanic || 0, player.skills.tires || 0);
  player.skills.engineRepair ??= player.skills.mechanics || 0;
  player.skills.chassisRepair ??= player.skills.mechanics || 0;
  player.skills.tireService ??= player.skills.mechanics || 0;
  player.skills.bodywork ??= Math.max(player.skills.body || 0, player.skills.bodyRepair || 0);
  player.skills.appraisal ??= player.skills.documents || 0;
  player.skills.electrics ??= player.skills.electrician || 0;
  player.equipment.diagnosticKit ??= Math.max(player.equipment.scanner || 0, player.equipment.endoscope || 0, player.equipment.tools || 0);
  player.equipment.workshop ??= Math.max(player.equipment.lift || 0, player.equipment.torque || 0, player.equipment.tools || 0);
  player.equipment.engineStand ??= player.equipment.workshop || 0;
  player.equipment.chassisTools ??= player.equipment.workshop || 0;
  player.equipment.tireStation ??= player.equipment.workshop || 0;
  player.equipment.electricalBench ??= Math.max(player.equipment.multimeter || 0, player.equipment.scanner || 0);
  player.equipment.bodyStation ??= Math.max(player.equipment.gauge || 0, player.equipment.welder || 0);
  player.equipment.historyTerminal ??= player.equipment.vinScanner || 0;
  for (const key of Object.keys(skillInfo)) player.skills[key] ??= 0;
  for (const key of Object.keys(equipmentInfo)) player.equipment[key] ??= 0;
  player.stats ||= { purchases: 0, inspections: 0, serviceDiagnostics: 0, selfRepairs: 0, assistedRepairs: 0, workshopRepairs: 0, auctionsWon: 0, bids: 0, partsSold: 0, partsBought: 0, upgrades: 0, perfectInspections: 0 };
  for (const key of ["purchases", "inspections", "serviceDiagnostics", "selfRepairs", "assistedRepairs", "workshopRepairs", "auctionsWon", "bids", "partsSold", "partsBought", "upgrades", "assetsBought", "assetsSold", "perfectInspections"]) player.stats[key] ??= 0;
  player.chatState ||= { sentAt: [], lastNormalized: "", lastDuplicateAt: 0, violations: 0, mutedUntil: 0 };
  player.plateInventory ||= [];
  player.plateInventory = player.plateInventory.map(ensurePlate);
  player.bannedUntil ??= 0;
  player.banReason ||= "";
  player.ownedAssets ||= [];
  player.assetIncomeLastAt ??= Date.now();
  for (const asset of player.ownedAssets) if (asset.type === "property") {
    migrateProperty(asset);
    asset.incomeLastAt ??= asset.acquiredAt || player.assetIncomeLastAt;
    asset.rentalStatus ||= "vacant";
    asset.tenant ||= null;
    asset.taxLastAt ??= Date.now();
    asset.taxDebt ??= 0;
    asset.maintenance ??= 100;
  }
  player.businesses ||= [];
  player.reputation ||= { score: 50, completed: 0, failed: 0 };
  // Банк: кредиты, кредитная история и налог с продажи. Состояние живёт на игроке,
  // все формулы — в bank.js, чтобы их можно было проверять без сервера.
  player.loans ||= [];
  player.credit ||= { repaid: 0, missed: 0, seized: 0, blockedUntil: 0, income: [] };
  player.credit.income ||= [];
  for (const loan of player.loans) {
    loan.overdue ??= 0; loan.missed ??= 0; loan.missedTotal ??= 0; loan.paidPeriods ??= 0;
    loan.interestPaid ??= 0; loan.penaltyPaid ??= 0; loan.history ||= [];
    loan.nextPaymentAt ??= Date.now() + bank.LOAN_PERIOD_MS;
    if (!["active", "collection", "closed"].includes(loan.status)) loan.status = "active";
  }
  // Мошенничество: тёмная сторона карьеры. notoriety — «авторитет» среди серых схем,
  // suspicion — насколько внимательно смотрит рынок; на 100 приходит «обыск».
  ensurePlayerFraud(player);
  player.garageCapacity = Math.max(MAX_GARAGE, Number(player.garageCapacity) || MAX_GARAGE);
  player.parts ||= { common: 0, premium: 0 };
  player.garage ||= [];
  for (const car of player.garage) ensureCarDefaults(car);
  player.partInventory ||= [];
  player.partInventory.forEach((part, index) => migratePart(part, index, player.garage[index % Math.max(1, player.garage.length)]?.model));
  player.groupId ??= null;
  player.groupRole ??= null;
  player.contracts ||= [];
  player.purchasedCash ||= 0;
  player.supporterTier ||= "none";
  player.adminNotes ||= [];
  player.training ||= { lastAt: 0, completed: 0 };
  ensureActivityDefaults(player);
  player.containerRewards ||= [];
  player.notifications ||= [];
  player.ledger ||= [];
  player.achievements ||= { unlocked: [], claimed: [] };
  syncAchievements(player);
  if (!player.contracts.length) player.contracts = generateContracts(player);
  for (const contract of player.contracts) {
    if (contract.status !== "active" || !contract.model || !["profit", "honest"].includes(contract.kind)) continue;
    delete contract.model;
    contract.description = contract.kind === "profit" ? "Купите и продайте автомобиль с прибылью" : "Продайте автомобиль, честно указав его проблемы";
  }
}

function addLedger(player, type, title, amount = 0, details = {}, at = Date.now()) {
  if (!player) return;
  player.ledger ||= [];
  player.ledger.push({ id: id("ledger_"), type, title, amount: Math.round(Number(amount) || 0), at, ...details });
  if (player.ledger.length > 160) player.ledger.splice(0, player.ledger.length - 160);
}

function isAdmin(player) {
  const normalized = String(player?.normalizedName || player?.name || "").toLocaleLowerCase("ru-RU");
  return Boolean(player && (player.adminGranted || normalized === CONFIGURED_ADMIN_LOGIN || ADMIN_NAMES.has(normalized)));
}

function banMessage(player) {
  if (!player || isAdmin(player) || !player.bannedUntil) return "";
  if (player.bannedUntil !== -1 && player.bannedUntil <= Date.now()) {
    player.bannedUntil = 0; player.banReason = "";
    return "";
  }
  const period = player.bannedUntil === -1 ? "навсегда" : `до ${new Date(player.bannedUntil).toLocaleString("ru-RU")}`;
  return `Аккаунт заблокирован ${period}. Причина: ${player.banReason || "решение модератора"}`;
}

function ensureCarDefaults(car) {
  if (!catalog.some((item) => item.model === car.model)) {
    const referenceValue = Math.max(40000, Number(car.cleanValue) || Number(car.price) || 500000);
    const sameClass = catalog.filter((item) => item.className === car.className);
    const candidates = sameClass.length ? sameClass : catalog;
    const replacement = candidates.reduce((best, item) => Math.abs(item.base - referenceValue) < Math.abs(best.base - referenceValue) ? item : best, candidates[stablePartIndex(car.model) % candidates.length]);
    car.make = replacement.make; car.model = replacement.model; car.year = replacement.year; car.className = replacement.className; car.color = replacement.color;
    car.history ||= [];
    car.history.push({ type: "migration", text: `Каталог обновлён: автомобиль идентифицирован как ${replacement.model}`, at: Date.now() });
  }
  car.make ||= String(car.model || "Автомобиль").split(" ")[0];
  const catalogPhoto = catalogByModel.get(car.model) || catalog.find((item) => item.model === car.model);
  car.photoQuery ||= catalogPhoto?.photoQuery || car.model;
  car.photoUrl = catalogPhoto?.photoUrl || car.photoUrl || "";
  car.photoSource = catalogPhoto?.photoSource || car.photoSource || "";
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
  if (car.catalogRevision !== VEHICLE_PRICING_VERSION && car.cleanValue > 0 && car.year) {
    const rule = vehicleRule(car.model);
    const protectedAuction = car.saleType === "auction" && ((car.participantIds || []).length || car.highestBidderType === "player");
    if (rule.startYear && !protectedAuction) {
      const previousYear = car.year;
      car.year = Math.max(rule.startYear, Math.min(rule.endYear, car.year));
      const variants = catalog.filter(item => item.model === car.model);
      const reference = variants.reduce((best, item) => !best || Math.abs(item.year - car.year) < Math.abs(best.year - car.year) ? item : best, null);
      if (reference) car.cleanValue = Math.round(reference.base * (1 - Math.min(0.4, Math.max(0, car.mileage || 0) / 850000)) / 1000) * 1000;
      if (previousYear !== car.year) car.history.push({ type: "catalog", text: `Уточнён год выпуска: ${previousYear} → ${car.year}. Затраты на покупку и работы сохранены.`, at: Date.now() });
    }
    if (!protectedAuction) car.catalogRevision = VEHICLE_PRICING_VERSION;
  }
  car.installedParts ||= [];
  car.installedParts.forEach((part, index) => migratePart(part, index, car.model));
  car.upgrades ||= [];
  car.upgradeValue ||= 0;
  car.upgradeStage ||= car.upgrades.length;
  car.listedAt ||= car.history?.find((entry) => entry.type === "listed")?.at || Date.now();
  car.marketTag ??= null;
  car.participantIds ||= [];
  car.lastPlayerBidAt ??= null;
  car.lastNpcBidAt ??= null;
  car.publicDiscovered ||= [];
  car.publicInspectionRecords ||= {};
  car.registration ||= { registered: false, registeredAt: null, plate: null };
  car.registration.registered ??= false;
  car.registration.registeredAt ??= null;
  car.registration.plate ??= null;
  if (car.registration.plate) car.registration.plate = ensurePlate(car.registration.plate);
  car.plateIncluded ??= false;
  // Мошенничество: obman продавца (null = машина чистая), раскрытие по игрокам и «серые схемы».
  car.fraud ??= null;
  if (car.fraud && typeof car.fraud === "object") {
    car.fraud.type = fraudSpecKey(car.fraud.type);
    car.fraud.revealed ??= false;
    car.fraud.applied ??= false;
    car.fraudCheckedBy ||= {};
  }
  car.fraudCheckedBy ||= {};
  car.schemes ||= [];
  car.schemesExposed ??= false;
  car.scamDeposit ??= 0;
  car.starter ??= false;
}

function fraudSpecKey(key) { return fraud.fraudSpec(key) ? String(key) : null; }

// Дешёвые машины живут по своим ценам: каталожный ремонт за 118 000 ₽ на «копейке»
// за 60 000 ₽ означал бы, что с 50 000 ₽ стартовать невозможно. Поэтому repair и impact
// дефектов масштабируются от стоимости автомобиля (см. balance.defectScales).
function scaleDefectNumbers(car) {
  const scales = balance.defectScales(car.cleanValue);
  if (scales.repair >= 0.999 && scales.impact >= 0.999) return;
  for (const defect of car.defects) {
    if (defect.valueScaleApplied) continue;
    defect.repair = Math.max(balance.STARTER.repairFloor, Math.round(defect.repair * scales.repair / 100) * 100);
    defect.impact = Math.max(500, Math.round(defect.impact * scales.impact / 100) * 100);
    defect.valueScaleApplied = true;
  }
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

function migratePart(part, index = 0, fallbackModel = null) {
  if (!part || typeof part !== "object") return part;
  if (part.component === "universal") part.component = ["engine", "chassis", "body", "electrics", "tires"][index % 5];
  if (!partQualityCatalog[part.quality]) part.quality = part.quality === "premium" ? "original" : "analog";
  const componentDefects = Object.entries(defectPartCatalog).filter(([, spec]) => spec.component === part.component);
  const matched = componentDefects.find(([, spec]) => String(part.name || "").includes(spec.name));
  const [defectCode, spec] = matched || componentDefects[index % Math.max(1, componentDefects.length)] || ["timing_belt", defectPartCatalog.timing_belt];
  const model = part.compatibleModel && part.compatibleModel !== "all" && catalog.some((item) => item.model === part.compatibleModel) ? part.compatibleModel : fallbackModel || catalog[index % catalog.length].model;
  const catalogItem = catalog.find((item) => item.model === model) || catalog[index % catalog.length];
  const quality = partQualityCatalog[part.quality];
  part.component = spec.component;
  part.partKey ||= spec.sku;
  part.name = spec.name;
  part.compatibleModel = catalogItem.model;
  part.compatibleClass = catalogItem.className;
  part.generation = `${Math.max(1980, catalogItem.year - 4)}–${catalogItem.year + 6}`;
  part.conditionPct = clamp(Number(part.conditionPct) || 100, 20, 100);
  part.brand ||= quality.brands[index % quality.brands.length];
  part.reliability = clamp(Number(part.reliability) || Math.round(quality.reliability * part.conditionPct / 100), 20, 100);
  part.warrantyKm = Math.max(0, Number(part.warrantyKm) || Math.round(quality.warrantyKm * part.conditionPct / 100));
  part.defectCodes ||= Object.entries(defectPartCatalog).filter(([, item]) => item.sku === spec.sku).map(([code]) => code);
  part.estimatedValue = Math.max(500, Number(part.estimatedValue) || 1000);
  part.purchasePrice = Math.max(0, Number.isFinite(Number(part.purchasePrice)) ? Number(part.purchasePrice) : part.estimatedValue);
  part.source ||= part.quality === "restored" ? "Разбор" : "Старый склад";
  return part;
}

function stablePartIndex(value) {
  return [...String(value || "part")].reduce((hash, character) => ((hash * 31) + character.charCodeAt(0)) >>> 0, 0);
}

function ensureGroupDefaults(group) {
  group.treasury = Math.max(0, Number(group.treasury) || 0);
  group.rating = Math.max(0, Math.min(100, Number(group.rating) || 50));
  group.members ||= [];
  group.roles ||= {};
  group.garage ||= [];
  group.garageCapacity ||= 6;
  group.employees ||= [];
  group.activeJobs ||= [];
  group.businessLevel = Math.max(1, Number(group.businessLevel) || 1);
  group.businessXp = Math.max(0, Number(group.businessXp) || 0);
  group.completedJobs = Math.max(0, Number(group.completedJobs) || 0);
  group.totalRevenue = Math.max(0, Number(group.totalRevenue) || 0);
  group.totalBusinessProfit = Number(group.totalBusinessProfit) || 0;
  group.log ||= [];
  for (const employee of group.employees) {
    const candidate = employeeCandidates.find((item) => item.id === employee.id);
    employee.salary ||= candidate?.salary || 5000;
    employee.energy = clamp(Number.isFinite(Number(employee.energy)) ? Number(employee.energy) : 100, 0, 100);
    employee.experience = Math.max(0, Number(employee.experience) || 0);
    employee.jobsCompleted = Math.max(0, Number(employee.jobsCompleted) || 0);
    employee.busyJobId = group.activeJobs.find((job) => job.employeeId === employee.id)?.id || null;
  }
  for (const car of group.garage) ensureCarDefaults(car);
  return group;
}

function partSpecForDefect(defect) {
  return defect && defectPartCatalog[defect.code] ? defectPartCatalog[defect.code] : null;
}

function partBasePrice(car, defect) {
  const valueScale = clamp(Math.sqrt(Math.max(10000, car.cleanValue || 10000) / 500000), 0.35, 8);
  return Math.max(500, Math.round(defect.repair * 0.3 * valueScale / 500) * 500);
}

function partOffer(car, defect, qualityKey = "analog", conditionPct = 100) {
  const spec = partSpecForDefect(defect);
  if (!spec) return null;
  const quality = partQualityCatalog[qualityKey] || partQualityCatalog.analog;
  const condition = clamp(Math.round(conditionPct), 20, 100);
  const basePrice = partBasePrice(car, defect);
  const retailPrice = Math.max(500, Math.round(basePrice * quality.priceFactor * condition / 100 / 500) * 500);
  return { spec, quality, condition, retailPrice };
}

function makeSpecificPart(car, defect, qualityKey = "analog", conditionPct = 100, source = "Магазин") {
  const offer = partOffer(car, defect, qualityKey, conditionPct);
  if (!offer) return null;
  const { spec, quality, condition, retailPrice } = offer;
  const catalogItem = catalog.find((item) => item.model === car.model) || { year: car.year, className: car.className };
  return {
    id: `inventory_part_${crypto.randomBytes(7).toString("hex")}`, partKey: spec.sku, component: spec.component,
    name: spec.name, brand: quality.brands[randomInt(0, quality.brands.length - 1)], quality: quality.key,
    conditionPct: condition, reliability: clamp(Math.round(quality.reliability * condition / 100), 20, 100),
    warrantyKm: Math.round(quality.warrantyKm * condition / 100), compatibleClass: car.className,
    compatibleModel: car.model, generation: `${Math.max(1980, catalogItem.year - 4)}–${catalogItem.year + 6}`,
    defectCodes: Object.entries(defectPartCatalog).filter(([, item]) => item.sku === spec.sku).map(([code]) => code),
    estimatedValue: Math.max(500, Math.round(retailPrice * quality.valueFactor / 500) * 500),
    purchasePrice: retailPrice, source, sourceCar: car.model
  };
}

function makePart(component = "engine", quality = "analog", conditionPct = 100, compatibleClass = null, sourceCar = null) {
  const model = sourceCar && sourceCar !== "all" ? sourceCar : catalog[randomInt(0, catalog.length - 1)].model;
  const item = catalog.find((entry) => entry.model === model) || catalog[0];
  const candidates = defectCatalog.filter((defect) => partSpecForDefect(defect)?.component === component);
  const defect = candidates[randomInt(0, Math.max(0, candidates.length - 1))] || defectCatalog.find((entry) => partSpecForDefect(entry));
  return makeSpecificPart({ model: item.model, year: item.year, className: compatibleClass && compatibleClass !== "all" ? compatibleClass : item.className, cleanValue: item.base }, defect, quality, conditionPct, quality === "restored" ? "Разбор" : "Магазин");
}

function partStockType(part) {
  return part.quality === "original" ? "premium" : "common";
}

function ensurePartLot(lot) {
  const migrationIndex = stablePartIndex(lot.id);
  if (!lot.item) {
    const quality = lot.type === "premium" ? "original" : lot.condition === "used" ? "restored" : "analog";
    lot.item = makePart(["engine", "chassis", "body", "electrics", "tires"][migrationIndex % 5], quality, lot.condition === "used" ? 68 : 100, "all", catalog[migrationIndex % catalog.length].model);
  }
  migratePart(lot.item, migrationIndex);
  lot.sellerId ??= null;
  lot.createdAt ||= Date.now();
  return lot;
}

const plateLetters = "АВЕКМНОРСТУХ";
const plateRegions = ["01", "05", "16", "23", "50", "52", "63", "64", "66", "77", "78", "82", "92", "95", "96", "97", "98", "99", "102", "116", "123", "124", "134", "138", "142", "150", "152", "154", "156", "159", "161", "163", "164", "174", "177", "178", "186", "190", "193", "196", "197", "198", "199", "702", "716", "750", "761", "763", "774", "777", "790", "797", "799"];

function plateRarity(number) {
  const match = String(number || "").match(/^([АВЕКМНОРСТУХ])(\d{3})([АВЕКМНОРСТУХ]{2})/u);
  if (!match) return { key: "common", name: "Обычный" };
  const [, first, digits, tail] = match;
  if (digits.split("").every((digit) => digit === digits[0]) && first === tail[0] && first === tail[1]) return { key: "legendary", name: "Коллекционный" };
  if (digits.split("").every((digit) => digit === digits[0])) return { key: "premium", name: "Три одинаковые цифры" };
  if (digits[0] === digits[2] || new Set([first, ...tail]).size === 1) return { key: "rare", name: "Зеркальный" };
  return { key: "common", name: "Обычный" };
}

const plateValueRanges = { common: [3000, 9000], rare: [15000, 45000], premium: [80000, 320000], legendary: [1000000, 5000000] };

function plateEstimatedValue(number, rarityKey) {
  const [low, high] = plateValueRanges[rarityKey] || plateValueRanges.common;
  const steps = Math.floor((high - low) / 1000);
  return low + (stablePartIndex(number) % (steps + 1)) * 1000;
}

function makePlate(forceRarity = null) {
  const letter = () => plateLetters[randomInt(0, plateLetters.length - 1)];
  const roll = Math.random();
  const rarityRoll = forceRarity || (roll < 0.0005 ? "legendary" : roll < 0.005 ? "premium" : roll < 0.08 ? "rare" : "common");
  const first = letter();
  let digits = String(randomInt(1, 999)).padStart(3, "0");
  let tail = `${letter()}${letter()}`;
  if (rarityRoll === "common") {
    while (digits[0] === digits[2] || new Set([first, ...tail]).size === 1) {
      digits = String(randomInt(1, 999)).padStart(3, "0"); tail = `${letter()}${letter()}`;
    }
  }
  if (rarityRoll === "rare") { const edge = randomInt(1, 9); let middle = randomInt(0, 9); while (middle === edge) middle = randomInt(0, 9); digits = `${edge}${middle}${edge}`; }
  if (["premium", "legendary"].includes(rarityRoll)) {
    digits = String(randomInt(1, 9)).repeat(3);
    if (rarityRoll === "premium") while (tail === `${first}${first}`) tail = `${letter()}${letter()}`;
  }
  if (rarityRoll === "legendary") tail = `${first}${first}`;
  const region = plateRegions[randomInt(0, plateRegions.length - 1)];
  const number = `${first}${digits}${tail} ${region}`;
  const rarity = plateRarity(number);
  return { id: id("plate_"), number, region, rarity: rarity.key, rarityName: rarity.name, estimatedValue: plateEstimatedValue(number, rarity.key), valuationVersion: 2, acquiredAt: Date.now() };
}

function ensurePlate(plate) {
  if (!plate || typeof plate !== "object") return makePlate();
  plate.id ||= id("plate_");
  const rarity = plateRarity(plate.number);
  plate.rarity = rarity.key; plate.rarityName = rarity.name;
  plate.region ||= String(plate.number || "").split(" ").at(-1) || "77";
  if (Number(plate.valuationVersion || 0) < 2) plate.estimatedValue = plateEstimatedValue(plate.number, rarity.key);
  plate.estimatedValue = Math.max(1000, Math.round(Number(plate.estimatedValue) || plateEstimatedValue(plate.number, rarity.key)));
  plate.valuationVersion = 2;
  plate.acquiredAt ||= Date.now();
  return plate;
}

function ensurePlateLot(lot) {
  const previousValuationVersion = Number(lot.plate?.valuationVersion || lot.valuationVersion || 0);
  const previousMarketPricingVersion = Number(lot.marketPricingVersion || 0);
  lot.plate = ensurePlate(lot.plate || lot);
  lot.id ||= id("plate_lot_");
  if (!lot.sellerId && (previousValuationVersion < 2 || previousMarketPricingVersion < 2)) {
    const multiplier = 0.85 + (stablePartIndex(lot.id) % 31) / 100;
    lot.price = Math.max(1000, Math.round(lot.plate.estimatedValue * multiplier / 1000) * 1000);
  } else {
    lot.price = Math.max(1, Math.round(Number(lot.price) || lot.plate.estimatedValue));
    if (lot.sellerId && previousMarketPricingVersion < 2) lot.price = Math.min(lot.price, Math.round(lot.plate.estimatedValue * 1.25 / 1000) * 1000);
  }
  lot.marketPricingVersion = 2;
  lot.seller ||= "Регистрационная биржа";
  lot.sellerId ??= null;
  lot.createdAt ||= Date.now();
  return lot;
}

function restockPlateMarket() {
  while (plateMarket.filter((lot) => !lot.sellerId).length < 36) {
    const plate = makePlate();
    plateMarket.push(ensurePlateLot({ plate, price: Math.max(1000, Math.round(plate.estimatedValue * (0.82 + Math.random() * 0.42) / 1000) * 1000), marketPricingVersion: 2 }));
  }
}

function processNpcPlateBuyer() {
  const candidates = plateMarket.filter((lot) => lot.sellerId && lot.price <= lot.plate.estimatedValue * 1.12);
  if (!candidates.length || Math.random() > 0.38) return;
  const lot = candidates.sort((a, b) => (a.price / a.plate.estimatedValue) - (b.price / b.plate.estimatedValue))[0];
  const seller = players.get(lot.sellerId);
  if (!seller) return;
  const payout = Math.round(lot.price * 0.95);
  seller.cash += payout;
  addLedger(seller, "plate-sale", `Продажа номера ${lot.plate.number}`, payout, { counterparty: "Коллекционер номеров", category: "Госномера" });
  seller.notifications.push({ id: id("notification_"), type: "sale", title: "Номер продан", text: `${lot.plate.number} куплен за ${lot.price.toLocaleString("ru-RU")} ₽`, createdAt: Date.now(), read: false });
  seller.notifications = seller.notifications.slice(-50);
  plateMarket.splice(plateMarket.indexOf(lot), 1);
  restockPlateMarket();
  broadcast();
}

function detachPlate(player, car, reason = "Номер снят") {
  const plate = car.registration?.plate;
  if (!plate) return null;
  player.plateInventory.push(ensurePlate(plate));
  car.registration.plate = null;
  car.history.push({ type: "registration", text: `${reason}: ${plate.number}`, at: Date.now() });
  return plate;
}

function generateContracts(player = null) {
  const level = levelForXp(player?.xp || 0);
  const contractId = () => `contract_${crypto.randomBytes(7).toString("hex")}`;
  return [
    { id: contractId(), title: "Первая перепродажа", description: "Купите и продайте автомобиль с прибылью", kind: "profit", reward: balance.contractReward(42000, level), expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Честный подбор", description: "Продайте автомобиль, честно указав его проблемы", kind: "honest", reward: balance.contractReward(36000, level), expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Сервисная история", description: "Продайте диагностированную и отремонтированную машину", kind: "restored", reward: balance.contractReward(58000, level), expiresAt: Date.now() + 7 * 86400000, status: "active" }
  ];
}

const activityCatalog = {
  scout: { name: "Охота за скидкой", description: "Найдите лучший лот и удержите маркер в зоне точной оценки.", task: "Оценка лота", rounds: 2, reward: 9000, xp: 45 },
  negotiate: { name: "Жёсткие переговоры", description: "Сымитируйте торг с продавцом и добейтесь выгодной встречной цены.", task: "Переговоры", rounds: 3, reward: 15000, xp: 65 },
  workshop: { name: "Срочный заказ", description: "Соберите план ремонта без ошибок. Чем выше точность, тем больше оплата.", task: "План ремонта", rounds: 3, reward: 22000, xp: 85 },
  portfolio: { name: "Смешанный портфель", description: "Проверьте, как работает капитал в разных рынках: авто, вещь и недвижимость.", task: "Баланс активов", rounds: 2, reward: 30000, xp: 110 }
};

function dayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function ensureActivityDefaults(player) {
  const today = dayKey();
  player.activities ||= { day: today, completed: {}, streak: 0, lastDay: null };
  if (player.activities.day !== today) {
    player.activities = { day: today, completed: {}, streak: player.activities.streak || 0, lastDay: player.activities.day };
  }
  player.activities.completed ||= {};
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
  syncAchievements(player);
}

function currentValue(car) {
  ensureCarDefaults(car);
  scaleDefectNumbers(car);
  const unresolved = car.defects.filter((defect) => !defect.repaired).reduce((sum, defect) => sum + defect.impact, 0);
  const salvageFloor = car.starter
    ? Math.max(balance.STARTER.salvageFloor, Math.round(car.cleanValue * 0.22 / 1000) * 1000)
    : Math.max(40000, Math.round(car.cleanValue * 0.3 / 1000) * 1000);
  return Math.max(salvageFloor, Math.round((car.cleanValue + car.upgradeValue - unresolved) / 1000) * 1000);
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
    hire: ["Управляющий"], business: ["Управляющий"], roles: [], listParts: ["Управляющий", "Механик"]
  };
  return (permissions[permission] || []).includes(role);
}

function saleEstimate(car, player = null) {
  ensureCarDefaults(car);
  const employeePlayer = player || (car.sellerId && players.get(car.sellerId)) || null;
  const technicalValue = currentValue(car);
  const marketPrice = clamp(marketIndices[car.model]?.price || technicalValue, technicalValue * 0.72, technicalValue * 1.38);
  const unresolved = car.defects.filter((defect) => !defect.repaired);
  const repaired = car.defects.filter((defect) => defect.repaired);
  const inspection = inspectionSummary(car);
  const repairValue = repaired.reduce((sum, defect) => sum + defect.impact, 0);
  const repairQualityFactor = repaired.reduce((sum, defect) => sum + ({ "Восстановление": 1.2, "Стандартный ремонт": 0.85, "Бюджетный ремонт": 0.35, "Быстрый ремонт": 0.35 }[defect.repairQuality] || 0.7), 0);
  const repairPremium = Math.min(marketPrice * 0.09, repairValue * 0.055 + marketPrice * repairQualityFactor * 0.006);
  const documentationPremium = car.serviceDiagnosed ? marketPrice * 0.045 : inspection.confidence >= 70 ? marketPrice * 0.018 : 0;
  const restoredPremium = repaired.length && !unresolved.length ? marketPrice * 0.07 : 0;
  const upgradePremium = Math.min(marketPrice * 0.11, car.upgradeValue * 0.22);
  const conditionAdjustment = clamp((car.condition - 65) * marketPrice * 0.0022, -marketPrice * 0.08, marketPrice * 0.08);
  const repairLiquidityPenalty = repaired.length ? Math.min(marketPrice * 0.035, repaired.length * 7000) : 0;
  const employeePremium = marketPrice * (groupEmployeeRating(employeePlayer, "sales") / 100) * 0.04 + marketPrice * (groupEmployeeRating(employeePlayer, "appraisal") / 100) * 0.025;
  const propertyBonus = workplaceBenefits(employeePlayer).sales;
  const propertyPremium = Math.min(marketPrice * 0.16, marketPrice * propertyBonus);
  const installedPartsPremium = Math.min(marketPrice * 0.085, car.installedParts.reduce((sum, part) => {
    const qualityBonus = part.quality === "original" ? 1.35 : part.quality === "economy" ? 0.55 : part.quality === "restored" ? 0.7 : 1;
    return sum + part.estimatedValue * qualityBonus * (0.16 + part.reliability / 500);
  }, 0));
  const platePremium = car.plateIncluded && car.registration?.plate ? car.registration.plate.estimatedValue : 0;
  const expectedNpcPrice = Math.min(MAX_VEHICLE_VALUE, Math.max(1, Math.round((technicalValue * 0.58 + marketPrice * 0.42 + repairPremium + documentationPremium + restoredPremium + upgradePremium + conditionAdjustment - repairLiquidityPenalty + employeePremium + installedPartsPremium + platePremium + propertyPremium) / 1000) * 1000));
  const recommendedLow = Math.max(1, Math.round(expectedNpcPrice * 0.94 / 1000) * 1000);
  const recommendedHigh = Math.min(MAX_VEHICLE_VALUE, Math.max(recommendedLow, Math.round(expectedNpcPrice * 1.09 / 1000) * 1000));
  const breakEven = Math.max(1, Math.ceil(car.invested * 1.02 / 1000) * 1000);
  return {
    technicalValue, marketPrice, repairPremium: Math.round(repairPremium), documentationPremium: Math.round(documentationPremium + restoredPremium), upgradePremium: Math.round(upgradePremium),
    expectedNpcPrice, recommendedLow, recommendedHigh, breakEven, invested: car.invested,
    unresolvedCount: unresolved.length, repairedCount: repaired.length,
    inspectionConfidence: inspection.confidence, inspectionLabel: inspection.label, upgradeValue: car.upgradeValue, upgradeCount: car.upgrades.length,
    employeePremium: Math.round(employeePremium), installedPartsPremium: Math.round(installedPartsPremium), platePremium: Math.round(platePremium), propertyPremium: Math.round(propertyPremium)
  };
}

function upgradeOptions(car, player) {
  ensureCarDefaults(car);
  return upgradeCatalog.map((upgrade) => ({
    ...upgrade,
    buyerEffects: bots.slice(0, 5).map(bot => {
      const before = npcFit(car, bot, upgradeCatalog).multiplier;
      const after = npcFit({ ...car, upgrades: [...new Set([...car.upgrades, upgrade.key])] }, bot, upgradeCatalog).multiplier;
      return { name: bot.name, change: Math.round((after - before) * 1000) / 10 };
    }),
    cost: Math.max(500, Math.round(upgrade.cost * balance.upgradeScale(car) / 100) * 100),
    scaledValue: Math.max(500, Math.round(upgrade.value * balance.upgradeScale(car) / 100) * 100),
    installed: car.upgrades.includes(upgrade.key),
    canAfford: Boolean(player && player.cash >= Math.max(500, Math.round(upgrade.cost * balance.upgradeScale(car) / 100) * 100)),
    serviceCost: Math.max(500, Math.round(upgrade.cost * balance.upgradeScale(car) * 1.55 * (1 - (player?.skills.tuning || 0) * .04) / 100) * 100),
    canUse: Boolean(player && player.skills[upgrade.skill] >= upgrade.skillLevel && player.equipment[upgrade.equipment] >= upgrade.equipmentLevel)
  }));
}

function initializeMarketIndices() {
  for (const item of catalog) {
    const reference = modelReferenceValues.get(item.model) || item.base;
    if (marketIndices[item.model]?.price) {
      const index = marketIndices[item.model];
      index.price = Math.max(1000, Math.round(clamp(index.price, reference * 0.55, reference * 1.45) / 1000) * 1000);
      index.previousPrice = Math.max(1000, Math.round(clamp(index.previousPrice || index.price, reference * 0.55, reference * 1.45) / 1000) * 1000);
      continue;
    }
    const history = salesHistory.filter((sale) => sale.model === item.model).map((sale) => sale.price);
    const comparable = market.find((car) => car.model === item.model);
    marketIndices[item.model] = {
      price: average(history) || (comparable ? currentValue(comparable) : Math.round(reference * 0.75 / 1000) * 1000),
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
  const reference = modelReferenceValues.get(car.model) || car.cleanValue || before;
  index.price = Math.max(1000, Math.round(clamp(after, reference * 0.5, reference * 1.6) / 1000) * 1000);
  index.trend = Math.round(((after - before) / before) * 1000) / 10;
  index.transactions += 1;
  marketIndices[car.model] = index;
  marketStatsCacheAt = 0;
}

function serviceDiagnosticCost(car) {
  return Math.max(500, Math.round((balance.serviceDiagnosticBase(car) + car.cleanValue * 0.006) / 100) * 100);
}

// Стоимость осмотра привязана к цене машины: «осмотр всех систем» на автомобиле за
// 30 000 ₽ не должен стоить дороже самого автомобиля, иначе проверка документов
// и диагностика становятся непозволительной роскошью для того, кто стартует с нуля.
function inspectionCosts(car) {
  const scale = balance.inspectionScale(car);
  const value = Math.max(6000, Number(car?.cleanValue) || Number(car?.price) || Number(car?.invested) || 6000);
  const cap = Math.max(200, Math.round(value * 0.022 / 100) * 100);
  return Object.fromEntries(Object.entries(inspectionMethods).map(([key, option]) => [key, option.cost ? Math.max(100, Math.round(Math.min(option.cost * scale, cap) / 100) * 100) : 0]));
}

function serviceDiagnosticPrice(player, car) {
  const discount = groupEmployeeRating(player, "diagnostics") / 100 * 0.2;
  return Math.max(100, Math.round(serviceDiagnosticCost(car) * (1 - discount) / 100) * 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// БАНК: кредиты, налоговая и взыскание. Формулы живут в bank.js, здесь —
// состояние игрока, расписание платежей и удержания из выручки.
// ─────────────────────────────────────────────────────────────────────────────

function playerNetWorth(player) {
  if (!player) return 0;
  const garage = (player.garage || []).reduce((sum, car) => sum + Math.max(0, Number(car.invested) || Number(car.price) || 0), 0);
  const listed = market.filter((car) => car.sellerId === player.id).reduce((sum, car) => sum + Math.max(0, Number(car.invested) || Number(car.price) || 0), 0);
  const assets = (player.ownedAssets || []).reduce((sum, asset) => sum + Math.max(0, Number(asset.fairValue) || Number(asset.purchasePrice) || 0), 0);
  const plates = (player.plateInventory || []).reduce((sum, plate) => sum + Math.max(0, Number(plate.estimatedValue) || 0), 0);
  const parts = (player.parts?.common || 0) * 9000 + (player.parts?.premium || 0) * 21000;
  return Math.max(0, Math.round(player.cash + garage + listed + assets + plates + parts - bank.activeDebt(player)));
}

// Доход за один платёжный период: сглаженное среднее поступлений за три последних периода.
function incomePerPeriod(player) {
  const samples = player.credit?.income || [];
  const window = bank.LOAN_PERIOD_MS * 3;
  const since = Date.now() - window;
  const total = samples.reduce((sum, item) => (item.at >= since ? sum + Math.max(0, item.amount) : sum), 0);
  return Math.round(total / 3);
}

function rememberIncome(player, amount, kind = "sale") {
  if (!player) return;
  player.credit ||= { repaid: 0, missed: 0, seized: 0, blockedUntil: 0, income: [] };
  player.credit.income ||= [];
  player.credit.income.push({ at: Date.now(), amount: Math.max(0, Math.round(amount)), kind });
  if (player.credit.income.length > 60) player.credit.income.splice(0, player.credit.income.length - 60);
}

function bankContext(player) {
  const level = levelForXp(player.xp);
  const rating = bank.creditRating(player, level);
  const limit = bank.creditLimit(player, level, rating);
  return { level, rating, limit, netWorth: playerNetWorth(player), incomePerPeriod: incomePerPeriod(player) };
}

function bankView(player) {
  const { level, rating, limit, netWorth, incomePerPeriod: income } = bankContext(player);
  const products = bank.loanProducts.map((product) => {
    const availability = bank.productAvailability(product, player, level, rating, limit, { netWorth, incomePerPeriod: income });
    const quoteAmount = Math.max(10000, availability.maxAmount);
    const quote = bank.loanQuote(product, quoteAmount, rating);
    return {
      key: product.key, name: product.name, tag: product.tag, description: product.description,
      periods: product.periods, minLevel: product.minLevel, minRating: product.minRating,
      ratePct: quote.ratePct, available: availability.available, reason: availability.reason,
      maxAmount: availability.maxAmount, limiting: availability.decision.limiting,
      leverage: availability.decision.leverage, payment: quote.payment, fee: quote.fee, total: quote.total, overpayment: quote.overpayment
    };
  });
  const loans = (player.loans || []).map((loan) => ({
    id: loan.id, productKey: loan.productKey, name: loan.name, status: loan.status, principal: loan.principal,
    balance: loan.balance, overdue: loan.overdue, payment: loan.payment, fee: loan.fee, rate: loan.rate, periods: loan.periods,
    paidPeriods: loan.paidPeriods, missed: loan.missed, missedTotal: loan.missedTotal, nextPaymentAt: loan.nextPaymentAt,
    payoff: bank.payoffAmount(loan), issuedAt: loan.issuedAt, closedAt: loan.closedAt || null, history: (loan.history || []).slice(-6)
  })).sort((a, b) => (a.status === "closed") - (b.status === "closed") || b.issuedAt - a.issuedAt);
  const collection = bank.inCollection(player);
  return {
    rating, ratingLabel: bank.ratingLabel(rating), limit, netWorth, incomePerPeriod: income,
    debt: bank.activeDebt(player), collection, garnishRate: bank.GARNISH_RATE, periodMs: bank.LOAN_PERIOD_MS,
    maxActiveLoans: bank.MAX_ACTIVE_LOANS, missedBeforeCollection: bank.MISSED_BEFORE_COLLECTION,
    blockedUntil: player.credit?.blockedUntil || 0, loanCount: loans.length, products,
    loans: loans.slice(0, 8),
    history: { repaid: player.credit?.repaid || 0, missed: player.credit?.missed || 0, seized: player.credit?.seized || 0, issued: player.credit?.issued || 0 },
    tax: { ...bank.carSaleTax({ amount: 0, invested: 0, deals: player.deals || 0, level, showroomBonus: workplaceBenefits(player).sales }), ...bank.carTax }
  };
}

function createBankLoan(player, productKey, requestedAmount) {
  const product = bank.loanProducts.find((item) => item.key === String(productKey || ""));
  if (!product) throw new Error("Кредитный продукт не найден");
  const { level, rating, limit, netWorth, incomePerPeriod: income } = bankContext(player);
  const availability = bank.productAvailability(product, player, level, rating, limit, { netWorth, incomePerPeriod: income });
  if (!availability.available) throw new Error(availability.reason);
  const amount = Math.round(Number(requestedAmount) || availability.maxAmount);
  if (!Number.isFinite(amount) || amount < 10000) throw new Error("Минимальная сумма кредита — 10 000 ₽");
  if (amount > availability.maxAmount) throw new Error(`Банк одобрил максимум ${availability.maxAmount.toLocaleString("ru-RU")} ₽ по вашему капиталу, доходу и рейтингу. Уменьшите сумму.`);
  const loan = bank.createLoan(product, amount, rating, Date.now(), () => id("loan_"));
  player.loans.push(loan);
  player.cash += loan.principal - loan.fee;
  player.credit ||= { repaid: 0, missed: 0, seized: 0, blockedUntil: 0, income: [] };
  player.credit.issued = (player.credit.issued || 0) + 1;
  addLedger(player, "loan-issue", `Кредит «${loan.name}»`, loan.principal - loan.fee, { debt: bank.activeDebt(player), category: "Банк" });
  player.notifications.push({ id: id("notification_"), type: "bank", title: "Кредит выдан", text: `${loan.principal.toLocaleString("ru-RU")} ₽ на счёте. Платёж ${loan.payment.toLocaleString("ru-RU")} ₽ каждые ${Math.round(bank.LOAN_PERIOD_MS / 60000)} мин.`, createdAt: Date.now(), read: false });
  return loan;
}

function repayBankLoan(player, loanId, amount, full) {
  const loan = (player.loans || []).find((item) => item.id === String(loanId || ""));
  if (!loan || loan.status === "closed") { const error = new Error("Кредит уже закрыт или не найден"); error.status = 404; throw error; }
  const payoff = bank.payoffAmount(loan);
  const payment = full ? payoff : Math.round(Number(amount) || 0);
  if (!Number.isFinite(payment) || payment < 1000) throw new Error("Минимальное частичное погашение — 1 000 ₽");
  const available = Math.max(0, player.cash - reservedCash(player));
  if (available < Math.min(payment, payoff)) throw new Error(`Не хватает денег: для полного погашения нужно ${payoff.toLocaleString("ru-RU")} ₽`);
  const result = bank.applyEarlyRepayment(loan, Math.min(payment, payoff, available), Date.now());
  player.cash -= result.paid;
  if (loan.status === "closed") {
    player.credit.repaid = (player.credit.repaid || 0) + 1;
    player.credit.blockedUntil = 0;
    player.notifications.push({ id: id("notification_"), type: "bank", title: "Кредит закрыт", text: `«${loan.name}» погашен полностью, кредитная история улучшена.`, createdAt: Date.now(), read: false });
  }
  addLedger(player, "loan-repay", `Погашение «${loan.name}»`, -result.paid, { category: "Банк", debt: bank.activeDebt(player) });
  return result;
}

// Плановые платежи и взыскание: раз в несколько секунд банк списывает всё, что наступило.
function serviceBankLoans() {
  const now = Date.now();
  let changed = false;
  for (const player of players.values()) {
    if (!player.loans?.length) continue;
    for (const loan of player.loans.filter((item) => ["active", "collection"].includes(item.status))) {
      let guard = 0;
      while (loan.nextPaymentAt <= now && guard < 12) {
        guard += 1;
        const dueAt = loan.nextPaymentAt;
        const available = Math.max(0, player.cash - reservedCash(player));
        const result = bank.applyScheduledPayment(loan, available, now);
        if (result.charged > 0) {
          player.cash -= result.charged;
          addLedger(player, "loan-payment", `Платёж «${loan.name}»`, -result.charged, { category: "Банк", interest: result.interest });
          changed = true;
        }
        if (result.missed) {
          player.credit.missed = (player.credit.missed || 0) + 1;
          player.notifications.push({ id: id("notification_"), type: "bank", title: "Пропущен платёж", text: `«${loan.name}»: просрочка ${Math.round(loan.overdue).toLocaleString("ru-RU")} ₽. При трёх пропусках подряд банк начинает взыскание.`, createdAt: now, read: false });
          changed = true;
        }
        if (result.closed && result.charged > 0) player.credit.repaid = (player.credit.repaid || 0) + 1;
        if (result.collection && loan.status === "active") { loan.status = "collection"; changed = true; changed = seizeForCollection(player) || changed; }
        if (dueAt === loan.nextPaymentAt) break;
      }
    }
    if (player.credit?.blockedUntil && player.credit.blockedUntil < now) player.credit.blockedUntil = 0;
  }
  if (changed) { broadcast(); persistState(); }
}

// Взыскание: банк забирает автомобили и реализует их ниже рынка в счёт долга.
function seizeForCollection(player) {
  let changed = false;
  const limit = 3;
  for (let taken = 0; taken < limit; taken += 1) {
    const loan = (player.loans || []).find((item) => item.status === "collection");
    if (!loan) break;
    const owed = bank.payoffAmount(loan);
    if (owed <= 0) { loan.status = "closed"; player.credit.blockedUntil = Date.now() + bank.COLLECTION_COOLDOWN_MS; changed = true; break; }
    const car = [...(player.garage || [])].sort((a, b) => (b.invested || b.price || 0) - (a.invested || a.price || 0))[0];
    if (!car) { player.credit.blockedUntil = Date.now() + bank.COLLECTION_COOLDOWN_MS; break; }
    const index = player.garage.indexOf(car);
    player.garage.splice(index, 1);
    detachPlate(player, car, "Автомобиль изъят банком");
    const value = Math.max(1000, Math.round(Math.min(Math.max(1000, car.invested || car.price || 0), saleEstimate(car).expectedNpcPrice) * bank.COLLECTION_PRICE_FACTOR / 1000) * 1000);
    const applied = Math.min(value, owed);
    bank.applyEarlyRepayment(loan, applied, Date.now());
    if (applied > owed) player.cash += applied - owed;
    player.credit.seized = (player.credit.seized || 0) + 1;
    player.reputation.score = Math.max(0, player.reputation.score - 4);
    car.seller = "Банк (взыскание)"; car.sellerId = null; car.ownerId = null; car.price = value; car.invested = value; car.purchasePrice = value;
    car.history.push({ type: "seized", text: "Автомобиль изъят банком и продан в счёт долга", at: Date.now() });
    car.discovered = []; car.checkedCategories = []; car.inspectionRecords = {}; car.publicDiscovered = []; car.publicInspectionRecords = {};
    car.schemes = []; car.fraud = null; car.scamDeposit = 0;
    market.push(car);
    addLedger(player, "loan-seizure", `Изъятие автомобиля: ${car.model}`, -applied, { category: "Банк", value, carId: null });
    player.notifications.push({ id: id("notification_"), type: "bank", title: "Автомобиль изъят", text: `${car.model} реализован за ${value.toLocaleString("ru-RU")} ₽ в счёт долга. После закрытия кредита банк не кредитует ${Math.round(bank.COLLECTION_COOLDOWN_MS / 3600000)} ч.`, createdAt: Date.now(), read: false });
    if (bank.payoffAmount(loan) <= 0) { loan.status = "closed"; player.credit.blockedUntil = Date.now() + bank.COLLECTION_COOLDOWN_MS; }
    changed = true;
  }
  return changed;
}

// Налог с продажи и удержания в пользу банка. Вызывается после закрытия сделки.
function settleSaleWithBank(seller, car, amount, invested, dealIndex) {
  const level = levelForXp(seller.xp);
  const tax = bank.carSaleTax({ amount, invested, deals: dealIndex, level, showroomBonus: workplaceBenefits(seller).sales });
  let withheld = 0;
  if (tax.tax > 0) {
    const paid = Math.min(tax.tax, Math.max(0, seller.cash));
    seller.cash -= paid; withheld += paid;
    addLedger(seller, "tax", `Налог с продажи: ${car.model}`, -paid, { profit: tax.profit, rate: tax.rate, category: "Банк" });
  } else if (tax.holiday && tax.holidayDealsLeft > 0) {
    seller.notifications.push({ id: id("notification_"), type: "bank", title: "Налоговые каникулы", text: `Сделка без НДФЛ. Осталось льготных сделок: ${tax.holidayDealsLeft}.`, createdAt: Date.now(), read: false });
  }
  if (bank.inCollection(seller)) {
    const debt = bank.activeDebt(seller);
    const garnish = Math.min(Math.max(0, seller.cash), Math.round(amount * bank.GARNISH_RATE), debt);
    if (garnish > 0) {
      seller.cash -= garnish; withheld += garnish;
      let left = garnish;
      for (const loan of seller.loans.filter((item) => item.status === "collection")) {
        if (left <= 0) break;
        const applied = Math.min(left, bank.payoffAmount(loan));
        bank.applyEarlyRepayment(loan, applied, Date.now());
        left -= applied;
        if (bank.payoffAmount(loan) <= 0) { loan.status = "closed"; seller.credit.repaid = (seller.credit.repaid || 0) + 1; seller.credit.blockedUntil = Date.now() + bank.COLLECTION_COOLDOWN_MS; }
      }
      addLedger(seller, "loan-garnish", "Удержание из выручки в счёт долга", -garnish, { category: "Банк" });
    }
  }
  rememberIncome(seller, Math.max(0, amount - withheld));
  return tax;
}

setInterval(serviceBankLoans, 3000).unref();

// ─────────────────────────────────────────────────────────────────────────────
// МОШЕННИЧЕСТВО: обманутые NPC-объявления, юридические проверки, серые схемы игрока,
// подозрение и «развод с депозитом» от жадного покупателя.
// ─────────────────────────────────────────────────────────────────────────────

function ensureFraudDefaults(player) { ensurePlayerFraud(player); }
function ensurePlayerFraud(player) {
  player.fraud ||= {};
  const defaults = { notoriety: 0, suspicion: 0, schemes: 0, caught: 0, exposed: 0, claims: 0, claimsWon: 0, scammed: 0, scammedCash: 0, seizedCars: 0, finesPaid: 0, extraValue: 0, lastSchemeAt: 0, lastExposeAt: 0, blockedUntil: 0, suspicionAt: 0 };
  for (const [key, fallback] of Object.entries(defaults)) player.fraud[key] ??= fallback;
  player.fraud.history ||= [];
  player.fraud.suspicionAt ||= Date.now();
  return player.fraud;
}

function pushFraudHistory(player, entry) {
  ensurePlayerFraud(player);
  player.fraud.history.unshift({ id: id("fraud_event_"), at: Date.now(), ...entry });
  if (player.fraud.history.length > 40) player.fraud.history.length = 40;
}

function addSuspicion(player, amount) {
  const state = ensurePlayerFraud(player);
  state.suspicion = fraud.decaySuspicion(state.suspicion, Date.now() - state.suspicionAt);
  state.suspicionAt = Date.now();
  state.suspicion = Math.max(0, Math.min(100, Math.round((state.suspicion + Number(amount) || 0) * 10) / 10));
}

// Обманутые объявления: раскрытие через осмотр документов, юридическую проверку или диагностику.
function revealListingFraud(car, viewerId, source) {
  if (!car?.fraud) return false;
  car.fraud.revealed = true;
  car.fraudCheckedBy ||= {};
  car.fraudCheckedBy[viewerId] = { at: Date.now(), revealed: true, source };
  const spec = fraud.fraudSpec(car.fraud.type);
  if (!spec) return true;
  const defect = fraud.fraudDefect(spec, car);
  if (!car.defects.some((item) => item.code === defect.code)) {
    car.defects.push({ ...defect, valueScaleApplied: true });
    car.condition = Math.max(18, car.condition - spec.severity * 6);
  }
  for (const code of [defect.code]) {
    if (!car.publicDiscovered.includes(code)) car.publicDiscovered.push(code);
    if (!car.discovered.includes(code)) car.discovered.push(code);
    car.buyerFindings ||= {};
    car.buyerFindings[viewerId] = [...new Set([...(car.buyerFindings[viewerId] || []), code])];
  }
  car.history.push({ type: "fraud", text: `Раскрыто: ${spec.name}. ${spec.hint}`, at: Date.now() });
  return true;
}

// Раскрыли обман уже после покупки — машина приезжает с юридической проблемой в гараж.
function applyHiddenFraud(player, car) {
  if (!car.fraud || car.fraud.revealed || car.fraud.applied) return false;
  const spec = fraud.fraudSpec(car.fraud.type);
  if (!spec) { car.fraud = null; return false; }
  car.fraud.applied = true;
  const defect = fraud.fraudDefect(spec, car);
  car.defects.push({ ...defect, valueScaleApplied: true });
  for (const code of [defect.code]) if (!car.discovered.includes(code)) car.discovered.push(code);
  car.condition = Math.max(15, car.condition - spec.severity * 7);
  if (spec.mileageFactor && car.fraud.realMileage) car.mileage = Math.round(car.fraud.realMileage);
  const extra = [];
  for (let index = 0; index < (spec.extraDefects || 0); index += 1) {
    const pool = defectCatalog.filter((item) => item.category === "electrics" && !car.defects.some((existing) => existing.code === item.code));
    if (!pool.length) break;
    const picked = pool[randomInt(0, pool.length - 1)];
    const scales = balance.defectScales(car.cleanValue);
    const clone = { ...picked, repair: Math.max(balance.STARTER.repairFloor, Math.round(picked.repair * scales.repair / 100) * 100), impact: Math.max(500, Math.round(picked.impact * scales.impact / 100) * 100), valueScaleApplied: true, repaired: false, fraudFollowUp: spec.key };
    car.defects.push(clone);
    if (!car.discovered.includes(clone.code)) car.discovered.push(clone.code);
    extra.push(clone.name);
  }
  if (spec.blocksRegistration) car.legalHold = { type: spec.key, name: spec.name, note: spec.hint };
  car.sellerHistory ||= {};
  car.sellerHistory[player.id] = { boughtAt: Date.now(), price: car.price, fraud: spec.key };
  car.history.push({ type: "fraud", text: `После покупки вскрылось: ${spec.name}${extra.length ? ` (дополнительно: ${extra.join(", ")})` : ""}`, at: Date.now() });
  player.notifications.push({ id: id("notification_"), type: "fraud", title: "Вас обманули с машиной", text: `${spec.name}. ${spec.hint} Проблема в документах блокирует продажу — закройте её в сервисе или подайте претензию.`, carId: car.id, createdAt: Date.now(), read: false });
  pushFraudHistory(player, { kind: "victim", title: `Обманули при покупке: ${spec.name}`, carId: car.id, amount: -car.price });
  player.fraud.scammed += 1;
  // Считаем реальную потерю: во что обходится устранение обмана, а не вся цена машины.
  player.fraud.scammedCash += (car.defects || []).filter((item) => item.fraud && !item.repaired).reduce((sum, item) => sum + (item.impact || 0), 0);
  return true;
}

// Достаточно ли глубокий осмотр выбранной системы, чтобы увидеть обман.
function revealsFraudIn(car, { category, score = 0, serviceDiagnosed = false } = {}) {
  const spec = car?.fraud ? fraud.fraudSpec(car.fraud.type) : null;
  if (!spec || car.fraud.revealed) return false;
  return fraud.revealsFraud(spec, { category, score, serviceDiagnosed });
}

function fraudViewForCar(car, viewer) {
  const spec = car?.fraud ? fraud.fraudSpec(car.fraud.type) : null;
  const checked = viewer && car?.fraudCheckedBy?.[viewer.id];
  const own = viewer && (car.sellerId === viewer.id || car.ownerId === viewer.id);
  const confirmed = Boolean(car?.fraud && (car.fraud.revealed || checked?.revealed));
  const result = { status: "unknown", level: 0, signs: [] };
  if (confirmed && spec) {
    result.status = "confirmed"; result.name = spec.name; result.hint = spec.hint;
    result.consequence = spec.unregistrable ? "Регистрация невозможна, продажа заблокирована до закрытия вопроса."
      : spec.blocksRegistration ? "Пока обременение не снято, машину нельзя ни поставить на учёт, ни продать."
      : "Реальное состояние хуже заявленного: проверьте смету ремонта.";
    result.severity = spec.severity;
  } else if (checked && !confirmed) {
    result.status = "clear"; result.at = checked.at;
    result.note = checked.source === "legal" ? "Юридическая проверка: явных следов обмана не найдено. Гарантий это не даёт." : "Проверка документов прошла чисто.";
  } else if (spec && own) {
    result.status = "confirmed"; result.name = spec.name; result.hint = spec.hint;
  } else if (!car.sellerId && car.saleType !== "auction") {
    // Косвенные признаки — только по открытым данным объявления, без подсказок о типе обмана.
    let score = 0;
    const condition = Number(car.condition) || 0;
    const yearlyMileage = Math.max(0, (Number(car.mileage) || 0) / Math.max(1, 2026 - (Number(car.year) || 2026)));
    if (["Срочная продажа", "Под восстановление"].includes(car.marketTag) && condition >= 55) { score += 2; result.signs.push("Цена «срочной продажи» при хорошем состоянии"); }
    if (yearlyMileage && yearlyMileage < 6000) { score += 2; result.signs.push(`Пробег подозрительно мал для возраста: ~${Math.round(yearlyMileage).toLocaleString("ru-RU")} км в год`); }
    if (/сел и поехал|не бита|родной пробег|без вложений/i.test(car.description || "") && condition < 52) { score += 1; result.signs.push("Текст обещает «сел и поехал», а состояние проседает"); }
    if ((Number(car.listedAt) || 0) > Date.now() - 4 * 60000) { score += 1; result.signs.push("Продавец торопится: объявление появилось минуту назад"); }
    if (score >= 3) { result.status = "suspect"; result.level = Math.min(4, Math.round(score / 1.5)); }
  }
  if (own) {
    const schemes = (car.schemes || []).map((item) => fraud.schemeSpec(item.key || item)).filter(Boolean);
    result.schemes = schemes.map((item) => ({ key: item.key, name: item.name, bonus: item.priceBonus, risk: item.risk }));
    result.schemesExposed = Boolean(car.schemesExposed);
    if (schemes.length) {
      result.status = "dirty";
      result.deceptionBonus = Math.round(fraud.deceptionBonus(car) * 1000) / 10;
      result.risk = Math.round(fraud.detectionChance({ car, appraisal: viewer?.skills?.appraisal || 0, reputation: viewer?.reputation?.score || 50, suspicion: viewer?.fraud?.suspicion || 0, notoriety: viewer?.fraud?.notoriety || 0 }) * 100);
    }
  }
  return result;
}

// Покупатель (NPC или живой игрок) может раскусить «подготовку» уже после сделки.
function buyerAwareness(buyer) {
  if (!buyer) {
    const bot = bots[randomInt(0, bots.length - 1)];
    return { skill: (bot?.skill || 2) + ((bot?.inspectionSkills?.documents || 0) / 2), label: bot?.name || "покупатель" };
  }
  return { skill: levelForXp(buyer.xp) * 0.6 + (buyer.skills?.appraisal || 0) * 1.2 + (buyer.equipment?.historyTerminal || 0) * 0.6, label: buyer.name };
}

// Возврат сделки, если серую схему раскрыли. Возвращаем деньги покупателю, машину — продавцу.
function revertFraudulentSale(seller, buyer, car, amount, investedBeforeSale) {
  const awareness = buyerAwareness(buyer);
  const chance = fraud.detectionChance({
    car, buyerSkill: awareness.skill, appraisal: buyer?.skills?.appraisal || 0,
    reputation: seller.reputation?.score || 50, suspicion: seller.fraud?.suspicion || 0, notoriety: seller.fraud?.notoriety || 0
  });
  if (Math.random() >= chance) {
    const reward = fraud.schemeReward(car, levelForXp(seller.xp));
    ensurePlayerFraud(seller);
    seller.fraud.notoriety += reward.notoriety;
    seller.fraud.extraValue += Math.max(0, amount - investedBeforeSale);
    addXp(seller, reward.xp);
    seller.reputation.score = Math.max(0, seller.reputation.score + reward.reputation);
    addSuspicion(seller, Math.round((car.schemes || []).length * 6));
    car.schemes = [];
    car.schemesExposed = false;
    pushFraudHistory(seller, { kind: "scheme-passed", title: "Сделка прошла", carId: null, car: car.model, amount: Math.max(0, amount - investedBeforeSale) });
    seller.notifications.push({ id: id("notification_"), type: "fraud", title: "Покупатель ничего не заметил", text: `«${car.model}» ушёл по подготовленной цене. Подозрение рынка выросло.`, createdAt: Date.now(), read: false });
    return { caught: false };
  }
  const penalty = fraud.schemePenalty(car, { profit: Math.max(0, amount - investedBeforeSale), level: levelForXp(seller.xp), suspicion: seller.fraud?.suspicion || 0 });
  // Деньги покупателю, машина — продавцу (или изъятие, если гараж забит).
  if (buyer) buyer.cash += amount;
  const marketIndex = market.findIndex((item) => item.id === car.id);
  if (marketIndex >= 0) market.splice(marketIndex, 1);
  if (buyer && buyer.garage) {
    const buyerIndex = buyer.garage.findIndex((item) => item.id === car.id);
    if (buyerIndex >= 0) buyer.garage.splice(buyerIndex, 1);
    buyer.stats.purchases = Math.max(0, (buyer.stats.purchases || 0) - 1);
    addLedger(buyer, "fraud-refund", `Возврат по претензии: ${car.model}`, amount, { counterparty: seller.name, category: "Гараж" });
    buyer.notifications.push({ id: id("notification_"), type: "fraud", title: "Сделка расторгнута", text: `Вы заметили подготовку в «${car.model}» и вернули деньги. Продавцу выписан штраф.`, createdAt: Date.now(), read: false });
  }
  seller.cash = Math.max(0, seller.cash - amount);
  seller.deals = Math.max(0, seller.deals - 1);
  seller.profit = Math.round(seller.profit - Math.max(0, amount - investedBeforeSale));
  seller.reputation.score = Math.max(0, seller.reputation.score + penalty.reputation);
  ensurePlayerFraud(seller);
  seller.fraud.caught += 1;
  const fine = Math.min(penalty.fine, Math.max(0, seller.cash));
  seller.cash -= fine;
  seller.fraud.finesPaid += fine;
  addSuspicion(seller, penalty.suspicion);
  car.schemes = []; car.schemesExposed = true; car.plateIncluded = false;
  car.saleType = "fixed"; car.startingPrice = null; car.auctionEnd = null; car.highestBid = 0;
  car.highestBidderId = null; car.highestBidderName = null; car.highestBidderType = null; car.bidCount = 0; car.participantIds = [];
  car.seller = seller.name; car.sellerId = null; car.ownerId = seller.id;
  car.price = Math.max(1000, investedBeforeSale); car.invested = investedBeforeSale; car.purchasePrice = investedBeforeSale;
  car.history.push({ type: "fraud", text: `Сделка расторгнута: покупатель раскусил подготовку. Штраф ${fine.toLocaleString("ru-RU")} ₽`, at: Date.now() });
  if (seller.garage.length < seller.garageCapacity) {
    seller.garage.push(car);
    car.ownerId = seller.id;
  } else {
    seller.fraud.seizedCars += 1;
    car.sellerId = null; car.ownerId = null; car.seller = "Возврат на рынок"; car.marketTag = "Конфисковано рынком";
    car.price = Math.max(1000, Math.round(car.price * 0.85 / 1000) * 1000);
    car.listedAt = Date.now(); car.history.push({ type: "listed", text: "Машина вернулась на рынок: гараж продавца заполнен", at: Date.now() });
    market.unshift(car);
  }
  seller.fraud.notoriety = Math.max(0, seller.fraud.notoriety - 6);
  addLedger(seller, "fraud-fine", "Штраф за расторгнутую сделку", -fine, { category: "Риск" });
  pushFraudHistory(seller, { kind: "scheme-caught", title: "Схему раскрыли", car: car.model, amount: -fine, text: penalty.text });
  seller.notifications.push({ id: id("notification_"), type: "fraud", title: "Сделка сорвалась", text: penalty.text, createdAt: Date.now(), read: false });
  if (buyer) buyer.notifications.push({ id: id("notification_"), type: "fraud", title: "Вам вернули деньги", text: `Продавец «${car.model}» подделывал подготовку. Деньги возвращены.`, createdAt: Date.now(), read: false });
  return { caught: true, fine };
}

// «Обыск»: срабатывает, когда подозрение дошло до ста.
function serviceFraudRisk() {
  const now = Date.now();
  let changed = false;
  for (const player of players.values()) {
    const state = ensurePlayerFraud(player);
    const decayed = fraud.decaySuspicion(state.suspicion, now - (state.suspicionAt || now));
    if (Math.abs(decayed - state.suspicion) >= 0.5) { state.suspicion = decayed; state.suspicionAt = now; changed = true; }
    if (state.suspicion < 100) continue;
    const penalty = fraud.raidPenalty({ cash: player.cash, netWorth: playerNetWorth(player), level: levelForXp(player.xp) });
    const fine = Math.min(penalty.fine, Math.max(0, player.cash));
    player.cash -= fine;
    state.finesPaid += fine;
    player.reputation.score = Math.max(0, player.reputation.score + penalty.reputation);
    state.suspicion = penalty.suspicionAfter;
    state.suspicionAt = now;
    state.blockedUntil = now + (FRAUD_FAST ? FRAUD_BLOCK_MS : penalty.blockMs);
    if (penalty.seizesCar && player.garage.length) {
      const car = [...player.garage].sort((a, b) => (b.invested || 0) - (a.invested || 0))[0];
      player.garage.splice(player.garage.indexOf(car), 1);
      detachPlate(player, car, "Автомобиль изъят до разбирательства");
      const value = Math.max(1000, Math.round((car.invested || car.price || 1000) * 0.55 / 1000) * 1000);
      player.cash += value;
      state.seizedCars += 1;
      car.schemes = []; car.fraud = null; car.legalHold = null;
      car.history.push({ type: "fraud", text: `Автомобиль изъят до разбирательства, выплачено ${value.toLocaleString("ru-RU")} ₽`, at: now });
      addLedger(player, "fraud-seizure", `Изъятие автомобиля: ${car.model}`, value, { category: "Риск", profit: 0 });
    }
    addLedger(player, "fraud-fine", "Штраф по делу о мошенничестве", -fine, { category: "Риск" });
    pushFraudHistory(player, { kind: "raid", title: "Обыск", amount: -fine, text: penalty.text });
    player.notifications.push({ id: id("notification_"), type: "fraud", title: "Дело дошло до обыска", text: `${penalty.text} Рынок и торги закрыты на ${Math.max(1, Math.round((state.blockedUntil - now) / 60000))} мин.`, createdAt: now, read: false });
    changed = true;
  }
  if (changed) { broadcast(); persistState(); }
}

setInterval(serviceFraudRisk, FRAUD_RAID_INTERVAL_MS).unref();


function average(values) {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 0;
}

function marketStatistics() {
  if (marketStatsCache && Date.now() - marketStatsCacheAt < 1500) return marketStatsCache;
  const relevantModels = new Set([...market.map((car) => car.model), ...salesHistory.slice(-200).map((sale) => sale.model)]);
  const listingsByModel = new Map();
  for (const car of market) {
    const prices = listingsByModel.get(car.model) || [];
    prices.push(car.price);
    listingsByModel.set(car.model, prices);
  }
  const dealsByModel = new Map();
  for (const sale of salesHistory.slice(-200)) {
    const prices = dealsByModel.get(sale.model) || [];
    prices.push(sale.price);
    if (prices.length > 20) prices.shift();
    dealsByModel.set(sale.model, prices);
  }
  marketStatsCache = Object.fromEntries([...relevantModels].map((model) => {
    const item = catalogByModel.get(model) || catalog[0];
    const listingPrices = listingsByModel.get(model) || [];
    const dealPrices = dealsByModel.get(model) || [];
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
  marketStatsCacheAt = Date.now();
  return marketStatsCache;
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
  if (roll < 0.3) return { key: "urgent", tag: "Срочная продажа", min: 0.68, max: 0.78 };
  if (roll < 0.5) return { key: "project", tag: "Под восстановление", min: 0.6, max: 0.74 };
  if (roll < 0.9) return { key: "fair", tag: "Рыночная цена", min: 0.83, max: 0.97 };
  return { key: "optimistic", tag: "Есть торг", min: 1.05, max: 1.14 };
}

function makeCar(index, seller = "Авторынок", options = {}) {
  const starter = Boolean(options.starter);
  const item = catalog[index % catalog.length];
  const age = 2026 - item.year;
  const annualMileage = ["premium", "coupe", "roadster", "electric"].includes(item.className) ? [4, 11] : item.className === "classic" ? [3, 9] : ["van", "pickup"].includes(item.className) ? [12, 26] : [8, 18];
  const mileage = randomInt(Math.max(1, age * annualMileage[0]), Math.max(8, age * annualMileage[1])) * 1000;
  const pricing = starter ? (Math.random() < 0.6 ? { key: "urgent", tag: "Срочная продажа" } : { key: "project", tag: "Под восстановление" }) : npcPricingProfile();
  const naturalDefects = randomInt(1, Math.min(4, Math.floor(age / 4) + 1));
  const count = starter ? randomInt(1, 2) : pricing.key === "project" ? Math.max(3, naturalDefects) : naturalDefects;
  const pool = starter ? starterDefectPool(count) : [...defectCatalog].sort(() => Math.random() - 0.5).slice(0, count);
  if (!starter && !pool.some((defect) => defectPartCatalog[defect.code])) {
    const physicalDefects = defectCatalog.filter((defect) => defectPartCatalog[defect.code]);
    pool[0] = physicalDefects[randomInt(0, physicalDefects.length - 1)];
  }
  const wear = Math.min(0.4, mileage / 850000);
  const rawCleanValue = starter ? randomInt(balance.STARTER.valueMin, balance.STARTER.valueMax) : item.base * (1 - wear);
  const cleanValue = Math.round(rawCleanValue / 1000) * 1000;
  const provisional = { starter, cleanValue, defects: pool.map((defect) => ({ ...defect, repaired: false })) };
  scaleDefectNumbers(provisional);
  const fair = currentValue(provisional);
  const condition = clamp(95 - Math.round(wear * 100) - count * 7, starter ? 34 : 28, starter ? 78 : 92);
  const asking = npcAskingPrice({ ...provisional, model: item.model, year: item.year, mileage, catalogRevision: VEHICLE_PRICING_VERSION, condition }, pricing.key);
  const price = starter ? Math.min(asking, balance.starterPriceBand().max) : asking;
  // Часть «слишком хороших» объявлений — обманутые продавцы. Обман вскрывается
  // проверкой документов, юридической проверкой или полной диагностикой сервиса.
  const fraudKey = fraud.rollFraud({ askingRatio: price / Math.max(1, fair), condition, level: 1, forceChance: FRAUD_RATE });
  const listedAt = Date.now();
  const car = {
    id: id("car_"), make: item.make, photoQuery: item.photoQuery, photoUrl: item.photoUrl, photoSource: item.photoSource, model: item.model, year: item.year, mileage, price,
    purchasePrice: price, invested: price, seller, sellerId: null, ownerId: null, starter,
    color: item.color, className: item.className, cleanValue, condition,
    defects: provisional.defects, discovered: [], checkedCategories: [], inspectionRecords: {}, serviceDiagnosed: false, repairs: [],
    fraud: fraudKey ? { type: fraudKey, revealed: false, applied: false, realMileage: mileage } : null,
    description: starter
      ? ["Отдаю почти даром, времени возиться нет.", "Снял с себя, забирайте — и разберётесь.", "Машина старая, но на ходу. Торг уместен."][randomInt(0, 2)]
      : pricing.key === "project" ? "Цена снижена: автомобиль под восстановление, состояние проверяйте внимательно." : count <= 1 ? "Ухоженная машина, сел и поехал." : ["Едет бодро, есть возрастные моменты.", "Продажа без спешки. Торг у капота.", "На ходу каждый день, требует внимания."][randomInt(0, 2)],
    marketTag: pricing.tag, listedAt, npcPricingVersion: VEHICLE_PRICING_VERSION, catalogRevision: VEHICLE_PRICING_VERSION,
    history: [{ type: "listed", text: "Первичное объявление на рынке", at: listedAt }]
  };
  if (fraudKey === "odometer") car.mileage = Math.max(1000, Math.round(mileage / (fraud.fraudSpec("odometer")?.mileageFactor || 2) / 1000) * 1000);
  if (fraudKey === "odometer") car.description = "Один владелец, родной пробег, сел и поехал.";
  if (fraudKey === "salvage") car.description = "Не бита, не крашена, хранится в сухом гараже.";
  if (fraudKey === "ghost") car.description = "Срочно, оформлю всё за час.";
  return car;
}

// Для стартового сегмента берём «житейские» поломки: они ощутимы относительно цены,
// но закрываются своими руками — именно на этом поднимаются с нуля.
function starterDefectPool(count) {
  const wanted = ["oil_low", "brakes", "bearing", "puncture", "turn_signal", "generator", "uneven_tires", "paint", "oil_leak"];
  const pool = defectCatalog.filter((defect) => wanted.includes(defect.code));
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, Math.max(1, count));
  if (shuffled.length >= count) return shuffled;
  const filler = defectCatalog.filter((defect) => !shuffled.includes(defect)).sort(() => Math.random() - 0.5).slice(0, count - shuffled.length);
  return [...shuffled, ...filler];
}

let starterCatalogCache = null;
function starterCatalogIndices() {
  if (starterCatalogCache) return starterCatalogCache;
  const candidates = catalog.map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.collectible && item.base <= 420000 && (budgetMakes.has(item.make) || /lada|moskvich|uaz|gaz|zaz|iatz|razdany|dafi|tatra|trabant|tarpan|wartburg/i.test(item.model)))
    .sort((a, b) => a.item.base - b.item.base);
  const picked = [];
  const seen = new Set();
  // Дешёвые модели в каталоге идут длинными блоками по маркам, поэтому берём их кругами
  // по кузовам: на доске новичка должны быть и седаны, и хэтчбеки, и фургоны с пикапами.
  const groups = new Map();
  const stride = Math.max(1, Math.floor(candidates.length / 60));
  candidates.forEach((candidate, position) => {
    if (position % stride) return;
    const key = candidate.item.className || "other";
    const list = groups.get(key) || [];
    if (list.length < 8) groups.set(key, [...list, candidate]);
  });
  for (let round = 0; round < 8 && picked.length < 40; round += 1) {
    for (const list of groups.values()) {
      const candidate = list[round];
      if (!candidate || seen.has(candidate.item.model)) continue;
      seen.add(candidate.item.model);
      picked.push(candidate.index);
    }
  }
  starterCatalogCache = picked.length >= 6 ? picked : catalog.slice(0, 40).map((item, index) => index);
  return starterCatalogCache;
}

function npcAskingPrice(car, kind, unit = Math.random()) {
  ensureCarDefaults(car);
  const value = saleEstimate(car).expectedNpcPrice;
  const restored = structuredClone(car);
  let repairCost = 0;
  for (const defect of restored.defects.filter(item => !item.repaired)) {
    repairCost += Math.round(defect.repair * 1.15);
    defect.repaired = true; defect.repairQuality = "Стандартный ремонт"; defect.repairReliability = 88;
    restored.repairs.push(defect.name);
    restored.condition = Math.min(100, restored.condition + defect.severity * 4);
  }
  return acquisitionPrice({ value, restorationValue: saleEstimate(restored).expectedNpcPrice, repairCost, kind, unit });
}

function publicDefect(defect, car = null) {
  const owner = car ? players.get(car.ownerId || car.sellerId) : null;
  const benefits = workplaceBenefits(owner);
  const repairDiscount = Math.min(.3, benefits.repair + (owner?.skills.mechanics || 0) * .02);
  const repairSkill = defect.category === "engine" ? "engineRepair" : defect.category === "chassis" ? "chassisRepair" : defect.category === "tires" ? "tireService" : defect.category === "body" ? "bodywork" : defect.category === "electrics" ? "electrics" : "appraisal";
  const repairEquipment = defect.category === "engine" ? "engineStand" : defect.category === "chassis" ? "chassisTools" : defect.category === "tires" ? "tireStation" : defect.category === "body" ? "bodyStation" : defect.category === "electrics" ? "electricalBench" : "historyTerminal";
  const selfRepairable = defect.category !== "documents";
  const partSpec = partSpecForDefect(defect);
  const analogOffer = car && partSpec ? partOffer(car, defect, "analog") : null;
  const laborBase = partSpec && analogOffer ? Math.max(500, defect.repair - analogOffer.retailPrice) : defect.repair;
  const standardPartPrice = analogOffer ? Math.max(500, Math.round(analogOffer.retailPrice * 1.12 * (1 - benefits.parts) / 500) * 500) : 0;
  const standardQuote = repairQuote({ labor: laborBase, partPrice: standardPartPrice, discount: repairDiscount });
  const serviceRepairCost = standardQuote.total;
  return {
    code: defect.code, category: defect.category, name: defect.name, symptom: defect.symptom,
    consequence: defect.consequence, severity: defect.severity, skill: defect.skill,
    partName: partSpec?.name || null, partKey: partSpec?.sku || null, partRequired: Boolean(partSpec), partComponent: partSpec?.component || null,
    equipment: defect.equipment, equipmentLevel: defect.equipmentLevel,
    repair: serviceRepairCost, repaired: defect.repaired, repairQuality: defect.repairQuality || null, repairReliability: defect.repairReliability || null,
    servicePlans: car ? Object.entries(repairPlans).map(([key, plan]) => {
      const offer = partSpec ? partOffer(car, defect, plan.quality) : null;
      const partPrice = offer ? Math.max(500, Math.round(offer.retailPrice * 1.12 * (1 - benefits.parts) / 500) * 500) : 0;
      const quote = repairQuote({ labor: laborBase, partPrice, plan: key, discount: repairDiscount });
      const projected = structuredClone(car);
      const repairedDefect = projected.defects.find(item => item.code === defect.code);
      Object.assign(repairedDefect, { repaired: true, repairQuality: plan.name, repairReliability: Math.min(plan.reliability, offer?.quality.reliability ?? 100) });
      projected.repairs.push(defect.name);
      projected.condition = Math.min(100, projected.condition + Math.round(defect.severity * 4));
      const forecast = saleEstimate(projected, owner).expectedNpcPrice;
      return { ...quote, forecastLow: Math.round(forecast * .94 / 1000) * 1000, forecastHigh: Math.round(forecast * 1.09 / 1000) * 1000, projectedProfit: Math.round(forecast - car.invested - quote.total), risk: 100 - Math.min(plan.reliability, offer?.quality.reliability ?? 100) };
    }) : [],
    selfRepairable,
    serviceRepairCost, serviceLaborCost: standardQuote.labor,
    assistedRepairCost: Math.max(500, Math.round(laborBase * 0.58 * (1 - repairDiscount) / 500) * 500),
    selfRepairCost: Math.max(500, Math.round(laborBase * 0.3 * (1 - repairDiscount) / 500) * 500),
    repairSkill, repairSkillLevel: Math.min(5, defect.severity + 1),
    repairEquipment, repairEquipmentLevel: defect.severity,
    assistedSkillLevel: defect.severity,
    assistedEquipmentLevel: Math.max(0, defect.severity - 1)
  };
}

// «Сначала устраните известные неисправности» — правило продавца: игрок не может выставить
// машину, дефекты которой уже найдены. Для NPC-объялений оно сыграло бы злую шутку: бот,
// осмотрев дешёвый лот и найдя неисправность, навсегда снял бы его с рынка — а именно с таких
// лотов начинается старт с 50 000 ₽. Такие машины покупаются как есть: чинишь и продаёшь.
function listingBlockReason(car) { return car?.sellerId || car?.ownerId ? saleBlockReason(car) : null; }

function publicCar(car, ownerView = false, viewer = null) {
  ensureCarDefaults(car);
  const visibleCodes = new Set([
    ...(car.publicDiscovered || []),
    ...(ownerView ? car.discovered : []),
    ...(car.saleType === "auction" ? car.defects.filter((defect) => !defect.repaired).map((defect) => defect.code) : [])
  ]);
  const result = {
    id: car.id, make: car.make, photoQuery: car.photoQuery, photoUrl: car.photoUrl, photoSource: car.photoSource, model: car.model, year: car.year, mileage: car.mileage, price: car.price,
    saleBlocked: Boolean(listingBlockReason(car)), saleBlockReason: listingBlockReason(car),
    seller: car.seller, sellerId: car.sellerId, color: car.color, className: car.className,
    condition: car.condition, description: car.description, repairs: car.repairs,
    registration: { registered: Boolean(car.registration.registered), plate: car.registration.plate ? { ...car.registration.plate } : null },
    plateIncluded: Boolean(car.plateIncluded),
    marketTag: car.sellerId ? null : car.marketTag, listedAt: car.listedAt, starter: Boolean(car.starter),
    offerCount: [...offers.values()].filter((offer) => offer.carId === car.id && ["active", "counter"].includes(offer.status)).length,
    saleType: car.saleType || "fixed", auctionEnd: car.auctionEnd || null,
    startingPrice: car.startingPrice || null, highestBid: car.highestBid || 0,
    highestBidderName: car.highestBidderName || null, highestBidderType: car.highestBidderType || null, bidCount: car.bidCount || 0,
    viewerLeading: Boolean(viewer && car.highestBidderType === "player" && car.highestBidderId === viewer.id),
    viewerParticipated: Boolean(viewer && car.participantIds.includes(viewer.id))
  };
  result.publicInspectionRecords = car.publicInspectionRecords || {};
  result.inspectionCosts = inspectionCosts(car);
  result.fraud = fraudViewForCar(car, viewer || (car.sellerId ? players.get(car.sellerId) : null));
  if (viewer && (car.sellerId === viewer.id || car.ownerId === viewer.id)) result.fraudLegalHold = car.legalHold ? { name: car.legalHold.name, note: car.legalHold.note } : null;
  if (viewer) result.fraudCheckCost = fraud.legalCheckCost(car);
  result.citableDefects = viewer ? car.defects.filter(defect => !defect.repaired && car.buyerFindings?.[viewer.id]?.includes(defect.code)).map(defect => ({ code: defect.code, name: defect.name })) : [];
  if (car.groupContributorId) { result.groupContributorId = car.groupContributorId; result.groupContributorName = car.groupContributorName; }
  if (ownerView || (viewer && car.ownerId === viewer.id)) {
    result.defects = car.defects.filter((defect) => visibleCodes.has(defect.code)).map((defect) => publicDefect(defect, car));
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
    result.defects = car.defects.filter((defect) => visibleCodes.has(defect.code)).map((defect) => publicDefect(defect, car));
    result.publicInspection = { checked: Object.keys(car.publicInspectionRecords || {}), confidence: Object.values(car.publicInspectionRecords || {}).reduce((sum, record) => sum + record.confidence, 0) };
  }
  return result;
}

function playerPartNeeds(player) {
  return player.garage.flatMap((car) => {
    ensureCarDefaults(car);
    return car.defects
      .filter((defect) => !defect.repaired && car.discovered.includes(defect.code) && partSpecForDefect(defect))
      .map((defect) => {
        const publicInfo = publicDefect(defect, car);
        return {
          id: `${car.id}:${defect.code}`, carId: car.id, carModel: car.model, carYear: car.year, defect: publicInfo,
          offers: ["economy", "analog", "original"].map((qualityKey) => {
            const offer = partOffer(car, defect, qualityKey);
            return { quality: qualityKey, name: partQualityCatalog[qualityKey].name, price: offer.retailPrice, reliability: offer.quality.reliability, warrantyKm: offer.quality.warrantyKm };
          })
        };
      });
  });
}

// Признаки развода показываем «со скидкой на точность»: игрок видит косвенные
// признаки и сумму депозита, но не знает наверняка — иначе «раскрыть» было бы бесплатно.
function offerView(offer, viewer = null) {
  const car = market.find((item) => item.id === offer.carId);
  const bot = bots.find(item => item.id === offer.buyerId);
  const { kind, signs, ...rest } = offer;
  const suspicion = fraud.scamSuspicionScore(offer, { level: levelForXp(viewer?.xp || 0), price: car?.price || offer.amount, reputation: viewer?.reputation?.score || 50 });
  return {
    ...rest,
    suspicion: { score: suspicion, deposit: offer.deposit || 0, signs: suspicion >= 45 ? (signs || []).slice(0, 2) : [] },
    saleBlocked: car ? Boolean(listingBlockReason(car)) : false,
    profile: bot ? { ...npcProfile(bot), inspectionSkills: bot.inspectionSkills } : null,
    relationship: bot ? players.get(offer.sellerId)?.npcRelations?.[bot.id] || 0 : null,
    car: car ? { id: car.id, model: car.model, price: car.price, color: car.color, year: car.year } : offer.car
  };
}

function assetResaleValue(asset, player) {
  if (asset.type === "crypto") {
    const quotes = assetMarket.filter((listing) => listing.type === "crypto" && listing.key === asset.key && listing.stock > 0);
    const unitPrice = quotes.length ? quotes.reduce((sum, listing) => sum + listing.unitPrice, 0) / quotes.length : asset.unitPrice;
    const feeRate = Math.max(0.012, 0.032 - (player.skills.cryptoTrading || 0) * 0.004);
    return Math.max(1, Math.round(unitPrice * asset.quantity * (1 - feeRate)));
  }
  const skill = player.skills[asset.skill] || 0;
  const base = asset.fairValue || asset.basePrice || asset.purchasePrice;
  return Math.max(1, Math.round(base * (0.76 + skill * 0.045) / 1000) * 1000);
}

function propertyIncomeState(asset, player, now = Date.now()) {
  if (asset.type !== "property") return { cycles: 0, amount: 0, nextAt: null, perCycle: 0, taxDue: 0, netPerCycle: 0 };
  const lastAt = asset.incomeLastAt || asset.acquiredAt || now;
  const elapsedCycles = Math.min(10, Math.floor((now - lastAt) / ASSET_INCOME_CYCLE_MS));
  const managementBonus = 1 + (player.skills.propertyManagement || 0) * 0.06;
  const occupied = asset.rentalStatus === "rented";
  const grossPerCycle = occupied ? Math.round((asset.income || 0) * managementBonus * (1 + (asset.workplaceLevel || 0) * .08) * (asset.maintenance ?? 100) / 100) : 0;
  const operatingCost = occupied ? Math.round(grossPerCycle * 0.12) : 0;
  const taxPerCycle = Math.max(100, Math.round((asset.fairValue || asset.purchasePrice || 0) * 0.00018));
  const taxCycles = Math.min(60, Math.floor((now - (asset.taxLastAt || now)) / ASSET_INCOME_CYCLE_MS));
  const taxDue = (asset.taxDebt || 0) + taxCycles * taxPerCycle;
  const netPerCycle = Math.max(0, grossPerCycle - operatingCost);
  const afterTax = netPerCycle - taxPerCycle;
  return { cycles: elapsedCycles, amount: netPerCycle * elapsedCycles, nextAt: lastAt + (elapsedCycles + 1) * ASSET_INCOME_CYCLE_MS, perCycle: grossPerCycle, netPerCycle, operatingCost, taxPerCycle, taxDue, occupied, afterTax, paybackMinutes: afterTax > 0 ? Math.ceil(((asset.purchasePrice || 0) + (asset.upgradeInvestment || 0)) / afterTax) : null, upgradeCost: Math.round((asset.purchasePrice || asset.fairValue) * .08 * (1 + (asset.workplaceLevel || 0))) };
}

function assetIncomeAvailable(player, now = Date.now()) {
  return player.ownedAssets.reduce((sum, asset) => sum + propertyIncomeState(asset, player, now).amount, 0);
}

function businessState(business, now = Date.now()) {
  const lastAt = business.lastCollectedAt || business.acquiredAt || now;
  const cycles = Math.min(10, Math.floor((now - lastAt) / ASSET_INCOME_CYCLE_MS));
  const levelFactor = 1 + (business.level - 1) * 0.16;
  const staffFactor = 0.9 + business.staff * 0.08;
  const reputationFactor = 0.9 + business.reputation / 500;
  const revenue = Math.round(business.revenue * levelFactor * staffFactor * reputationFactor);
  const expenses = Math.round((business.expenses * levelFactor) + Math.max(0, business.staff - 1) * business.staffCost * 0.55);
  const profitPerCycle = Math.max(0, revenue - expenses);
  return { cycles, revenue, expenses, profitPerCycle, amount: profitPerCycle * cycles, nextAt: lastAt + (cycles + 1) * ASSET_INCOME_CYCLE_MS };
}

function migrateProperty(asset) {
  const template = assetCatalog.find((item) => item.key === asset.key);
  if (asset.type === "property" && template?.propertyRole) {
    Object.assign(asset, { name: asset.name || template.name, propertyRole: template.propertyRole, roleName: template.roleName, carBonus: template.carBonus });
  }
  return asset;
}

function publicAssetListing(listing, player) {
  const skillLevel = player?.skills?.[listing.skill] || 0;
  const spread = Math.max(0.04, 0.2 - skillLevel * 0.03);
  const { fairValue, ...publicListing } = listing;
  return {
    ...publicListing,
    estimateLow: Math.round(listing.fairValue * (1 - spread) / 1000) * 1000,
    estimateHigh: Math.round(listing.fairValue * (1 + spread) / 1000) * 1000,
    skillLevel, propertyHistory: listing.type === "property" ? propertyHistory(listing) : undefined
  };
}

function propertyHistory(asset) {
  const base = asset.fairValue || asset.basePrice || asset.purchasePrice || 1; const points = [];
  for (let index = 23; index >= 0; index -= 1) {
    const wave = Math.sin((stableVehicleUnit(asset.key || asset.name, "property") * 4 + index) * .62) * .035;
    const trend = (23 - index) * .0035; const value = Math.round(base * (0.91 + trend + wave) / 1000) * 1000;
    const grossYield = (asset.income || 0) * 12 / Math.max(1, value) * 100;
    points.push({ at: Date.now() - index * 30 * 86400000, value, grossYield: Math.round(grossYield * 100) / 100 });
  }
  return points;
}

function createAssetListing(template) {
  if (template.type === "crypto") {
    const quantityRanges = { crypton: [0.25, 1.4], ethera: [2, 12], solaris: [10, 65], garage_coin: [500, 3500] };
    const [low, high] = quantityRanges[template.key];
    const quantity = Math.round((low + Math.random() * (high - low)) * 100) / 100;
    const unitPrice = Math.max(1, Math.round(template.basePrice * (0.92 + Math.random() * 0.16)));
    return { ...template, id: id("asset_"), quantity, unitPrice, fairValue: unitPrice * quantity, price: Math.round(unitPrice * quantity * 1.012), changePct: 0, stock: 1, seller: "Цифровая биржа", listedAt: Date.now() };
  }
  const condition = template.type === "property" ? randomInt(58, 96) : randomInt(62, 100);
  const fairValue = Math.max(1000, Math.round(template.basePrice * (0.72 + condition / 350) / 1000) * 1000);
  const price = Math.max(1000, Math.round(fairValue * (0.82 + Math.random() * 0.34) / 1000) * 1000);
  return { ...template, id: id("asset_"), condition, fairValue, price, stock: template.type === "property" ? 1 : randomInt(1, 4), seller: template.type === "property" ? "Агентство Капитал" : "Ликвидационный склад", listedAt: Date.now() };
}

function updateCryptoMarket() {
  let changed = false;
  for (const listing of assetMarket.filter((item) => item.type === "crypto" && item.stock > 0)) {
    const move = (Math.random() * 2 - 1) * listing.volatility;
    const oldPrice = listing.unitPrice;
    listing.unitPrice = Math.max(1, Math.round(oldPrice * (1 + move)));
    listing.changePct = Math.round((listing.unitPrice / oldPrice - 1) * 1000) / 10;
    listing.fairValue = listing.unitPrice * listing.quantity;
    listing.price = Math.max(1, Math.round(listing.fairValue * 1.012));
    cryptoHistory[listing.key] ||= [];
    cryptoHistory[listing.key].push({ at: Date.now(), price: listing.unitPrice });
    if (cryptoHistory[listing.key].length > 120) cryptoHistory[listing.key].splice(0, cryptoHistory[listing.key].length - 120);
    changed = true;
  }
  if (changed) broadcast();
}

function restockAssetMarket() {
  for (const template of assetCatalog) {
    const active = assetMarket.filter((listing) => listing.key === template.key && listing.stock > 0).length;
    for (let index = active; index < 2; index += 1) assetMarket.push(createAssetListing(template));
  }
  if (assetMarket.length > assetCatalog.length * 3) assetMarket.splice(0, assetMarket.length - assetCatalog.length * 3);
}

function publicGroupView(group, viewer) {
  ensureGroupDefaults(group);
  return {
    id: group.id, name: group.name, ownerId: group.ownerId, rating: group.rating, treasury: group.treasury,
    garageCapacity: group.garageCapacity, garage: group.garage.map((car) => publicCar(car, true, viewer)), employees: group.employees,
    businessLevel: group.businessLevel, businessXp: group.businessXp, businessXpRequired: group.businessLevel * 200,
    jobSlots: Math.min(3, 1 + Math.floor((group.businessLevel - 1) / 2)), completedJobs: group.completedJobs,
    totalRevenue: group.totalRevenue, totalBusinessProfit: group.totalBusinessProfit,
    activeJobs: group.activeJobs.map((job) => ({ ...job })),
    members: group.members.map((playerId) => {
      const member = players.get(playerId);
      return { id: playerId, name: member?.name || "Неизвестный игрок", role: group.roles[playerId] || member?.groupRole || "Участник" };
    }),
    log: group.log.slice(-30), permissions: {
      treasury: groupCan(viewer, "treasury"), garage: groupCan(viewer, "garage"), hire: groupCan(viewer, "hire"), business: groupCan(viewer, "business"), roles: group.ownerId === viewer.id
    }
  };
}

function playerView(player) {
  ensureActivityDefaults(player);
  const reserved = reservedCash(player);
  const playerLevel = levelForXp(player.xp);
  const equipmentPrices = Object.fromEntries(Object.entries(equipmentInfo).map(([key, info]) => {
    const next = (player.equipment[key] || 0) + 1;
    if (next > 3) return [key, null];
    return [key, next === 1 ? balance.equipmentPrice(info.prices, playerLevel) : info.prices[next]];
  }));
  return {
    career: careerProgress(player), dealStyles: player.dealStyles || {}, appearance: profileAppearance(player, levelForXp(player.xp)),
    id: player.id, name: player.name, avatar: player.avatar || "", cash: player.cash, profit: player.profit, deals: player.deals, isAdmin: isAdmin(player), profileBadge: player.profileBadge || (isAdmin(player) ? "Администратор" : ""), purchasedCash: player.purchasedCash, supporterTier: player.supporterTier, supporterBenefits: supporterTierBenefits[player.supporterTier] || [], training: player.training,
    availableCash: player.cash - reserved, reservedCash: reserved,
    xp: player.xp, level: levelForXp(player.xp), levelStartXp: xpForLevel(levelForXp(player.xp)), nextLevelXp: levelForXp(player.xp) >= 30 ? player.xp : xpForLevel(levelForXp(player.xp) + 1),
    marketMaxPrice: maxVehiclePriceForLevel(levelForXp(player.xp)), auctionUnlockLevel: AUCTION_UNLOCK_LEVEL, auctionUnlocked: levelForXp(player.xp) >= AUCTION_UNLOCK_LEVEL,
    fees: { plateIssue: balance.fee(12000, playerLevel), registration: balance.fee(8500, playerLevel), deregistration: balance.fee(2500, playerLevel, 50), training: TRAINING_REWARD_CASH, legalCheckShare: Math.round(fraud.legalCheckChance({ level: playerLevel, appraisal: player.skills?.appraisal || 0, historyTerminal: player.equipment?.historyTerminal || 0, reputation: player.reputation?.score || 50 }) * 100) },
    referral: { code: player.referralCode, invited: player.referralCount || 0, earned: player.referralCash || 0, bonus: REFERRAL_BONUS_CASH, invitedBy: player.referredBy ? players.get(player.referredBy)?.name || null : null },
    skillPoints: player.skillPoints, skills: player.skills, skillPaths, equipment: player.equipment, equipmentPrices, garageExpandCost: balance.garageExpandPrice(player.garageCapacity, playerLevel), starterMode: playerLevel < 3, stats: player.stats,
    reputation: player.reputation, contracts: player.contracts, garageCapacity: player.garageCapacity, parts: player.parts,
    group: player.groupId && groups.get(player.groupId) ? publicGroupView(groups.get(player.groupId), player) : null, groupRole: player.groupRole,
    garage: player.garage.map((car) => publicCar(car, true, player)), partInventory: player.partInventory, plateInventory: player.plateInventory,
    ownedAssets: player.ownedAssets.map((asset) => ({ ...asset, resaleValue: assetResaleValue(asset, player), incomeState: propertyIncomeState(asset, player), propertyHistory: asset.type === "property" ? propertyHistory(asset) : undefined })),
    businesses: player.businesses.map((business) => ({ ...business, state: businessState(business) })),
    clothingCraft: clothingCrafts.get(player.id) || null,
    assetIncomeAvailable: assetIncomeAvailable(player), businessCatalog, clothingCatalog: clothingCatalog.filter((_, index) => index < 200).map((item) => ({ ...item, rarityName: clothingRarityNames[item.rarity] })),
    incomingOffers: [...offers.values()].filter((offer) => offer.sellerId === player.id && ["active", "counter"].includes(offer.status)).map((offer) => offerView(offer, player)),
    outgoingOffers: [...offers.values()].filter((offer) => offer.buyerId === player.id && ["active", "counter"].includes(offer.status)).map((offer) => offerView(offer, player)),
    containerRewards: player.containerRewards.filter((reward) => !reward.acknowledged).slice(-3),
    notifications: player.notifications.slice(-20).reverse(), unreadNotifications: player.notifications.filter((item) => !item.read).length,
    achievements: { unlocked: player.achievements.unlocked, catalog: achievementCatalog.map(({ test, ...item }) => ({ ...item, unlocked: player.achievements.unlocked.includes(item.key) })) },
    ledger: player.ledger.slice(-100).reverse(),
    bank: bankView(player),
    fraud: {
      ...ensurePlayerFraud(player),
      // pushFraudHistory кладёт свежие события в начало — значит клиенту нужны первые, а не последние.
      history: player.fraud.history.slice(0, 12),
      blocked: Math.max(0, (player.fraud.blockedUntil || 0) - Date.now()),
      schemeCooldown: Math.max(0, (player.fraud.lastSchemeAt || 0) + FRAUD_SCHEME_COOLDOWN_MS - Date.now()),
      stage: fraudStageLabel(player.fraud.notoriety),
      // `schemes` — счётчик прокатанных схем (его показывает статистика), а список-каталог живёт в schemeOptions.
      schemeOptions: fraud.schemeCatalog.map((item) => ({
        key: item.key, name: item.name, description: item.description, exposure: item.exposure,
        priceBonus: Math.round(item.priceBonus * 100), risk: Math.round(item.risk * 100), suspicion: item.suspicion,
        unlocked: levelForXp(player.xp) >= item.requires.level && player.fraud.notoriety >= item.requires.notoriety,
        requires: item.requires, costShare: item.costShare, minCost: item.minCost
      })),
      lawyerCost: fraud.lawyerCost(playerNetWorth(player)),
      stageNote: player.fraud.suspicion >= 70 ? "Рынок смотрит слишком внимательно: снизьте подозрение через адвоката, прежде чем рисковать снова." : player.fraud.notoriety > 0 ? "Авторитет открывает серые схемы, но каждое расторжение сделки бьёт по репутации." : "Чистая репутация даёт скидки у банка и больше доверия покупателей."
    }
  };
}

function fraudStageLabel(notoriety) {
  const value = Number(notoriety) || 0;
  if (value <= 0) return "Чистый игрок";
  if (value < 20) return "Мелкий шулер";
  if (value < 60) return "Тёмный перекуп";
  if (value < 140) return "Авторитет рынка";
  return "Легенда серого рынка";
}

function leaderboardView(viewer) {
  const isActive = (candidate) => candidate.deals > 0 || candidate.profit !== 0 || candidate.xp > 0
    || candidate.stats?.purchases > 0 || candidate.stats?.bids > 0 || candidate.stats?.inspections > 0
    || candidate.stats?.assetsBought > 0 || candidate.training?.completed > 0;
  // Доска почёта — только для тех, кто уже сыграл хотя бы одну сделку; сам игрок виден всегда,
  // иначе новичок не видит собственную позицию и «пустышки» засоряют рейтинг.
  const participants = [...players.values()].filter((candidate) => !banMessage(candidate) && (isActive(candidate) || candidate.id === viewer?.id))
    .sort((a, b) => b.profit - a.profit || b.deals - a.deals || b.xp - a.xp || a.name.localeCompare(b.name, "ru"));
  const rows = participants.map((candidate, index) => ({
    id: candidate.id, name: candidate.name, profit: candidate.profit, deals: candidate.deals,
    level: levelForXp(candidate.xp), rank: index + 1, isCurrent: candidate.id === viewer?.id
  }));
  return { rows: rows.slice(0, 20), current: rows.find((row) => row.isCurrent) || null, total: rows.length };
}

function publicPlayerProfile(candidate, viewer) {
  const activeListings = market
    .filter((car) => car.sellerId === candidate.id)
    .map((car) => publicCar(car, false, viewer));
  const group = candidate.groupId && groups.get(candidate.groupId);
  return {
    id: candidate.id,
    name: candidate.name,
    avatar: candidate.avatar || "",
    level: levelForXp(candidate.xp),
    reputation: candidate.reputation?.score || 50,
    completedDeals: candidate.reputation?.completed || candidate.deals || 0,
    deals: candidate.deals || 0,
    profileBadge: candidate.profileBadge || (isAdmin(candidate) ? "Администратор" : ""),
    supporterTier: candidate.supporterTier || "none",
    appearance: profileAppearance(candidate, levelForXp(candidate.xp)).selected,
    groupName: group?.name || null,
    groupRole: candidate.groupRole || null,
    listings: activeListings,
    listingsCount: activeListings.length
  };
}

function snapshot(player) {
  const leaderboard = leaderboardView(player);
  const playerDirectMessages = player ? directMessages.filter((message) => message.senderId === player.id || message.recipientId === player.id).slice(-300) : [];
  const directContactIds = new Set(playerDirectMessages.flatMap((message) => [message.senderId, message.recipientId]).filter((playerId) => playerId !== player?.id));
  return {
    revision,
    player: player ? playerView(player) : null,
    market: market.filter((car) => canAccessCar(player, car) && (car.saleType !== "auction" || levelForXp(player.xp) >= AUCTION_UNLOCK_LEVEL || car.sellerId === player.id || car.participantIds?.includes(player.id))).map((car) => publicCar(car, car.sellerId === player?.id, player)),
    skillInfo,
    skillPaths, skillPrerequisites: prerequisites,
    equipmentInfo,
    inspectionCategories: inspectionCategories(),
    inspectionRequirements,
    inspectionMethods,
    marketStats: marketStatistics(),
    partsMarketStats: partsMarketStatistics(),
    chatMessages: chatMessages.slice(-100).map((message) => ({ ...message, playerName: players.get(message.playerId)?.name || message.playerName, supporterTier: players.get(message.playerId)?.supporterTier || "none", profileBadge: players.get(message.playerId)?.profileBadge || (isAdmin(players.get(message.playerId)) ? "Администратор" : "") })),
    directMessages: playerDirectMessages.map((message) => ({ ...message, senderName: players.get(message.senderId)?.name || message.senderName, recipientName: players.get(message.recipientId)?.name || message.recipientName })),
    directUnread: playerDirectMessages.filter((message) => message.recipientId === player?.id && !message.readAt).length,
    playerDirectory: player ? [...directContactIds].map((playerId) => players.get(playerId)).filter((candidate) => candidate && !banMessage(candidate)).map((candidate) => ({ id: candidate.id, name: candidate.name, level: levelForXp(candidate.xp), reputation: candidate.reputation?.score || 50 })) : [],
    partsMarket: partsMarket.slice(-100),
    plateMarket: plateMarket.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
    partNeeds: player ? playerPartNeeds(player) : [],
    partQualities: partQualityCatalog,
    partComponents,
    marketRotation: { nextAt: marketRotationNextAt, intervalSeconds: Math.round(NPC_ROTATION_MS / 1000), replaceCount: NPC_ROTATION_COUNT },
    groups: [...groups.values()].map((group) => ({ id: group.id, name: group.name, rating: group.rating, members: group.members.length })),
    fraudInfo: {
      startingCash: STARTING_CASH,
      starterBand: balance.starterPriceBand(),
      starterLots: balance.STARTER.lots,
      schemes: fraud.schemeCatalog.map((item) => ({ key: item.key, name: item.name, description: item.description, exposure: item.exposure, risk: Math.round(item.risk * 100), priceBonus: Math.round(item.priceBonus * 100), requires: item.requires })),
      threats: fraud.fraudCatalog.map((item) => ({ key: item.key, name: item.name, hint: item.hint, category: item.category, depth: item.depth, consequence: item.unregistrable ? "Регистрация невозможна" : item.blocksRegistration ? "Сделка и учёт под вопросом" : "Реальное состояние хуже заявленного" })),
      rules: {
        check: "Юридическая проверка перед покупкой стоит ~1,4% цены, но шанс увидеть обман зависит от навыка «Оценщик» и «Терминала истории».",
        expose: "Раскрытый обман можно сдать рынку: лот снимается, вы получаете премию, репутацию и опыт.",
        suspicion: "Каждая серая схема добавляет подозрение. На 100 приходит «обыск»: штраф, изъятие машины и пауза на сделках.",
        decay: "Подозрение остывает само, а адвокат срезает его сразу за процент от капитала."
      }
    },
    npcProfiles: bots.map((bot) => ({ id: bot.id, name: bot.name, type: bot.type, rating: Math.round((bot.risk * 80 + bot.skill * 4) * 10) / 10, budget: bot.budget })),
    employeeCandidates, groupJobCatalog: Object.values(groupJobCatalog),
    store: { enabled: Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY), provider: "YooKassa", packages: stylePackages.map(pack => ({ ...pack, owned: pack.cosmetics.every(id => ownsCosmetic(player, cosmetics.find(item => item.id === id), levelForXp(player.xp))) })) },
    catalogCount: catalog.length,
    containerAuctions: levelForXp(player.xp) >= AUCTION_UNLOCK_LEVEL ? containerAuctions.map((container) => publicContainer(container, player)) : [],
    assetMarket: assetMarket.filter((listing) => listing.stock > 0).map((listing) => publicAssetListing(listing, player)), cryptoQuotes: cryptoQuotes(), clothingMarket: clothingMarket.map((lot) => ({ ...lot, viewerOwned: lot.sellerId === player.id })), itemContainerAuctions: itemContainerAuctions.map((box) => ({ ...box, viewerLeading: box.highestBidderId === player.id, viewerParticipated: box.participantIds.includes(player.id) })),
    assetCategories: { electronics: "Техника", collectibles: "Коллекции", business: "Оборудование", clothing: "Одежда", residential: "Жилая недвижимость", commercial: "Коммерческая недвижимость", crypto: "Криптовалюта" },
    leaderboard: leaderboard.rows,
    leaderboardCurrent: leaderboard.current,
    leaderboardTotal: leaderboard.total
  };
}

function broadcast() {
  for (const player of players.values()) syncAchievements(player);
  revision += 1;
  schedulePersist();
  for (const client of clients) client.res.write(`event: update\ndata: ${JSON.stringify(snapshot(client.player))}\n\n`);
}

function finalizeGroupJobs() {
  const now = Date.now();
  let changed = false;
  for (const group of groups.values()) {
    ensureGroupDefaults(group);
    const completed = group.activeJobs.filter((job) => job.finishAt <= now);
    for (const job of completed) {
      const employee = group.employees.find((item) => item.id === job.employeeId);
      const template = groupJobCatalog[job.jobKey];
      if (!employee || !template) continue;
      const quality = clamp(0.82 + employee.rating / 500 + group.rating / 1000 + Math.random() * 0.08, 0.86, 1.12);
      const baseReward = randomInt(template.rewardLow, template.rewardHigh);
      const reward = Math.max(job.operatingCost + 1000, Math.round(baseReward * quality / 1000) * 1000);
      group.treasury += reward;
      group.businessXp += template.xp;
      group.completedJobs += 1;
      group.totalRevenue += reward;
      group.totalBusinessProfit += reward - job.operatingCost;
      group.rating = clamp(group.rating + quality * 0.35, 0, 100);
      employee.experience += template.xp;
      employee.jobsCompleted += 1;
      employee.busyJobId = null;
      if (employee.jobsCompleted % 3 === 0) employee.rating = Math.min(99, employee.rating + 1);
      while (group.businessXp >= group.businessLevel * 200) {
        group.businessXp -= group.businessLevel * 200;
        group.businessLevel += 1;
        group.rating = clamp(group.rating + 2, 0, 100);
        group.log.push({ at: now, text: `Бизнес достиг ${group.businessLevel} уровня` });
      }
      group.log.push({ at: now, text: `${employee.name} завершил «${template.name}»: выручка ${reward.toLocaleString("ru-RU")} ₽` });
      changed = true;
    }
    if (completed.length) group.activeJobs = group.activeJobs.filter((job) => job.finishAt > now);
  }
  if (changed) broadcast();
}

setInterval(finalizeGroupJobs, 1000).unref();

function seedMarket() {
  for (const itemIndex of balancedNpcCatalogIndices(100)) market.push(makeCar(itemIndex));
  ensureStarterSegment();
  // Торги должны быть на рынке с первой секунды: иначе вкладка «Торги» у новичка пустая,
  // пока не дойдёт первый ротационный тик NPC.
  ensureNpcAuctions();
  for (const item of catalog) {
    const comparable = market.find((car) => car.model === item.model);
    const anchor = comparable ? currentValue(comparable) : Math.round(item.base * 0.78 / 1000) * 1000;
    for (let i = 0; i < 7; i += 1) {
      salesHistory.push({ model: item.model, price: Math.max(1, Math.round(anchor * (0.9 + Math.random() * 0.2) / 1000) * 1000), at: Date.now() - randomInt(1, 30) * 86400000 });
    }
  }
}

function cryptoQuotes() {
  return Object.values(Object.fromEntries(assetMarket.filter((item) => item.type === "crypto" && item.stock > 0).map((item) => [item.key, item]))).map((item) => ({ key: item.key, name: item.name, symbol: item.symbol, unitPrice: item.unitPrice, changePct: item.changePct, history: cryptoHistory[item.key] || [] }));
}

function createItemContainerAuction() {
  const rarity = Math.random() < .55 ? "common" : Math.random() < .78 ? "uncommon" : Math.random() < .94 ? "rare" : Math.random() < .99 ? "epic" : "legendary";
  const labels = { common: "Повседневный бокс", uncommon: "Streetwear-бокс", rare: "Редкий дроп", epic: "Архивный контейнер", legendary: "Коллекционный сейф" };
  const starts = { common: 1000, uncommon: 3500, rare: 12000, epic: 40000, legendary: 120000 };
  return { id: id("item_box_"), rarity, name: labels[rarity], startingPrice: starts[rarity], highestBid: 0, highestBidderId: null, highestBidderName: null, participantIds: [], bidCount: 0, endAt: Date.now() + randomInt(180, 420) * 1000 };
}

function restockItemContainers() { while (itemContainerAuctions.length < 8) itemContainerAuctions.push(createItemContainerAuction()); }

function finalizeItemContainers() {
  let changed = false;
  for (const auction of itemContainerAuctions.filter((item) => item.endAt <= Date.now())) {
    const winner = auction.highestBidderId && players.get(auction.highestBidderId);
    if (winner && winner.cash >= auction.highestBid) {
      const pool = clothingCatalog.filter((item) => item.rarity === auction.rarity); const template = pool[randomInt(0, Math.max(0, pool.length - 1))] || clothingCatalog[0];
      winner.cash -= auction.highestBid; winner.ownedAssets.push({ ...template, id: id("owned_asset_"), purchasePrice: auction.highestBid, acquiredAt: Date.now(), condition: 100, fairValue: template.value, basePrice: template.value, stock: 1, seller: "Контейнер вещей" });
      addLedger(winner, "item-container", `Выигран контейнер: ${auction.name}`, -auction.highestBid, { category: "Одежда" });
    }
    itemContainerAuctions.splice(itemContainerAuctions.indexOf(auction), 1); changed = true;
  }
  if (changed) { restockItemContainers(); broadcast(); }
}

function balancedNpcCatalogIndices(target = 100) {
  const bands = [
    { count: 25, items: catalog.map((item, index) => ({ item, index })).filter(({ item }) => !item.collectible && item.preferredTier !== "premium" && item.base <= 1200000) },
    { count: 45, items: catalog.map((item, index) => ({ item, index })).filter(({ item }) => !item.collectible && !["performance", "premium"].includes(item.preferredTier) && item.base > 1200000 && item.base < 10000000) },
    { count: 15, items: catalog.map((item, index) => ({ item, index })).filter(({ item }) => !item.collectible && item.preferredTier !== "premium" && (item.preferredTier === "performance" || (item.base >= 10000000 && item.base < 50000000))) },
    { count: 7, ordered: true, items: catalog.map((item, index) => ({ item, index })).filter(({ item }) => !item.collectible && (item.preferredTier === "premium" || item.base >= 50000000)).sort((a, b) => b.item.base - a.item.base) },
    { count: 8, ordered: true, items: catalog.map((item, index) => ({ item, index })).filter(({ item }) => item.collectible).sort((a, b) => b.item.base - a.item.base) }
  ];
  const selected = [];
  const models = new Set();
  const featuredMakes = ["Rolls-Royce", "Bentley", "Maybach", "Ferrari", "Lamborghini", "Porsche", "Aston Martin"];
  for (const make of featuredMakes) {
    const candidates = catalog.map((item, index) => ({ item, index })).filter(({ item }) => item.make === make).sort((a, b) => b.item.base - a.item.base);
    const candidate = candidates[0];
    if (!candidate || models.has(candidate.item.model)) continue;
    models.add(candidate.item.model); selected.push(candidate.index);
  }
  for (const band of bands) {
    const step = 137;
    let bandSelected = 0;
    for (let cursor = 0; cursor < band.items.length * 2 && selected.length < target && bandSelected < band.count; cursor += 1) {
      const candidate = band.items[band.ordered ? cursor % Math.max(1, band.items.length) : (cursor * step) % Math.max(1, band.items.length)];
      if (!candidate || models.has(candidate.item.model)) continue;
      models.add(candidate.item.model); selected.push(candidate.index); bandSelected += 1;
    }
  }
  for (let cursor = 0; selected.length < target && cursor < catalog.length; cursor += 1) {
    const index = (cursor * 137) % catalog.length; const item = catalog[index];
    if (models.has(item.model)) continue;
    models.add(item.model); selected.push(index);
  }
  return selected;
}

function refreshLegacyNpcCatalog() {
  const npcCars = market.filter((car) => !car.sellerId);
  const hasLegacyModels = npcCars.some((car) => !catalogByModel.has(car.model));
  const uniqueModels = new Set(npcCars.map((car) => car.model)).size;
  if (loadedVehiclePricingVersion >= VEHICLE_PRICING_VERSION && !hasLegacyModels && uniqueModels >= Math.min(85, npcCars.length)) return;

  // Keep lots with real player participation; only replace free NPC inventory.
  for (let index = market.length - 1; index >= 0; index -= 1) {
    const car = market[index];
    const protectedAuction = car.saleType === "auction" && ((car.participantIds || []).length || car.highestBidderType === "player");
    if (!car.sellerId && !protectedAuction) market.splice(index, 1);
  }
  const occupiedModels = new Set(market.filter((car) => !car.sellerId).map((car) => car.model));
  for (const itemIndex of balancedNpcCatalogIndices(100)) {
    if (market.filter((car) => !car.sellerId).length >= 100) break;
    const item = catalog[itemIndex];
    if (occupiedModels.has(item.model)) continue;
    market.push(makeCar(itemIndex));
    occupiedModels.add(item.model);
  }
  ensureStarterSegment();
  ensureNpcAuctions();
  marketStatsCache = null;
  loadedVehiclePricingVersion = VEHICLE_PRICING_VERSION;
  persistState();
}
function resetAccountsOnStartup() {
  if (process.env.PEREKUP_RESET_ALL !== "1") return;
  const marker = path.join(DATA_DIR, ".full-reset-admin-v1");
  if (fs.existsSync(marker)) return;
  if (hasSavedRow(DB_PATH)) { console.log("FULL_RESET_SKIP: база уже содержит сохранение (сброс выполнен ранее или восстановлен из хранилища)"); return; }
  const password = String(process.env.PEREKUP_RESET_ADMIN_PASSWORD || "");
  if (!validPassword(password)) throw new Error("PEREKUP_RESET_ADMIN_PASSWORD не задан или некорректен");
  const credentials = hashPassword(password);
  const admin = { id: id("player_admin_"), name: "federuk", normalizedName: "federuk", email: "fedukinegor@gmail.com", passwordSalt: credentials.salt, passwordHash: credentials.hash, emailVerified: true, pinSalt: null, pinHash: null, cash: STARTING_CASH, profit: 0, deals: 0, garage: [], xp: 0, skillPoints: 1, skills: {}, equipment: {}, garageCapacity: MAX_GARAGE, parts: { common: 0, premium: 0 }, groupId: null, groupRole: null, stats: {}, ownedAssets: [], businesses: [], plateInventory: [], notifications: [], reputation: { score: 50, completed: 0, failed: 0 } };
  const state = { players: [[admin.id, admin]], sessions: [], emailVerifications: [], passwordResets: [], market: [], offers: [], salesHistory: [], marketIndices: {}, chatMessages: [], directMessages: [], moderationReports: [], assetMarket: [], groups: [], partsMarket: [], partsSalesHistory: [], plateMarket: [], partIndices: {}, paymentOrders: [], containerAuctions: [], clothingCrafts: [], clothingMarket: [], itemContainerAuctions: [], cryptoHistory: [], vehiclePricingVersion: 0 };
  db.prepare("INSERT INTO game_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at").run(JSON.stringify(state), Date.now());
  fs.writeFileSync(marker, new Date().toISOString(), "utf8");
  console.log("FULL_RESET_OK: created federuk");
}
resetAccountsOnStartup();
if (!loadState()) {
  seedMarket();
  persistState();
}
if (s3Sync.configured()) {
  const s3Config = s3Sync.readConfig();
  if (!/[:.]/.test(s3Config.accessKeyId)) console.warn("S3_KEY_FORMAT_WARNING: PEREKUP_S3_ACCESS_KEY_ID без префикса тенанта — для Cloud.ru ожидается формат <идентификатор-тенанта>:<Key ID> (тенант: Object Storage → Параметры работы с API)");
  console.log(`S3_SYNC_ENABLED: снимок базы ${s3Sync.describeTarget()} каждые ${Math.round(s3Config.intervalMs / 1000)} с`);
  let s3PushInFlight = false;
  const s3Timer = setInterval(() => {
    if (!s3SyncDirty || s3PushInFlight) return;
    s3PushInFlight = true;
    let snapshotPath = null;
    try {
      snapshotPath = path.join(DATA_DIR, `game-snapshot-${Date.now()}.db`);
      db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const buffer = fs.readFileSync(snapshotPath);
      fs.rmSync(snapshotPath, { force: true });
      snapshotPath = null;
      s3Sync.pushSnapshot(buffer)
        .then(() => { s3SyncDirty = false; console.log(`S3_SYNC_PUSHED: снимок ${buffer.length} байт сохранён в хранилище`); })
        .catch((error) => console.warn(`S3_SYNC_PUSH_FAILED: ${error.message}`))
        .finally(() => { s3PushInFlight = false; });
    } catch (error) {
      if (snapshotPath) { try { fs.rmSync(snapshotPath, { force: true }); } catch {} }
      console.warn(`S3_SYNC_SNAPSHOT_FAILED: ${error.message}`);
      s3PushInFlight = false;
    }
  }, s3Config.intervalMs);
  s3Timer.unref?.();
}

const AUCTION_UNLOCK_LEVEL = Math.max(1, Number(process.env.PEREKUP_AUCTION_UNLOCK_LEVEL ?? 3));
const MARKET_LEVEL_CAPS = [1000000, 2500000, 5000000, 10000000, 25000000, 50000000, 100000000, MAX_VEHICLE_VALUE];
function maxVehiclePriceForLevel(level) {
  return MARKET_LEVEL_CAPS[Math.min(MARKET_LEVEL_CAPS.length - 1, Math.max(0, Number(level || 1) - 1))];
}
function carAccessPrice(car) { return Math.max(0, Number(car?.price || car?.cleanValue || 0)); }
function canAccessCar(player, car) {
  return Boolean(player && car && (car.sellerId === player.id || carAccessPrice(car) <= maxVehiclePriceForLevel(levelForXp(player.xp))));
}
function carUnlockMessage(player, car) {
  const required = Math.max(1, MARKET_LEVEL_CAPS.findIndex((cap) => cap >= carAccessPrice(car)) + 1);
  return `Эта машина откроется с ${required} уровня. Текущий лимит: ${maxVehiclePriceForLevel(levelForXp(player.xp)).toLocaleString("ru-RU")} ₽.`;
}
function ensureConfiguredAdmin() {
  const password = String(process.env.PEREKUP_ADMIN_PASSWORD || process.env.PEREKUP_RESET_ADMIN_PASSWORD || "");
  if (!validPassword(password)) return;
  let admin = [...players.values()].find((player) => (player.normalizedName || player.name || "").toLocaleLowerCase("ru-RU") === CONFIGURED_ADMIN_LOGIN);
  if (!admin) admin = createPlayer(CONFIGURED_ADMIN_LOGIN, null, { email: CONFIGURED_ADMIN_EMAIL, password, emailVerified: true });
  const credentials = hashPassword(password);
  admin.email = CONFIGURED_ADMIN_EMAIL;
  admin.emailVerified = true;
  admin.passwordSalt = credentials.salt;
  admin.passwordHash = credentials.hash;
  admin.adminGranted = true;
  players.set(admin.id, admin);
  persistState();
  console.log("ADMIN_READY: configured federuk");
}
ensureConfiguredAdmin();
restockAssetMarket();
restockItemContainers();
initializeMarketIndices();
refreshLegacyNpcCatalog();
restock();
rebalanceNpcMarket();
restockPlateMarket();
function publishPartLot(itemOrType, condition = "new", price = null, seller = "Магазин", sellerId = null) {
  const legacyType = typeof itemOrType === "string" ? itemOrType : null;
  const item = legacyType
    ? makePart(["engine", "chassis", "body", "electrics", "tires"][randomInt(0, 4)], legacyType === "premium" ? "original" : condition === "used" ? "restored" : "analog", condition === "used" ? randomInt(48, 82) : 100, null, catalog[randomInt(0, catalog.length - 1)].model)
    : itemOrType;
  const lot = { id: id("part_"), item, type: item.quality === "original" ? "premium" : "common", condition: item.conditionPct < 100 ? "used" : "new", price: price || item.estimatedValue, seller, sellerId, createdAt: Date.now() };
  partsMarket.push(lot);
  return lot;
}
if (!partsMarket.length) {
  for (let i = 0; i < 30; i += 1) publishPartLot(i % 4 === 0 ? "premium" : "common", i % 2 ? "new" : "used");
}
persistState();

function runNpcPartBuyers() {
  let changed = false;
  for (const lot of partsMarket.slice()) {
    if (Math.random() > 0.22) continue;
    const item = ensurePartLot(lot).item;
    const candidates = bots.filter((bot) => bot.budget >= lot.price && lot.price <= item.estimatedValue * (0.9 + bot.risk * 0.2));
    const buyer = candidates.sort(() => Math.random() - 0.5)[0];
    if (!buyer) continue;
    const seller = lot.sellerId && players.get(lot.sellerId);
    if (seller) seller.cash += Math.round(lot.price * 0.95);
    partsSalesHistory.push({ component: item.component, model: item.compatibleModel, price: lot.price, buyer: buyer.name, at: Date.now() });
    partsMarket.splice(partsMarket.indexOf(lot), 1);
    changed = true;
  }
  while (partsMarket.length < 30) publishPartLot(Math.random() < 0.22 ? "premium" : "common", Math.random() < 0.5 ? "used" : "new");
  if (changed) broadcast();
}
setInterval(runNpcPartBuyers, 12000).unref();

function reservedCash(player) {
  const carsReserved = market.filter((car) => car.saleType === "auction" && car.highestBidderId === player.id && car.auctionEnd > Date.now()).reduce((sum, car) => sum + car.highestBid, 0);
  const containersReserved = containerAuctions.filter((item) => item.highestBidderId === player.id && item.endAt > Date.now()).reduce((sum, item) => sum + item.highestBid, 0);
  const itemContainersReserved = itemContainerAuctions.filter((item) => item.highestBidderId === player.id && item.endAt > Date.now()).reduce((sum, item) => sum + item.highestBid, 0);
  return carsReserved + containersReserved + itemContainersReserved;
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

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}
function validPassword(password) { return /^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]{8,72}$/.test(password); }

function verifyPassword(password, player) {
  if (!player.passwordSalt || !player.passwordHash) return false;
  const candidate = Buffer.from(hashPassword(password, player.passwordSalt).hash, "hex");
  const expected = Buffer.from(player.passwordHash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function sendVerificationEmail(email, name, token) {
  if (!RESEND_API_KEY) throw new Error("Почта пока не настроена: администратору нужно добавить RESEND_API_KEY в настройках Container App");
  const link = `${PUBLIC_URL}/verify-email.html?token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: AUTH_FROM_EMAIL, to: [email], subject: "Подтвердите почту в игре «Рынок»", html: `<p>Здравствуйте, ${String(name).replace(/[<>]/g, "")}</p><p>Нажмите кнопку, чтобы подтвердить адрес электронной почты:</p><p><a href="${link}">Подтвердить почту</a></p><p>Ссылка действует 24 часа.</p>` }) });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Почтовый ключ Resend недействителен: проверьте RESEND_API_KEY в настройках Container App" : "Письмо не отправлено: проверьте подтверждённый адрес AUTH_FROM_EMAIL в настройках Container App");
}

async function sendPasswordResetEmail(email, name, token) {
  if (!RESEND_API_KEY) throw new Error("Восстановление почты временно недоступно");
  const link = `${PUBLIC_URL}/reset-password.html?token=${encodeURIComponent(token)}`;
  const safeName = String(name).replace(/[<>]/g, "");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: AUTH_FROM_EMAIL, to: [email], subject: "Восстановление доступа к игре «Рынок»", html: `<p>Здравствуйте, ${safeName}</p><p>Ваш логин: <strong>${safeName}</strong></p><p><a href="${link}">Установить новый пароль</a></p><p>Ссылка действует 1 час. Если вы не запрашивали восстановление, просто проигнорируйте письмо.</p>` }) });
  if (!response.ok) throw new Error("Не удалось отправить письмо восстановления");
}

function createPlayer(name, pin = null, account = {}) {
  const credentials = pin ? hashPin(pin) : {};
  const password = account.password ? hashPassword(account.password) : {};
  const player = {
    id: id("player_"), name, normalizedName: name.toLocaleLowerCase("ru-RU"),
    pinSalt: credentials.salt || null, pinHash: credentials.hash || null,
    email: account.email || null, passwordSalt: password.salt || null, passwordHash: password.hash || null, emailVerified: account.emailVerified ?? !account.email,
    cash: STARTING_CASH, profit: 0, deals: 0, garage: [], xp: 0, skillPoints: 1,
    skills: {}, equipment: {}, garageCapacity: MAX_GARAGE, parts: { common: 0, premium: 0 }, groupId: null, groupRole: null,
    stats: { purchases: 0, inspections: 0, serviceDiagnostics: 0, selfRepairs: 0, assistedRepairs: 0, workshopRepairs: 0, auctionsWon: 0, bids: 0 }
  };
  ensurePlayerDefaults(player);
  return player;
}

function generateReferralCode() {
  const taken = new Set([...players.values()].map((candidate) => String(candidate.referralCode || "").toUpperCase()).filter(Boolean));
  for (let attempt = 0; attempt < 16; attempt += 1) {
    let code = "";
    for (let index = 0; index < 7; index += 1) code += REFERRAL_CODE_ALPHABET[crypto.randomInt(0, REFERRAL_CODE_ALPHABET.length)];
    if (!taken.has(code)) return code;
  }
  return `P${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

// Применяет промокод к только что созданному аккаунту: бонус обоим, счётчики и уведомления пригласившему.
function applyReferralPromo(rawCode, newPlayer) {
  const code = String(rawCode || "").trim().toUpperCase().slice(0, 16);
  if (!code) return { applied: false };
  const referrer = [...players.values()].find((candidate) => String(candidate.referralCode || "").toUpperCase() === code);
  if (!referrer || referrer.id === newPlayer.id || banMessage(referrer)) return { applied: false, invalid: true };
  newPlayer.referredBy = referrer.id;
  newPlayer.referralAppliedAt = Date.now();
  if (REFERRAL_BONUS_CASH > 0) {
    newPlayer.cash += REFERRAL_BONUS_CASH;
    referrer.cash += REFERRAL_BONUS_CASH;
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    referrer.referralCash = (referrer.referralCash || 0) + REFERRAL_BONUS_CASH;
    newPlayer.notifications.push({ id: id("notification_"), type: "referral", title: "Промокод применён", text: `Вы пришли по промокоду игрока ${referrer.name} — бонус ${REFERRAL_BONUS_CASH.toLocaleString("ru-RU")} ₽ уже на счёте`, createdAt: Date.now(), read: false });
    referrer.notifications.push({ id: id("notification_"), type: "referral", title: "Приглашён новый игрок", text: `${newPlayer.name} создал аккаунт по вашему промокоду — бонус ${REFERRAL_BONUS_CASH.toLocaleString("ru-RU")} ₽`, createdAt: Date.now(), read: false });
  }
  return { applied: true, referrerName: referrer.name };
}

function restock() {
  const npcCount = market.filter((car) => !car.sellerId).length;
  for (let i = npcCount; i < 100; i += 1) market.push(makeCar(randomInt(0, catalog.length - 1)));
  ensureStarterSegment();
  ensureNpcAuctions();
}

// Стартовый сегмент: всегда держим на рынке несколько лотов по карману игроку с 50 000 ₽.
// Без них «подъём с нуля» превращается в ожидание: первые машины просто недоступны по деньгам.
function ensureStarterSegment() {
  const band = balance.starterPriceBand();
  const indices = starterCatalogIndices();
  let starters = market.filter((car) => !car.sellerId && car.starter && car.saleType !== "auction");
  // Дешёвые лоты не должны «застревать» дороже стартового кармана.
  for (const car of starters) {
    if (car.price > band.max) {
      car.price = band.max;
      car.purchasePrice = band.max;
      car.invested = band.max;
    }
  }
  let guard = 0;
  while (starters.length < balance.STARTER.lots && guard < 40) {
    guard += 1;
    const index = indices[(market.length + guard) % Math.max(1, indices.length)];
    const car = makeCar(index, "Авторынок", { starter: true });
    if (!car) break;
    if (car.price > band.max) { car.price = band.max; car.purchasePrice = band.max; car.invested = band.max; }
    if (car.price < band.min) { car.price = band.min; car.purchasePrice = band.min; car.invested = band.min; }
    market.push(car);
    starters = market.filter((item) => !item.sellerId && item.starter && item.saleType !== "auction");
  }
}

function configureNpcAuction(car) {
  // Public auctions disclose every defect, so NPC sellers prepare these lots first.
  for (const defect of car.defects) {
    if (defect.repaired) continue;
    defect.repaired = true; defect.repairQuality = 'Стандартный ремонт'; defect.repairReliability = 88;
    car.repairs.push(defect.name);
    car.condition = Math.min(95, car.condition + defect.severity * 4);
  }
  const estimate = saleEstimate(car);
  const startFactor = 0.62 + Math.random() * 0.16;
  car.saleType = "auction";
  car.seller = ["Муниципальные торги", "Дилерский аукцион", "Страховой склад", "Лизинговый парк"][randomInt(0, 3)];
  car.startingPrice = Math.max(1000, Math.round(estimate.expectedNpcPrice * startFactor / 1000) * 1000);
  car.price = car.startingPrice;
  car.auctionEnd = Date.now() + randomInt(180, 420) * 1000;
  car.highestBid = 0; car.highestBidderId = null; car.highestBidderName = null; car.highestBidderType = null;
  car.bidCount = 0; car.participantIds = []; car.lastPlayerBidAt = null; car.lastNpcBidAt = null;
}

function ensureNpcAuctions() {
  const target = 14;
  const active = market.filter((car) => !car.sellerId && car.saleType === "auction" && car.auctionEnd > Date.now()).length;
  const missing = Math.max(0, target - active);
  if (!missing) return;
  const pool = market.filter((car) => !car.sellerId && car.saleType !== "auction");
  // Половину торгов отдаём дешёвому сегменту: иначе на «Торгах» новичок видит пустой список,
  // потому что лоты с молотка уходят за миллионы.
  const band = balance.starterPriceBand();
  const cheap = pool.filter((car) => car.starter || Number(car.price) <= band.max);
  const rest = pool.filter((car) => !cheap.includes(car));
  const shuffle = (list) => list.sort(() => Math.random() - 0.5);
  const chosen = [...shuffle(cheap).slice(0, Math.ceil(missing * 0.6)), ...shuffle(rest).slice(0, missing)].slice(0, missing);
  chosen.forEach(configureNpcAuction);
}

function createContainerAuction(tierKey) {
  const tier = containerTiers[tierKey];
  return { id: id("container_"), tier: tierKey, name: tier.name, color: tier.color, startingPrice: randomInt(tier.startMin, tier.startMax), highestBid: 0, highestBidderId: null, highestBidderName: null, highestBidderType: null, participantIds: [], bidCount: 0, endAt: Date.now() + randomInt(180, 420) * 1000, createdAt: Date.now() };
}

function restockContainers() {
  for (const tier of Object.keys(containerTiers)) while (containerAuctions.filter((item) => item.tier === tier).length < 3) containerAuctions.push(createContainerAuction(tier));
}

function containerRewardCar(tierKey, invested, winner = null) {
  const tier = containerTiers[tierKey];
  let pool = catalog.filter((item) => item.base >= tier.minValue && item.base <= tier.maxValue && (!item.preferredTier || item.preferredTier === tierKey));
  if (pool.length < 8) pool = catalog.filter((item) => item.base >= tier.minValue && item.base <= tier.maxValue);
  if (tierKey === "performance") pool = pool.filter((item) => ["coupe", "roadster", "premium"].includes(item.className));
  const recentModels = new Set((winner?.garage || []).filter((car) => car.history?.some((entry) => entry.type === "container")).slice(-5).map((car) => car.model));
  const models = [...new Set(pool.map((item) => item.model))];
  const availableModels = models.filter((model) => !recentModels.has(model));
  const selectedModels = availableModels.length ? availableModels : models;
  const selectedModel = selectedModels[randomInt(0, Math.max(0, selectedModels.length - 1))];
  const modelVariants = pool.filter((item) => item.model === selectedModel);
  const item = modelVariants[randomInt(0, Math.max(0, modelVariants.length - 1))] || pool[randomInt(0, Math.max(0, pool.length - 1))] || catalog[0];
  const car = makeCar(catalog.indexOf(item), "Контейнерный аукцион");
  if (tierKey === "salvage" && car.defects.length < 3) {
    const existing = new Set(car.defects.map((defect) => defect.code));
    car.defects.push(...defectCatalog.filter((defect) => !existing.has(defect.code)).sort(() => Math.random() - 0.5).slice(0, 3 - car.defects.length).map((defect) => ({ ...defect, repaired: false })));
    car.condition = Math.min(car.condition, 48);
  }
  car.price = invested; car.purchasePrice = invested; car.invested = invested; car.seller = "Контейнерный аукцион"; car.ownerId = null;
  car.history = [{ type: "container", text: `Получена из контейнера «${tier.name}» за ${invested.toLocaleString("ru-RU")} ₽`, at: Date.now() }];
  return car;
}

function publicContainer(container, viewer = null) {
  const tier = containerTiers[container.tier];
  container.participantIds ||= [];
  const { participantIds, ...safeContainer } = container;
  return { ...safeContainer, label: tier.label, description: tier.description, minValue: tier.minValue, maxValue: tier.maxValue, viewerLeading: Boolean(viewer && container.highestBidderType === "player" && container.highestBidderId === viewer.id), viewerParticipated: Boolean(viewer && participantIds.includes(viewer.id)) };
}

function minimumContainerBid(auction) {
  if (!auction.highestBid) return Math.ceil(auction.startingPrice / 1000) * 1000;
  const rawMinimum = auction.highestBid + Math.max(1000, Math.ceil(auction.highestBid * 0.02));
  return Math.ceil(rawMinimum / 1000) * 1000;
}

function extendClosingAuction(item, endField) {
  const now = Date.now();
  if (item[endField] - now < AUCTION_EXTENSION_MS) item[endField] = now + AUCTION_EXTENSION_MS;
}

function finalizeContainers() {
  let changed = false;
  for (const auction of containerAuctions.filter((item) => item.endAt <= Date.now())) {
    if (auction.highestBidderType === "player") {
      const winner = players.get(auction.highestBidderId);
      if (winner && winner.cash >= auction.highestBid && winner.garage.length < winner.garageCapacity) {
        const rewardCar = containerRewardCar(auction.tier, auction.highestBid, winner);
        winner.cash -= auction.highestBid; winner.garage.push(rewardCar); winner.stats.auctionsWon += 1; addXp(winner, 90);
        addLedger(winner, "container", `Автомобиль из контейнера: ${rewardCar.model}`, -auction.highestBid, { carId: rewardCar.id, category: "Автомобили" });
        const item = catalog.find((entry) => entry.model === rewardCar.model);
        const marketPrice = marketIndices[rewardCar.model]?.price || rewardCar.cleanValue;
        winner.containerRewards.push({ id: id("reward_"), containerId: auction.id, tier: auction.tier, containerName: auction.name, paid: auction.highestBid, awardedAt: Date.now(), acknowledged: false, car: { id: rewardCar.id, make: rewardCar.make, photoQuery: rewardCar.photoQuery, photoUrl: rewardCar.photoUrl, photoSource: rewardCar.photoSource, model: rewardCar.model, year: rewardCar.year, mileage: rewardCar.mileage, condition: rewardCar.condition, className: rewardCar.className, color: rewardCar.color, cleanValue: rewardCar.cleanValue, estimatedValue: currentValue(rewardCar), marketPrice, defectCount: rewardCar.defects.length, rarity: item?.base >= 30000000 ? "Легендарный" : item?.base >= 8000000 ? "Редкий" : item?.base >= 1000000 ? "Необычный" : "Обычный" } });
      }
    }
    containerAuctions.splice(containerAuctions.indexOf(auction), 1); changed = true;
  }
  if (changed) { restockContainers(); broadcast(); persistState(); }
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
    extendClosingAuction(auction, "endAt");
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
    if (car.npcPricingVersion >= VEHICLE_PRICING_VERSION) return;
    const ratio = (index + 0.5) / Math.max(1, npcCars.length);
    const pricing = npcPricingProfile(ratio);
    const fair = currentValue(car);
    const reference = clamp(marketIndices[car.model]?.price || fair, fair * 0.78, fair * 1.28);
    const multiplier = pricing.min + Math.random() * (pricing.max - pricing.min);
    car.price = npcAskingPrice(car, pricing.key);
    car.purchasePrice = car.price;
    car.invested = car.price;
    car.marketTag = pricing.tag;
    car.npcPricingVersion = VEHICLE_PRICING_VERSION;
    car.listedAt = Date.now() - randomInt(0, NPC_ROTATION_MS);
  });
  for (const car of market.filter((item) => !item.sellerId && item.saleType === "auction" && !item.bidCount)) {
    const fair = saleEstimate(car).expectedNpcPrice;
    car.startingPrice = Math.max(1000, Math.round(clamp(car.startingPrice || car.price, fair * 0.58, fair * 0.82) / 1000) * 1000);
    car.price = car.startingPrice;
  }
  ensureNpcAuctions();
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
  const playerId = token === FALLBACK_ADMIN_TOKEN ? (ALLOW_FALLBACK_ADMIN ? [...players.values()].find((item) => item.normalizedName === FALLBACK_ADMIN_LOGIN)?.id : undefined) : token && sessions.get(token);
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
  if (!paymentMatches(order, payment) || order.status === "succeeded") return false;
  const player = players.get(order.playerId);
  if (!player) return false;
  const pack = cashPackages.find((item) => item.id === order.packageId);
  grantPurchase(player, order);
  if (pack && supporterTierRank[pack.supporterTier] > supporterTierRank[player.supporterTier || "none"]) player.supporterTier = pack.supporterTier;
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
  if (listingBlockReason(car)) return false;
  const marketIndex = market.findIndex((item) => item.id === car.id);
  if (marketIndex < 0) return false;
  if (buyer && (buyer.cash < amount || buyer.garage.length >= buyer.garageCapacity)) return false;
  const seller = car.sellerId ? players.get(car.sellerId) : null;
  const sellerInvestment = car.invested;
  if (buyer) {
    buyer.cash -= amount;
    buyer.garage.push(car);
    buyer.stats.purchases += 1;
    if (car.saleType === "auction") buyer.stats.auctionsWon += 1;
    addXp(buyer, 25);
    addLedger(buyer, "purchase", `Покупка: ${car.model}`, -amount, { carId: car.id, counterparty: car.seller, category: "Автомобили" });
  }
  if (seller) {
    seller.cash += amount;
    seller.profit += amount - car.invested;
    seller.deals += 1;
    useWorkplace(seller, ["showroom", "premium_showroom"]);
    seller.dealStyles ||= {};
    const style = car.upgrades.length ? "tuning" : car.repairs.length ? "restoration" : "quick";
    seller.dealStyles[style] = (seller.dealStyles[style] || 0) + 1;
    addXp(seller, 100);
    const honest = !(/идеал|без проблем|вложений не требует/i.test(car.description) && car.defects.some((defect) => !defect.repaired));
    seller.reputation.score = clamp(seller.reputation.score + (honest ? 1 : -5), 0, 100);
    seller.reputation.completed += 1;
    addLedger(seller, "sale", `Продажа: ${car.model}`, amount, { carId: car.id, counterparty: buyer?.name || "Покупатель", profit: amount - sellerInvestment, category: "Автомобили" });
    for (const contract of seller.contracts) {
      if (contract.status !== "active" || contract.expiresAt < Date.now() || contract.model && contract.model !== car.model) continue;
      const qualifies = contract.kind === "profit" ? amount > car.invested : contract.kind === "honest" ? honest : car.serviceDiagnosed && car.repairs.length > 0;
      if (qualifies) { contract.status = "completed"; seller.cash += contract.reward; seller.profit += contract.reward; seller.reputation.score = clamp(seller.reputation.score + 2, 0, 100); }
    }
    if (honest && seller.deals % 3 === 0 && !seller.contracts.some(item => item.repeatCustomer && item.status === "active" && item.expiresAt > Date.now())) {
      seller.contracts.push({ id: id("contract_"), title: "По рекомендации", description: `Подготовьте ещё один ${car.model}: полный осмотр и ремонт`, kind: "restored", model: car.model, reward: Math.min(80000, Math.max(1500, Math.round(amount * .04))), expiresAt: Date.now() + 7 * 86400000, status: "active", repeatCustomer: true });
      seller.notifications.push({ id: id("notice_"), type: "deal", title: "Вас рекомендовали знакомым", text: `Новый заказ на ${car.model} появился в сделках.`, at: Date.now(), read: false });
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
  car.plateIncluded = false;
  car.history.push({ type: "sold", text: `Сделка завершена за ${amount} ₽`, at: Date.now() });
  car.discovered = buyer ? [...new Set(car.publicDiscovered || [])] : [];
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
  car.scamDeposit = 0;
  // Мусор из прошлой сделки не должен переезжать к новому владельцу.
  car.buyerFindings = {};
  car.fraudCheckedBy = {};
  if (car.fraud?.revealed || car.fraud?.applied) car.fraud = null;
  let fraudOutcome = null;
  if (seller && (car.schemes || []).length) {
    fraudOutcome = revertFraudulentSale(seller, buyer, car, amount, sellerInvestment);
    if (!fraudOutcome.caught) settleSaleWithBank(seller, car, amount, sellerInvestment, Math.max(0, seller.deals - 1));
  } else if (seller) {
    settleSaleWithBank(seller, car, amount, sellerInvestment, Math.max(0, seller.deals - 1));
  }
  // Купили вслепую — обман продавца раскрывается уже в вашем гараже.
  if (!fraudOutcome?.caught && buyer && car.fraud && !car.fraud.revealed) applyHiddenFraud(buyer, car);
  car.schemes = [];
  car.schemesExposed = false;
  restock();
  return true;
}

function inspectForNpc(car, bot) {
  const found = fraud.concealedFromBuyer(car) ? [] : npcFaults(car, bot);
  if (!found.length) return false;
  car.publicDiscovered ||= [];
  car.discovered ||= [];
  const fresh = found.filter(defect => !car.publicDiscovered.includes(defect.code));
  for (const defect of found) {
    if (!car.publicDiscovered.includes(defect.code)) car.publicDiscovered.push(defect.code);
    if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
  }
  if (fresh.length) {
    const text = `${bot.name} отказался от покупки: ${fresh.map(defect => defect.name).join(', ')}. Требуется ремонт.`;
    car.history.push({ type: 'inspection', text, at: Date.now() });
    const owner = players.get(car.sellerId);
    if (owner) owner.notifications.push({ id: id('notice_'), type: 'repair-required', title: 'Покупатель нашёл неисправность', text, carId: car.id, createdAt: Date.now(), read: false });
    for (const offer of offers.values()) if (offer.carId === car.id && offer.buyerType === 'bot' && ['active', 'counter'].includes(offer.status)) offer.status = 'rejected';
  }
  return true;
}

function evaluateBots(car) {
  if (!market.some((item) => item.id === car.id) || !car.sellerId) return;
  if (saleBlockReason(car)) return;
  const lie = /вложений не требует|идеал|без проблем/i.test(car.description) && car.defects.some((defect) => !defect.repaired);
  const contacted = new Set([...offers.values()].filter(offer => offer.carId === car.id && (["active", "counter"].includes(offer.status) || offer.status === "rejected" && Date.now() - (offer.lastOfferAt || offer.createdAt) < 120000)).map(offer => offer.buyerId));
  const types = new Set();
  const seller = players.get(car.sellerId);
  const candidates = [...bots].filter(bot => !contacted.has(bot.id)).sort((a, b) => botAuctionCeiling(car, b) - botAuctionCeiling(car, a)).filter(bot => {
    if (types.has(bot.type)) return false;
    types.add(bot.type); return true;
  }).slice(0, 3);
  for (const bot of candidates) {
    if (bot.budget < car.price * .65) continue;
    if (seller?.npcMuted?.[bot.id] > Date.now()) continue;
    if (inspectForNpc(car, bot)) break;
    const detected = npcFaults(car, bot);
    const ceiling = botAuctionCeiling(car, bot);
    if (ceiling < 1) continue;
    const scam = fraud.rollScamOffer({ price: car.price, sellerReputation: seller?.reputation?.score || 50, level: levelForXp(seller?.xp || 0), scamChance: SCAM_RATE });
    const amount = clamp(Math.round(Math.min(car.price * 0.97, ceiling) / 1000) * 1000, 1, car.price - 1);
    if (amount >= car.price) continue;
    const issue = detected.sort((a, b) => b.impact - a.impact)[0];
    const reason = lie && issue
      ? `В описании всё идеально, но я вижу: ${issue.name.toLowerCase()}. Моя цена ниже.`
      : issue ? `Учёл риск: ${issue.name.toLowerCase()}. Готов забрать сегодня.`
        : car.repairs.length ? `Вижу подтверждённые работы (${car.repairs.length}). За подготовленную машину готов платить выше среднего.`
          : car.price > saleEstimate(car).expectedNpcPrice ? "Цена выше моей оценки. Предлагаю сумму ближе к реальной стоимости." : "Готов быстро оформить сделку без дальнейшего торга.";
    const offer = {
      id: id("offer_"), carId: car.id, sellerId: car.sellerId,
      buyerId: bot.id, buyerName: bot.name, buyerType: "bot",
      amount: scam ? Math.max(amount, Math.min(bot.budget, scam.amount)) : amount,
      status: "active", reason: scam ? scam.text : reason, createdAt: Date.now(), attempts: 0, lastOfferAt: Date.now(),
      kind: scam ? "scam" : "offer", deposit: scam ? scam.deposit : 0, signs: scam ? scam.signs : [], expiresAt: scam ? Date.now() + 240000 : null
    };
    offers.set(offer.id, offer);
  }
  broadcast();
}

function scheduleBots(car) {
  setTimeout(() => evaluateBots(car), 2500 + randomInt(0, 2000));
}

function refreshNpcOffers() {
  for (const [id, offer] of offers) if (offer.kind === "scam" && offer.expiresAt && offer.expiresAt < Date.now()) { offer.status = "expired"; }
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
    if (listingBlockReason(car)) {
      car.highestBid = 0; car.highestBidderId = null; car.highestBidderType = null; car.highestBidderName = null;
    }
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
    if (index >= 0 && !car.sellerId) {
      market.splice(index, 1);
      continue;
    }
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
  restock();
  broadcast();
  persistState();
}

setInterval(finalizeAuctions, 1000).unref();

function botAuctionCeiling(car, bot) {
  if (listingBlockReason(car)) return 0;
  const estimate = saleEstimate(car);
  const unresolved = car.defects.filter(defect => !defect.repaired);
  const detected = fraud.concealedFromBuyer(car) ? [] : npcFaults(car, bot);
  const unknownCount = unresolved.filter(defect => !detected.includes(defect)).length;
  const seller = players.get(car.sellerId);
  const classic = new Date().getFullYear() - car.year >= 25 || ["classic", "coupe", "roadster", "premium"].includes(car.className);
  const value = Math.max(1000, Math.round(estimate.expectedNpcPrice * (1 + fraud.deceptionBonus(car, Boolean(car.schemesExposed))) / 1000) * 1000);
  const price = buyerPrice({ value, fit: npcFit(car, bot, upgradeCatalog).multiplier, type: bot.type, unknownCount, lied: /идеал|без проблем|вложений не требует/i.test(car.description) && unresolved.length > 0, relationship: seller?.npcRelations?.[bot.id] || 0, repaired: car.repairs.length > 0, classic });
  return Math.min(bot.budget, Math.max(1000, price));
}

function runAuctionBots() {
  let changed = false;
  const now = Date.now();
  const active = market.filter((car) => car.saleType === "auction" && car.auctionEnd > now + 1500);
  for (const car of active) {
    if (listingBlockReason(car)) continue;
    const humanInterest = car.participantIds.length > 0;
    const idleFor = now - (car.lastPlayerBidAt || car.listedAt || now);
    const npcCooldown = car.lastNpcBidAt ? now - car.lastNpcBidAt : Infinity;
    if (npcCooldown < 3000) continue;
    const chance = BOT_BID_CHANCE === 1 ? 1 : !humanInterest && idleFor >= 2500 ? (car.bidCount ? 0.68 : 0.9) : 0.42;
    if (Math.random() > chance) continue;
    const candidates = bots
      .filter((bot) => bot.id !== car.highestBidderId)
      .map((bot) => ({ bot, ceiling: botAuctionCeiling(car, bot) }))
      .filter(({ ceiling }) => ceiling >= (car.highestBid ? car.highestBid + Math.max(1, Math.ceil(car.highestBid * 0.01)) : car.startingPrice))
      .sort((a, b) => b.ceiling - a.ceiling || Math.random() - 0.5);
    for (const { bot, ceiling } of candidates) {
      const current = car.highestBid || car.startingPrice;
      const minimum = car.highestBid ? current + Math.max(1, Math.ceil(current * 0.01)) : current;
      const jump = Math.min(ceiling - minimum, Math.max(1000, ceiling * 0.025));
      const bid = car.bidCount ? Math.min(ceiling, Math.max(minimum, Math.round((minimum + Math.random() * jump) / 1000) * 1000)) : minimum;
      const previousPlayerId = car.highestBidderType === "player" ? car.highestBidderId : null;
      car.highestBid = Math.max(minimum, bid);
      car.highestBidderId = bot.id;
      car.highestBidderName = bot.name;
      car.highestBidderType = "bot";
      car.price = car.highestBid;
      car.bidCount += 1;
      car.lastNpcBidAt = now;
      extendClosingAuction(car, "auctionEnd");
      if (previousPlayerId) notifyOutbid(previousPlayerId, "car", car.model, car.highestBid, car.id);
      changed = true;
      break;
    }
  }
  if (changed) broadcast();
}

setInterval(runAuctionBots, 2200).unref();
setInterval(rotateNpcMarket, NPC_ROTATION_MS).unref();
setInterval(updateCryptoMarket, 30000).unref();
setInterval(finalizeItemContainers, 1000).unref();
setInterval(processNpcPlateBuyer, 15000).unref();

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
  player.chatState ||= { sentAt: [], lastNormalized: "", lastDuplicateAt: 0, violations: 0, mutedUntil: 0 };
  const text = normalizeChatText(rawText);
  const now = Date.now();
  const chat = player.chatState;
  if (chat.mutedUntil > now) throw new Error(`Чат временно недоступен ещё ${Math.ceil((chat.mutedUntil - now) / 1000)} сек.`);
  if (text.length < 1) throw new Error("Введите сообщение");
  if ((text.match(/https?:\/\/|www\.|\.ru\b|\.com\b/gi) || []).length > 1) throw new Error("В сообщении слишком много ссылок");
  if (/\b(?:телеграм|telegram|whatsapp|ватсап)\b.*(?:@|\+?\d[\d\s()-]{8,})/iu.test(text)) throw new Error("Не публикуйте личные контакты в игровом чате");
  if (/\b(?:убью|зарежу|найду тебя|сдохни|суицид)\b/iu.test(text)) {
    chat.violations += 2;
    chat.mutedUntil = now + 10 * 60000;
    throw new Error("Сообщение нарушает правила. Чат заблокирован на 10 минут");
  }
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
    return json(res, 200, { status: "ok", service: "perekup-market", revision, uptimeSeconds: Math.round(process.uptime()), dataDir: DATA_DIR, s3Sync: s3Sync.configured() ? s3Sync.describeTarget() : "off" });
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
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2) return json(res, 400, { error: "Введите имя от 2 символов" });
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: "Введите корректный email" });
    if (!validPassword(password)) return json(res, 400, { error: "Пароль: 8–72 символа, только английские буквы, цифры и спецсимволы" });
    const normalized = name.toLocaleLowerCase("ru-RU");
    if (ADMIN_NAMES.has(normalized)) return json(res, 409, { error: "Этот логин зарезервирован" });
    if ([...players.values()].some((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === normalized && (item.pinHash || item.passwordHash))) {
      return json(res, 409, { error: "Аккаунт с таким именем уже существует" });
    }
    if ([...players.values()].some((item) => String(item.email || "").trim().toLowerCase() === email)) return json(res, 409, { error: "Этот email уже зарегистрирован. На один email можно создать только один аккаунт." });
    const player = createPlayer(name, null, { email, password, emailVerified: false });
    if (normalized === CONFIGURED_ADMIN_LOGIN) player.adminGranted = true;
    const verificationToken = id("verify_");
    emailVerifications.set(verificationToken, { playerId: player.id, expiresAt: Date.now() + 86400000 });
    try { await sendVerificationEmail(email, name, verificationToken); } catch (error) { emailVerifications.delete(verificationToken); return json(res, 503, { error: error.message }); }
    players.set(player.id, player);
    const referral = applyReferralPromo(body.promo, player);
    persistState();
    return json(res, 200, { pendingVerification: true, email, referralApplied: referral.applied, referralInvalid: Boolean(referral.invalid) });
  }

  if (req.method === "GET" && pathname === "/api/verify-email") {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const verificationToken = requestUrl.searchParams.get("token") || "";
    const record = emailVerifications.get(verificationToken);
    if (!record || record.expiresAt < Date.now()) return json(res, 400, { error: "Ссылка недействительна или устарела" });
    const player = players.get(record.playerId);
    if (!player) return json(res, 404, { error: "Аккаунт не найден" });
    player.emailVerified = true; emailVerifications.delete(verificationToken);
    const token = id("session_"); sessions.set(token, player.id); persistState();
    return json(res, 200, { ok: true, token, ...snapshot(player) });
  }

  if (req.method === "POST" && pathname === "/api/request-password-reset") {
    const body = await readBody(req);
    const email = String(body.email || "").trim().toLowerCase();
    let player = [...players.values()].find((item) => item.email === email && item.passwordHash);
    if (ALLOW_FALLBACK_ADMIN && !player && email === CONFIGURED_ADMIN_EMAIL) {
      player = [...players.values()].find((item) => item.normalizedName === FALLBACK_ADMIN_LOGIN);
      if (!player) player = createPlayer(FALLBACK_ADMIN_LOGIN, null, { email: CONFIGURED_ADMIN_EMAIL, password: FALLBACK_ADMIN_PASSWORD, emailVerified: true });
      player.adminGranted = true;
      players.set(player.id, player);
      persistState();
    }
    if (player && player.emailVerified) {
      const resetToken = id("reset_");
      passwordResets.set(resetToken, { playerId: player.id, expiresAt: Date.now() + 3600000 });
      try { await sendPasswordResetEmail(email, player.name, resetToken); } catch (error) { passwordResets.delete(resetToken); }
    }
    return json(res, 200, { message: "Если такой email зарегистрирован, письмо с инструкциями уже отправлено." });
  }

  if (req.method === "POST" && pathname === "/api/reset-password") {
    const body = await readBody(req);
    const resetToken = String(body.token || "");
    const password = String(body.password || "");
    const record = passwordResets.get(resetToken);
    if (!record || record.expiresAt < Date.now()) return json(res, 400, { error: "Ссылка недействительна или устарела" });
    if (!validPassword(password)) return json(res, 400, { error: "Пароль: 8–72 символа, только английские буквы, цифры и спецсимволы" });
    const player = players.get(record.playerId);
    if (!player) return json(res, 404, { error: "Аккаунт не найден" });
    const credentials = hashPassword(password); player.passwordSalt = credentials.salt; player.passwordHash = credentials.hash; player.emailVerified = true;
    passwordResets.delete(resetToken); persistState();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().toLocaleLowerCase("ru-RU");
    const password = String(body.password || "");
    const pin = String(body.pin || "");
    let player = [...players.values()].find((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === name && (item.passwordHash || item.pinHash));
    if (ALLOW_FALLBACK_ADMIN && name === FALLBACK_ADMIN_LOGIN && password === FALLBACK_ADMIN_PASSWORD) {
      if (!player) player = createPlayer(FALLBACK_ADMIN_LOGIN, null, { email: CONFIGURED_ADMIN_EMAIL, password: FALLBACK_ADMIN_PASSWORD, emailVerified: true });
      const fallbackCredentials = hashPassword(FALLBACK_ADMIN_PASSWORD);
      player.passwordSalt = fallbackCredentials.salt;
      player.passwordHash = fallbackCredentials.hash;
      player.adminGranted = true;
      player.email = CONFIGURED_ADMIN_EMAIL;
      player.emailVerified = true;
      players.set(player.id, player);
      persistState();
    }
    const valid = player && (player.passwordHash ? verifyPassword(password, player) : verifyPin(pin, player));
    if (!valid) return json(res, 401, { error: "Неверный логин или пароль" });
    if (player.passwordHash && !player.emailVerified) return json(res, 403, { error: "Подтвердите email по ссылке из письма" });
    const blocked = banMessage(player);
    if (blocked) return json(res, 403, { error: blocked });
    const token = name === FALLBACK_ADMIN_LOGIN && password === FALLBACK_ADMIN_PASSWORD ? FALLBACK_ADMIN_TOKEN : id("session_");
    sessions.set(token, player.id);
    persistState();
    return json(res, 200, { token, ...snapshot(player) });
  }

  if (req.method === "POST" && pathname === "/api/join") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 20);
    if (name.length < 2) return json(res, 400, { error: "Введите имя от 2 символов" });
    if (ADMIN_NAMES.has(name.toLocaleLowerCase("ru-RU"))) return json(res, 409, { error: "Этот логин зарезервирован" });
    const token = id("session_");
    const pin = /^[0-9]{4,8}$/.test(String(body.pin || "")) ? String(body.pin) : null;
    // Гость с тем же ником и пином продолжает прежний аккаунт, а не заводит второй:
    // иначе вход по нику и PIN после перезапуска находится «в никуда».
    const resumeName = name.toLocaleLowerCase("ru-RU");
    const resumed = pin ? [...players.values()].find((candidate) => (candidate.normalizedName || candidate.name.toLocaleLowerCase("ru-RU")) === resumeName && candidate.pinHash && verifyPin(pin, candidate)) : null;
    const player = resumed || createPlayer(name, pin);
    if (resumeName === CONFIGURED_ADMIN_LOGIN) player.adminGranted = true;
    if (!resumed) players.set(player.id, player);
    const referral = resumed ? { applied: false, invalid: false } : applyReferralPromo(body.promo, player);
    sessions.set(token, player.id);
    persistState();
    broadcast();
    return json(res, 200, { token, resumed: Boolean(resumed), referralApplied: referral.applied, referralInvalid: Boolean(referral.invalid), ...snapshot(player) });
  }

  const player = getPlayer(req);
  if (!player) return json(res, 401, { error: "Сессия не найдена" });
  const blocked = banMessage(player);
  if (blocked) return json(res, 403, { error: blocked });
  // Пока идёт разбирательство по делу о мошенничестве, торговля приостановлена.
  if ((player.fraud?.blockedUntil || 0) > Date.now() && ["/api/buy", "/api/bid", "/api/offer", "/api/offer/respond", "/api/list", "/api/fraud/scheme"].includes(pathname)) {
    return json(res, 403, { error: `Вы под разбирательством: сделки закрыты ещё на ${Math.max(1, Math.ceil((player.fraud.blockedUntil - Date.now()) / 1000))} сек.` });
  }
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, snapshot(player));
  if (req.method === "POST" && pathname === "/api/profile/appearance") {
    const body = await readBody(req);
    const item = cosmetics.find(item => item.id === body.cosmeticId);
    if (!item || !ownsCosmetic(player, item, levelForXp(player.xp))) return json(res, 403, { error: "Это оформление ещё не открыто" });
    player.appearance ||= {}; player.appearance[item.slot] = item.id;
    persistState(); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/profile/update") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().slice(0, 20);
    const normalized = name.toLocaleLowerCase("ru-RU");
    if (name.length < 2) return json(res, 400, { error: "Ник должен содержать минимум 2 символа" });
    if (![...players.values()].every((candidate) => candidate.id === player.id || (candidate.normalizedName || candidate.name.toLocaleLowerCase("ru-RU")) !== normalized)) return json(res, 409, { error: "Этот ник уже занят" });
    const hadAdminAccess = isAdmin(player);
    if (!hadAdminAccess && ADMIN_NAMES.has(normalized)) return json(res, 409, { error: "Этот ник зарезервирован" });
    const avatar = [...String(body.avatar || "").trim()].slice(0, 2).join("");
    player.name = name; player.normalizedName = normalized; player.avatar = avatar;
    if (hadAdminAccess) player.adminGranted = true;
    persistState(); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "GET" && pathname === "/api/player/profile") {
    const playerId = new URL(req.url, `http://${req.headers.host}`).searchParams.get("id");
    const candidate = players.get(String(playerId || ""));
    if (!candidate || banMessage(candidate)) return json(res, 404, { error: "Профиль игрока недоступен" });
    return json(res, 200, publicPlayerProfile(candidate, player));
  }
  if (req.method === "GET" && pathname === "/api/admin/state") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    const referralsByReferrer = new Map();
    for (const candidate of players.values()) {
      if (!candidate.referredBy) continue;
      const list = referralsByReferrer.get(candidate.referredBy) || [];
      list.push(candidate);
      referralsByReferrer.set(candidate.referredBy, list);
    }
    const referralTop = [...referralsByReferrer.entries()].map(([referrerId, list]) => {
      const referrer = players.get(referrerId);
      if (!referrer) return null;
      return {
        id: referrerId, name: referrer.name, code: referrer.referralCode || "", count: list.length, earned: referrer.referralCash || 0,
        recent: list.sort((a, b) => (b.referralAppliedAt || 0) - (a.referralAppliedAt || 0)).slice(0, 5).map((entry) => ({ name: entry.name, at: entry.referralAppliedAt || null }))
      };
    }).filter(Boolean).sort((a, b) => b.count - a.count).slice(0, 100);
    return json(res, 200, {
      players: [...players.values()].map((item) => ({ id: item.id, name: item.name, avatar: item.avatar || "", cash: item.cash, skillPoints: item.skillPoints, profit: item.profit, deals: item.deals, level: levelForXp(item.xp), garage: item.garage.length, reputation: item.reputation?.score || 50, purchasedCash: item.purchasedCash || 0, bannedUntil: item.bannedUntil || 0, banReason: item.banReason || "", profileBadge: item.profileBadge || "", supporterTier: item.supporterTier || "none", isAdmin: isAdmin(item), referralCode: item.referralCode || "", referredBy: item.referredBy ? players.get(item.referredBy)?.name || null : null })),
      reports: moderationReports.filter((report) => report.status === "open").slice().reverse(),
      economy: { players: players.size, marketCars: market.length, deals: salesHistory.length, activeOffers: [...offers.values()].filter((offer) => ["active", "counter"].includes(offer.status)).length, payments: [...paymentOrders.values()].filter((order) => order.status === "succeeded").length, openReports: moderationReports.filter((report) => report.status === "open").length, referredPlayers: [...referralsByReferrer.values()].reduce((sum, list) => sum + list.length, 0), referralPaid: [...players.values()].reduce((sum, item) => sum + (item.referralCash || 0), 0) },
      referrals: { total: [...referralsByReferrer.values()].reduce((sum, list) => sum + list.length, 0), paid: [...players.values()].reduce((sum, item) => sum + (item.referralCash || 0), 0), bonus: REFERRAL_BONUS_CASH, top: referralTop }
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
    const pack = stylePackages.find((item) => item.id === body.packageId);
    if (!pack) return json(res, 404, { error: "Пакет не найден" });
    if (pack.cosmetics.every(id => ownsCosmetic(player, cosmetics.find(item => item.id === id), levelForXp(player.xp)))) return json(res, 409, { error: "Этот комплект уже открыт" });
    const orderId = id("order_");
    try {
      const payment = await yookassaRequest("/payments", {
        method: "POST", headers: { "Idempotence-Key": orderId },
        body: JSON.stringify({ amount: { value: pack.rubles.toFixed(2), currency: "RUB" }, capture: true, confirmation: { type: "redirect", return_url: `${PUBLIC_URL}/#store` }, description: `Оформление профиля: ${pack.name}`, metadata: { orderId, playerId: player.id, packageId: pack.id } })
      });
      paymentOrders.set(payment.id, { orderId, paymentId: payment.id, playerId: player.id, packageId: pack.id, rubles: pack.rubles, cash: 0, cosmetics: [...pack.cosmetics], status: "pending", createdAt: Date.now() });
      persistState();
      return json(res, 200, { confirmationUrl: payment.confirmation?.confirmation_url });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (req.method === "POST" && pathname === "/api/admin/player") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    const target = players.get(String(body.playerId || ""));
    if (!target) return json(res, 404, { error: "Игрок не найден" });
    const hasCash = body.cashValue !== undefined || body.cashDelta !== undefined;
    const hasSkillPoints = body.skillPointsValue !== undefined;
    if (!hasCash && !hasSkillPoints) return json(res, 400, { error: "Укажите баланс или очки навыков" });
    const note = { adminId: player.id, reason: String(body.reason || "Корректировка администратора").slice(0, 100), at: Date.now() };
    if (hasCash) {
      const mode = body.cashMode === "set" ? "set" : "adjust";
      const input = Math.round(Number(body.cashValue ?? body.cashDelta));
      const nextCash = mode === "set" ? input : target.cash + input;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(nextCash) || nextCash < reservedCash(target) || nextCash > MAX_ADMIN_VALUE) {
        return json(res, 400, { error: `Баланс должен быть целым числом от ${reservedCash(target).toLocaleString("ru-RU")} до ${MAX_ADMIN_VALUE.toLocaleString("ru-RU")} ₽` });
      }
      note.cashBefore = target.cash; note.cashAfter = nextCash; note.delta = nextCash - target.cash;
      target.cash = nextCash;
    }
    if (hasSkillPoints) {
      const mode = body.skillPointsMode === "adjust" ? "adjust" : "set";
      const input = Math.round(Number(body.skillPointsValue));
      const nextSkillPoints = mode === "set" ? input : target.skillPoints + input;
      if (!Number.isSafeInteger(input) || !Number.isSafeInteger(nextSkillPoints) || nextSkillPoints < 0 || nextSkillPoints > MAX_ADMIN_VALUE) {
        return json(res, 400, { error: `Очки навыков должны быть целым числом от 0 до ${MAX_ADMIN_VALUE.toLocaleString("ru-RU")}` });
      }
      note.skillPointsBefore = target.skillPoints; note.skillPointsAfter = nextSkillPoints;
      target.skillPoints = nextSkillPoints;
    }
    target.adminNotes.push(note);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/direct/send") {
    const recipient = players.get(String(body.recipientId || ""));
    if (!recipient || recipient.id === player.id || banMessage(recipient)) return json(res, 404, { error: "Пользователь недоступен" });
    try {
      const text = moderateChat(player, body.message);
      directMessages.push({ id: id("dm_"), senderId: player.id, senderName: player.name, recipientId: recipient.id, recipientName: recipient.name, text, createdAt: Date.now(), readAt: null });
      if (directMessages.length > 1000) directMessages.splice(0, directMessages.length - 1000);
      broadcast(); return json(res, 200, snapshot(player));
    } catch (error) { persistState(); return json(res, 429, { error: error.message }); }
  }
  if (req.method === "POST" && pathname === "/api/direct/read") {
    const otherId = String(body.playerId || "");
    for (const message of directMessages) if (message.senderId === otherId && message.recipientId === player.id && !message.readAt) message.readAt = Date.now();
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/chat/report") {
    const messageId = String(body.messageId || "");
    const publicMessage = chatMessages.find((item) => item.id === messageId);
    const privateMessage = directMessages.find((item) => item.id === messageId && (item.senderId === player.id || item.recipientId === player.id));
    const message = publicMessage || privateMessage;
    if (!message) return json(res, 404, { error: "Сообщение уже недоступно" });
    const accusedId = publicMessage ? message.playerId : message.senderId;
    const accusedName = publicMessage ? message.playerName : message.senderName;
    if (accusedId === player.id) return json(res, 400, { error: "Нельзя пожаловаться на своё сообщение" });
    const reason = normalizeChatText(body.reason).slice(0, 160);
    if (reason.length < 5) return json(res, 400, { error: "Кратко укажите причину жалобы" });
    if (moderationReports.some((report) => report.messageId === message.id && report.reporterId === player.id && report.status === "open")) return json(res, 409, { error: "Вы уже отправили жалобу на это сообщение" });
    moderationReports.push({ id: id("report_"), messageId: message.id, messageText: message.text, source: publicMessage ? "public" : "direct", accusedId, accusedName, reporterId: player.id, reporterName: player.name, reason, status: "open", createdAt: Date.now() });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/admin/moderation") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    const target = players.get(String(body.playerId || ""));
    const action = String(body.action || "");
    if (["set-badge", "set-supporter", "set-admin"].includes(action)) {
      if (!target) return json(res, 404, { error: "Игрок не найден" });
      if (action === "set-admin" && target.id === player.id && !body.enabled) return json(res, 400, { error: "Нельзя забрать админку у самого себя" });
      if (action === "set-admin") target.adminGranted = Boolean(body.enabled);
      else if (action === "set-badge") target.profileBadge = String(body.badge || "").trim().slice(0, 32);
      else {
        const supporterTier = String(body.supporterTier || "none");
        if (!Object.prototype.hasOwnProperty.call(supporterTierRank, supporterTier)) return json(res, 400, { error: "Неизвестный статус поддержки" });
        target.supporterTier = supporterTier;
      }
      persistState();
    } else if (["delete-message"].includes(action)) {
      const messageId = String(body.messageId || "");
      const publicIndex = chatMessages.findIndex((message) => message.id === messageId);
      const directIndex = directMessages.findIndex((message) => message.id === messageId);
      if (publicIndex < 0 && directIndex < 0) return json(res, 404, { error: "Сообщение уже удалено" });
      if (publicIndex >= 0) chatMessages.splice(publicIndex, 1); else directMessages.splice(directIndex, 1);
      persistState();
    } else if (["ban", "unban", "mute"].includes(action)) {
      if (!target) return json(res, 404, { error: "Игрок не найден" });
      if (isAdmin(target)) return json(res, 400, { error: "Нельзя заблокировать администратора" });
      if (action === "mute") { target.chatState.mutedUntil = Date.now() + 60 * 60000; }
      else if (action === "unban") { target.bannedUntil = 0; target.banReason = ""; }
      else {
        const duration = Number(body.durationMinutes);
        if (![-1, 60, 1440, 10080, 43200].includes(duration)) return json(res, 400, { error: "Недопустимый срок блокировки" });
        target.bannedUntil = duration === -1 ? -1 : Date.now() + duration * 60000;
        target.banReason = String(body.reason || "Нарушение правил сообщества").trim().slice(0, 160) || "Нарушение правил сообщества";
        for (const client of [...clients]) if (client.player.id === target.id) {
          client.res.write(`event: banned\ndata: ${JSON.stringify({ error: banMessage(target) })}\n\n`);
          client.res.end(); clients.delete(client);
        }
      }
    } else if (["resolve", "dismiss"].includes(action)) {
      const report = moderationReports.find((item) => item.id === String(body.reportId || "") && item.status === "open");
      if (!report) return json(res, 404, { error: "Жалоба уже обработана" });
      report.status = action === "resolve" ? "resolved" : "dismissed"; report.moderatorId = player.id; report.resolvedAt = Date.now();
    } else return json(res, 400, { error: "Неизвестное действие модерации" });
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
  if (req.method === "POST" && pathname === "/api/plates/buy") {
    const lotIndex = plateMarket.findIndex((lot) => lot.id === String(body.lotId || ""));
    if (lotIndex < 0) return json(res, 404, { error: "Номер уже продан" });
    const lot = plateMarket[lotIndex];
    if (lot.sellerId === player.id) return json(res, 400, { error: "Это ваш номер" });
    if (player.cash - reservedCash(player) < lot.price) return json(res, 400, { error: "Недостаточно свободных денег" });
    player.cash -= lot.price;
    player.plateInventory.push(ensurePlate(lot.plate));
    const seller = lot.sellerId && players.get(lot.sellerId);
    if (seller) { const payout = Math.round(lot.price * 0.95); seller.cash += payout; addLedger(seller, "plate-sale", `Продажа номера ${lot.plate.number}`, payout, { category: "Госномера" }); }
    addLedger(player, "plate-buy", `Покупка номера ${lot.plate.number}`, -lot.price, { category: "Госномера" });
    plateMarket.splice(lotIndex, 1); restockPlateMarket();
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/plates/issue") {
    const cost = balance.fee(12000, levelForXp(player.xp));
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Для выдачи номера нужно ${cost.toLocaleString("ru-RU")} ₽` });
    player.cash -= cost;
    const plate = makePlate(); player.plateInventory.push(plate);
    addLedger(player, "plate-issue", `Выдан госномер ${plate.number}`, -cost, { category: "Госномера" });
    broadcast(); return json(res, 200, { ...snapshot(player), issuedPlate: plate });
  }
  if (req.method === "POST" && pathname === "/api/plates/list") {
    const plateIndex = player.plateInventory.findIndex((plate) => plate.id === String(body.plateId || ""));
    if (plateIndex < 0) return json(res, 404, { error: "Номера нет в вашей коллекции" });
    const price = Math.round(Number(body.price));
    if (!Number.isFinite(price) || price < 1 || price > 100000000) return json(res, 400, { error: "Цена номера должна быть от 1 ₽ до 100 000 000 ₽" });
    const plate = player.plateInventory.splice(plateIndex, 1)[0];
    plateMarket.unshift(ensurePlateLot({ id: id("plate_lot_"), plate, price, seller: player.name, sellerId: player.id, marketPricingVersion: 2, createdAt: Date.now() }));
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/plates/unlist") {
    const lotIndex = plateMarket.findIndex((lot) => lot.id === String(body.lotId || "") && lot.sellerId === player.id);
    if (lotIndex < 0) return json(res, 404, { error: "Объявление номера не найдено" });
    player.plateInventory.push(plateMarket.splice(lotIndex, 1)[0].plate);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/car/registration") {
    const car = player.garage.find((item) => item.id === String(body.carId || ""));
    if (!car) return json(res, 404, { error: "Автомобиль не найден в личном гараже" });
    ensureCarDefaults(car);
    const action = String(body.action || "");
    if (action === "register") {
      if (car.registration.registered) return json(res, 409, { error: "Автомобиль уже стоит на учёте" });
      if (car.legalHold) return json(res, 409, { error: `Регистрация приостановлена: ${car.legalHold.name}. ${car.legalHold.note} Закройте вопрос в сервисе или подайте претензию продавцу.` });
      const plateIndex = player.plateInventory.findIndex((plate) => plate.id === String(body.plateId || ""));
      if (plateIndex < 0) return json(res, 400, { error: "Для постановки на учёт выберите номер" });
      const cost = balance.fee(8500, levelForXp(player.xp));
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Для постановки на учёт нужно ${cost.toLocaleString("ru-RU")} ₽` });
      const plate = player.plateInventory.splice(plateIndex, 1)[0];
      player.cash -= cost; car.registration.registered = true; car.registration.registeredAt = Date.now(); car.registration.plate = plate;
      car.history.push({ type: "registration", text: `Автомобиль поставлен на учёт с номером ${plate.number}`, at: Date.now() });
      addLedger(player, "registration", `Постановка на учёт: ${car.model}`, -cost, { carId: car.id, category: "Гараж" });
    } else if (action === "deregister") {
      if (!car.registration.registered) return json(res, 409, { error: "Автомобиль уже снят с учёта" });
      const cost = balance.fee(2500, levelForXp(player.xp), 50);
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Для снятия с учёта нужно ${cost.toLocaleString("ru-RU")} ₽` });
      player.cash -= cost; detachPlate(player, car, "При снятии с учёта возвращён номер"); car.registration.registered = false; car.registration.registeredAt = null;
      car.history.push({ type: "registration", text: "Автомобиль снят с регистрационного учёта", at: Date.now() });
      addLedger(player, "registration", `Снятие с учёта: ${car.model}`, -cost, { carId: car.id, category: "Гараж" });
    } else if (action === "attach") {
      if (!car.registration.registered) return json(res, 400, { error: "Сначала поставьте автомобиль на учёт" });
      if (car.registration.plate) return json(res, 409, { error: "На автомобиле уже установлен номер" });
      const plateIndex = player.plateInventory.findIndex((plate) => plate.id === String(body.plateId || ""));
      if (plateIndex < 0) return json(res, 404, { error: "Номер не найден в вашей коллекции" });
      const plate = player.plateInventory.splice(plateIndex, 1)[0]; car.registration.plate = plate;
      car.history.push({ type: "registration", text: `Установлен госномер ${plate.number}`, at: Date.now() });
    } else if (action === "detach") {
      if (!car.registration.plate) return json(res, 409, { error: "На автомобиле нет номера" });
      detachPlate(player, car); car.registration.registered = false; car.registration.registeredAt = null;
    } else return json(res, 400, { error: "Неизвестное регистрационное действие" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/assets/buy") {
    const listing = assetMarket.find((item) => item.id === String(body.assetId || "") && item.stock > 0);
    if (!listing) return json(res, 404, { error: "Лот уже продан" });
    if (listing.price > player.cash - reservedCash(player)) return json(res, 400, { error: "Недостаточно свободных денег" });
    player.cash -= listing.price;
    const acquiredAt = Date.now();
    player.ownedAssets.push({ ...listing, id: id("owned_asset_"), listingId: listing.id, purchasePrice: listing.price, acquiredAt, incomeLastAt: listing.type === "property" ? acquiredAt : undefined, rentalStatus: listing.type === "property" ? "vacant" : undefined, tenant: null, taxLastAt: listing.type === "property" ? acquiredAt : undefined, taxDebt: 0, maintenance: listing.type === "property" ? 100 : undefined, stock: 1 });
    player.stats.assetsBought += 1; listing.stock -= 1; addXp(player, listing.type === "property" ? 70 : 30);
    addLedger(player, "asset-buy", `Покупка актива: ${listing.name}`, -listing.price, { category: listing.type === "property" ? "Недвижимость" : listing.type === "crypto" ? "Криптовалюта" : "Активы" });
    restockAssetMarket(); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/assets/sell") {
    const index = player.ownedAssets.findIndex((item) => item.id === String(body.assetId || ""));
    if (index < 0) return json(res, 404, { error: "Актив не найден" });
    const pendingTax = propertyIncomeState(player.ownedAssets[index], player).taxDue;
    if (pendingTax > 0) return json(res, 400, { error: `Перед продажей оплатите налог: ${pendingTax.toLocaleString("ru-RU")} ₽` });
    const [asset] = player.ownedAssets.splice(index, 1);
    const value = assetResaleValue(asset, player);
    player.cash += value; player.profit += value - asset.purchasePrice; player.stats.assetsSold += 1; addXp(player, asset.type === "property" ? 55 : 24);
    addLedger(player, "asset-sale", `Продажа актива: ${asset.name}`, value, { profit: value - asset.purchasePrice, category: asset.type === "property" ? "Недвижимость" : asset.type === "crypto" ? "Криптовалюта" : "Активы" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/assets/income") {
    const income = assetIncomeAvailable(player);
    if (income < 1) return json(res, 400, { error: "Доход ещё не накопился. Начисление происходит каждую минуту" });
    const now = Date.now();
    for (const asset of player.ownedAssets.filter((item) => item.type === "property")) {
      const incomeState = propertyIncomeState(asset, player, now);
      if (incomeState.cycles > 0) {
        asset.incomeLastAt = (asset.incomeLastAt || asset.acquiredAt || now) + incomeState.cycles * ASSET_INCOME_CYCLE_MS;
        asset.maintenance = Math.max(55, (asset.maintenance || 100) - incomeState.cycles);
      }
      asset.taxDebt = incomeState.taxDue; asset.taxLastAt = now;
    }
    player.cash += income; player.profit += income; player.assetIncomeLastAt = now; addXp(player, 18);
    addLedger(player, "income", "Доход от недвижимости", income, { profit: income, category: "Недвижимость" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/crypto/trade") {
    const quote = assetMarket.find((item) => item.type === "crypto" && item.key === String(body.key || "") && item.stock > 0);
    if (!quote) return json(res, 404, { error: "Криптоактив не найден" });
    const action = String(body.action || ""); const rubles = Math.round(Number(body.rubles));
    if (!Number.isFinite(rubles) || rubles < 100) return json(res, 400, { error: "Минимальная операция 100 ₽" });
    if (action === "buy") {
      const total = Math.round(rubles * 1.012); if (total > player.cash - reservedCash(player)) return json(res, 400, { error: "Недостаточно свободных денег" });
      const quantity = rubles / quote.unitPrice; player.cash -= total;
      const owned = player.ownedAssets.find((item) => item.type === "crypto" && item.key === quote.key);
      if (owned) { owned.quantity += quantity; owned.purchasePrice += total; owned.unitPrice = quote.unitPrice; } else player.ownedAssets.push({ ...quote, id: id("owned_asset_"), quantity, purchasePrice: total, acquiredAt: Date.now(), stock: 1 });
      addLedger(player, "crypto-buy", `Покупка ${quote.symbol}`, -total, { category: "Криптовалюта" });
    } else if (action === "sell") {
      const owned = player.ownedAssets.find((item) => item.type === "crypto" && item.key === quote.key); const quantity = rubles / quote.unitPrice;
      if (!owned || owned.quantity + 1e-9 < quantity) return json(res, 400, { error: "Недостаточно актива для продажи" });
      const proceeds = Math.round(rubles * .988); owned.quantity -= quantity; player.cash += proceeds; player.profit += proceeds - owned.purchasePrice * (quantity / (owned.quantity + quantity)); owned.purchasePrice *= owned.quantity / (owned.quantity + quantity);
      if (owned.quantity < .000001) player.ownedAssets.splice(player.ownedAssets.indexOf(owned), 1); addLedger(player, "crypto-sell", `Продажа ${quote.symbol}`, proceeds, { category: "Криптовалюта" });
    } else return json(res, 400, { error: "Неизвестная операция" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/clothing/list") {
    const index = player.ownedAssets.findIndex((item) => item.id === String(body.assetId || "") && item.category === "clothing"); const price = Math.round(Number(body.price));
    if (index < 0) return json(res, 404, { error: "Вещь не найдена" }); if (!Number.isFinite(price) || price < 100) return json(res, 400, { error: "Минимальная цена 100 ₽" });
    const [item] = player.ownedAssets.splice(index, 1); clothingMarket.push({ id: id("clothing_lot_"), item, price, sellerId: player.id, sellerName: player.name, listedAt: Date.now() }); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/clothing/buy") {
    const lot = clothingMarket.find((item) => item.id === String(body.lotId || "")); if (!lot || lot.sellerId === player.id) return json(res, 404, { error: "Лот недоступен" });
    if (lot.price > player.cash - reservedCash(player)) return json(res, 400, { error: "Недостаточно денег" }); const seller = players.get(lot.sellerId);
    player.cash -= lot.price; player.ownedAssets.push({ ...lot.item, id: id("owned_asset_"), purchasePrice: lot.price, acquiredAt: Date.now() }); if (seller) { seller.cash += Math.round(lot.price * .95); addLedger(seller, "clothing-sale", `Продажа: ${lot.item.name}`, Math.round(lot.price * .95), { category: "Одежда" }); }
    clothingMarket.splice(clothingMarket.indexOf(lot), 1); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/clothing/unlist") {
    const lot = clothingMarket.find((item) => item.id === String(body.lotId || "") && item.sellerId === player.id); if (!lot) return json(res, 404, { error: "Ваш лот не найден" });
    player.ownedAssets.push(lot.item); clothingMarket.splice(clothingMarket.indexOf(lot), 1); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/item-container/bid") {
    const box = itemContainerAuctions.find((item) => item.id === String(body.containerId || "") && item.endAt > Date.now()); const amount = Math.round(Number(body.amount));
    if (!box) return json(res, 404, { error: "Контейнер недоступен" }); const minimum = box.highestBid ? box.highestBid + Math.max(100, Math.ceil(box.highestBid * .03 / 100) * 100) : box.startingPrice;
    if (!Number.isFinite(amount) || amount < minimum) return json(res, 400, { error: `Минимальная ставка ${minimum.toLocaleString("ru-RU")} ₽` }); if (amount > player.cash - reservedCash(player) + (box.highestBidderId === player.id ? box.highestBid : 0)) return json(res, 400, { error: "Недостаточно свободных денег" });
    box.highestBid = amount; box.highestBidderId = player.id; box.highestBidderName = player.name; box.bidCount += 1; if (!box.participantIds.includes(player.id)) box.participantIds.push(player.id); broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/property/manage") {
    const asset = player.ownedAssets.find((item) => item.id === String(body.assetId || "") && item.type === "property");
    if (!asset) return json(res, 404, { error: "Объект недвижимости не найден" });
    const action = String(body.action || "");
    const incomeState = propertyIncomeState(asset, player);
    if (action === "upgrade") {
      if (!asset.propertyRole || (asset.workplaceLevel || 0) >= 3) return json(res, 400, { error: "Улучшения недоступны" });
      const cost = incomeState.upgradeCost;
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег на улучшение" });
      player.cash += incomeState.amount - cost;
      asset.incomeLastAt = Date.now();
      asset.workplaceLevel = (asset.workplaceLevel || 0) + 1;
      asset.upgradeInvestment = (asset.upgradeInvestment || 0) + cost;
      addLedger(player, "property", `Улучшение: ${asset.name}`, incomeState.amount - cost, { category: "Недвижимость" });
    } else if (action === "workplace") {
      if (!asset.propertyRole || asset.rentalStatus === "workplace") return json(res, 400, { error: "Рабочее место недоступно" });
      player.cash += incomeState.amount;
      asset.incomeLastAt = Date.now(); asset.rentalStatus = "workplace"; asset.tenant = null;
      addLedger(player, "property", `Открыто рабочее место: ${asset.name}`, incomeState.amount, { category: "Недвижимость" });
    } else if (action === "rent") {
      if (asset.rentalStatus === "rented") return json(res, 400, { error: "Объект уже сдан" });
      const fee = Math.max(5000, Math.round((asset.income || 0) * 0.35 / 1000) * 1000);
      if (player.cash - reservedCash(player) < fee) return json(res, 400, { error: `Нужно ${fee.toLocaleString("ru-RU")} ₽ на поиск арендатора` });
      player.cash -= fee; asset.rentalStatus = "rented"; asset.tenant = ["Семья Орловых", "Студия Север", "ООО Вектор", "ИП Соколов", "Компания Маяк"][randomInt(0, 4)]; asset.incomeLastAt = Date.now();
      addLedger(player, "property", `Заселение: ${asset.name}`, -fee, { category: "Недвижимость" });
    } else if (action === "vacate") {
      player.cash += incomeState.amount;
      if (incomeState.amount) addLedger(player, "property", `Завершение аренды: ${asset.name}`, incomeState.amount, { category: "Недвижимость" });
      asset.rentalStatus = "vacant"; asset.tenant = null; asset.incomeLastAt = Date.now();
    } else if (action === "tax") {
      if (incomeState.taxDue < 1) return json(res, 400, { error: "Налог пока не начислен" });
      if (player.cash - reservedCash(player) < incomeState.taxDue) return json(res, 400, { error: "Недостаточно денег для уплаты налога" });
      player.cash -= incomeState.taxDue; asset.taxDebt = 0; asset.taxLastAt = Date.now();
      addLedger(player, "tax", `Налог: ${asset.name}`, -incomeState.taxDue, { category: "Недвижимость" });
    } else if (action === "maintain") {
      if ((asset.maintenance ?? 100) >= 100) return json(res, 400, { error: "Объект уже в отличном состоянии" });
      const cost = Math.max(10000, Math.round((asset.fairValue || asset.purchasePrice) * 0.004 / 1000) * 1000);
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег на обслуживание" });
      player.cash += incomeState.amount - cost; asset.incomeLastAt = Date.now(); asset.maintenance = 100; addLedger(player, "maintenance", `Обслуживание: ${asset.name}`, incomeState.amount - cost, { category: "Недвижимость" });
    } else return json(res, 400, { error: "Неизвестное действие с недвижимостью" });
    broadcast(); persistState(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/business/buy") {
    const template = businessCatalog.find((item) => item.key === String(body.key || ""));
    if (!template) return json(res, 404, { error: "Бизнес не найден" });
    if (player.businesses.some((item) => item.key === template.key)) return json(res, 400, { error: "Такой бизнес уже принадлежит вам" });
    if (player.cash - reservedCash(player) < template.price) return json(res, 400, { error: "Недостаточно свободных денег" });
    player.cash -= template.price; player.businesses.push({ ...template, id: id("business_"), acquiredAt: Date.now(), lastCollectedAt: Date.now(), level: 1, staff: 1, reputation: 50, invested: template.price });
    addLedger(player, "business-buy", `Покупка бизнеса: ${template.name}`, -template.price, { category: "Бизнес" }); addXp(player, 90);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/business/manage") {
    const business = player.businesses.find((item) => item.id === String(body.businessId || ""));
    if (!business) return json(res, 404, { error: "Бизнес не найден" });
    const action = String(body.action || "");
    if (action === "collect") {
      const current = businessState(business);
      if (current.amount < 1) return json(res, 400, { error: "Прибыль ещё не накопилась" });
      player.cash += current.amount; player.profit += current.amount; business.lastCollectedAt += current.cycles * ASSET_INCOME_CYCLE_MS; business.reputation = Math.min(100, business.reputation + 1);
      addLedger(player, "business-income", `Прибыль: ${business.name}`, current.amount, { profit: current.amount, category: "Бизнес" });
    } else if (action === "hire") {
      const cost = 85000 * business.staff;
      if (business.staff >= 6) return json(res, 400, { error: "Штат полностью укомплектован" });
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег для найма" });
      player.cash -= cost; business.staff += 1; business.invested += cost; addLedger(player, "business-hire", `Найм: ${business.name}`, -cost, { category: "Бизнес" });
    } else if (action === "upgrade") {
      const cost = Math.round(business.price * (0.22 + business.level * 0.08) / 1000) * 1000;
      if (business.level >= 5) return json(res, 400, { error: "Достигнут максимальный уровень" });
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег для улучшения" });
      player.cash -= cost; business.level += 1; business.invested += cost; business.reputation = Math.min(100, business.reputation + 5); addLedger(player, "business-upgrade", `Развитие: ${business.name}`, -cost, { category: "Бизнес" });
    } else return json(res, 400, { error: "Неизвестное действие с бизнесом" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/clothing/craft") {
    if (clothingCrafts.has(player.id)) return json(res, 400, { error: "В мастерской уже готовится вещь" });
    const cost = 1200;
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Нужно 1 200 ₽ на материалы" });
    const durationMs = 30000 + randomInt(0, 90000);
    const craft = { playerId: player.id, startedAt: Date.now(), finishAt: Date.now() + durationMs, cost };
    player.cash -= cost; clothingCrafts.set(player.id, craft); addLedger(player, "craft", "Материалы для пошива вещи", -cost, { category: "Одежда" });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/clothing/claim") {
    const craft = clothingCrafts.get(player.id);
    if (!craft) return json(res, 404, { error: "В мастерской нет готового заказа" });
    if (craft.finishAt > Date.now()) return json(res, 400, { error: `Вещь будет готова через ${Math.ceil((craft.finishAt - Date.now()) / 1000)} сек.` });
    const rarityRoll = Math.random() * 100;
    const rarity = rarityRoll < 52 ? "common" : rarityRoll < 80 ? "uncommon" : rarityRoll < 94 ? "rare" : rarityRoll < 99 ? "epic" : "legendary";
    const pool = clothingCatalog.filter((item) => item.rarity === rarity);
    const template = pool[Math.floor(Math.random() * Math.max(1, pool.length))] || clothingCatalog[0];
    const asset = { ...template, type: "item", category: "clothing", id: id("owned_asset_"), purchasePrice: craft.cost, acquiredAt: Date.now(), condition: 100, fairValue: template.value, basePrice: template.value, stock: 1, seller: "Мастерская" };
    player.ownedAssets.push(asset); player.stats.assetsBought += 1; addXp(player, template.rarity === "legendary" ? 100 : 30); clothingCrafts.delete(player.id); addLedger(player, "craft-reward", `Сшита вещь: ${template.name}`, 0, { category: "Одежда", rarity: template.rarity });
    broadcast(); return json(res, 200, { ...snapshot(player), clothingReward: { ...template, rarityName: clothingRarityNames[template.rarity] } });
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
    const car = player.garage[index]; ensureCarDefaults(car); detachPlate(player, car, "Перед передачей команде снят номер"); car.registration.registered = false; car.registration.registeredAt = null;
    player.garage.splice(index, 1); car.groupContributorId = player.id; car.groupContributorName = player.name;
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
    group.treasury -= candidate.hireCost; group.employees.push({ ...candidate, hiredAt: Date.now(), employerId: player.id, energy: 100, experience: 0, jobsCompleted: 0, busyJobId: null });
    group.log.push({ at: Date.now(), text: `${player.name} нанял: ${candidate.name}, ${candidate.title}` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/job/start") {
    const group = player.groupId && groups.get(player.groupId);
    if (!group || !groupCan(player, "business")) return json(res, 403, { error: "Запускать заказы может владелец или управляющий" });
    ensureGroupDefaults(group);
    const employee = group.employees.find((item) => item.id === body.employeeId);
    const job = groupJobCatalog[String(body.jobKey || "")];
    if (!employee || !job) return json(res, 404, { error: "Сотрудник или заказ не найден" });
    if (employee.specialty !== job.specialty) return json(res, 400, { error: "Специализация сотрудника не подходит для этого заказа" });
    if (employee.busyJobId) return json(res, 400, { error: "Сотрудник уже выполняет заказ" });
    const jobSlots = Math.min(3, 1 + Math.floor((group.businessLevel - 1) / 2));
    if (group.activeJobs.length >= jobSlots) return json(res, 400, { error: `Все рабочие места заняты: ${jobSlots}/${jobSlots}` });
    if (employee.energy < job.energy) return json(res, 400, { error: "Сотруднику нужен отдых" });
    const operatingCost = job.cost + employee.salary;
    if (group.treasury < operatingCost) return json(res, 400, { error: `В общей кассе нужно ${operatingCost.toLocaleString("ru-RU")} ₽` });
    const durationMs = Math.max(1000, Math.round(job.durationSeconds * 1000 * GROUP_JOB_TIME_SCALE));
    const activeJob = { id: id("job_"), jobKey: job.key, employeeId: employee.id, employeeName: employee.name, name: job.name, startedBy: player.name, startedAt: Date.now(), finishAt: Date.now() + durationMs, operatingCost };
    group.treasury -= operatingCost;
    employee.energy = Math.max(0, employee.energy - job.energy);
    employee.busyJobId = activeJob.id;
    group.activeJobs.push(activeJob);
    group.log.push({ at: Date.now(), text: `${player.name} назначил ${employee.name} на заказ «${job.name}»` });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/group/employee/restore") {
    const group = player.groupId && groups.get(player.groupId);
    if (!group || !groupCan(player, "business")) return json(res, 403, { error: "Управлять персоналом может владелец или управляющий" });
    ensureGroupDefaults(group);
    const employee = group.employees.find((item) => item.id === body.employeeId);
    if (!employee) return json(res, 404, { error: "Сотрудник не найден" });
    if (employee.busyJobId) return json(res, 400, { error: "Нельзя отправить на отдых во время заказа" });
    if (employee.energy >= 100) return json(res, 400, { error: "Сотрудник уже полностью восстановлен" });
    const cost = 12000;
    if (group.treasury < cost) return json(res, 400, { error: `В общей кассе нужно ${cost.toLocaleString("ru-RU")} ₽` });
    group.treasury -= cost; employee.energy = 100;
    group.log.push({ at: Date.now(), text: `${player.name} оплатил отдых для ${employee.name}` });
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
    player.cash -= lot.price; lot.item.purchasePrice = lot.price; lot.item.source = `Биржа · ${lot.seller}`; player.partInventory.push(lot.item); player.parts[lot.type] += 1; player.stats.partsBought += 1;
    addLedger(player, "part", `Покупка детали: ${lot.item.name}`, -lot.price, { category: "Запчасти" });
    const seller = lot.sellerId && players.get(lot.sellerId);
    if (seller) seller.cash += Math.round(lot.price * 0.95);
    partsSalesHistory.push({ component: lot.item.component, model: lot.item.compatibleModel, price: lot.price, buyer: player.name, at: Date.now() });
    partsMarket.splice(partsMarket.indexOf(lot), 1);
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/parts/list") {
    const index = player.partInventory.findIndex((part) => part.id === body.inventoryPartId); const price = Math.round(Number(body.price));
    if (index < 0) return json(res, 404, { error: "Деталь не найдена на складе" });
    if (!Number.isFinite(price) || price < 1 || price > 20000000) return json(res, 400, { error: "Цена детали должна быть от 1 ₽ до 20 000 000 ₽" });
    const part = player.partInventory.splice(index, 1)[0];
    player.parts[partStockType(part)] = Math.max(0, player.parts[partStockType(part)] - 1);
    publishPartLot(part, part.conditionPct < 100 ? "used" : "new", price, player.name, player.id);
    player.stats.partsSold += 1;
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/car/dismantle") {
    const index = player.garage.findIndex((car) => car.id === body.carId);
    if (index < 0) return json(res, 404, { error: "Машина не найдена в гараже" });
    const car = player.garage[index]; const payout = partsValue(car); detachPlate(player, car, "Перед разбором снят номер");
    const donorDefects = [...car.defects.filter((defect) => partSpecForDefect(defect)), ...defectCatalog.filter((defect) => partSpecForDefect(defect))]
      .filter((defect, position, list) => list.findIndex((item) => partSpecForDefect(item).sku === partSpecForDefect(defect).sku) === position)
      .sort(() => Math.random() - 0.5).slice(0, Math.max(3, Math.min(6, car.defects.length + 2)));
    const salvaged = donorDefects.map((defect) => makeSpecificPart(car, defect, "restored", randomInt(38, Math.max(45, car.condition)), `Разбор ${car.model}`));
    player.garage.splice(index, 1); player.cash += Math.round(payout * 0.38); player.parts.common += salvaged.length; player.partInventory.push(...salvaged);
    car.history.push({ type: "dismantled", text: `Разобрана на запчасти: ${Math.round(payout * 0.38).toLocaleString("ru-RU")} ₽ и ${salvaged.length} деталей`, at: Date.now() });
    broadcast(); return json(res, 200, snapshot(player));
  }
  if (req.method === "POST" && pathname === "/api/buy") {
    const car = market.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Лот уже продан или снят с рынка. Обновите список автомобилей." });
    if (listingBlockReason(car)) return json(res, 409, { error: listingBlockReason(car) });
    if (car.sellerId === player.id) return json(res, 400, { error: "Это ваше объявление" });
    if (car.saleType === "auction") return json(res, 400, { error: "Эту машину можно купить только через ставку" });
    if (!canAccessCar(player, car)) return json(res, 403, { error: carUnlockMessage(player, car) });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: `Гараж заполнен: ${player.garage.length}/${player.garageCapacity}. Продайте или разберите автомобиль.` });
    if (player.cash - reservedCash(player) < car.price) return json(res, 400, { error: `Не хватает свободных денег: нужно ${car.price.toLocaleString("ru-RU")} ₽, доступно ${(player.cash - reservedCash(player)).toLocaleString("ru-RU")} ₽.` });
    if (!completeSale(car, player, car.price)) return json(res, 409, { error: "Лот только что купил другой игрок. Обновите рынок." });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  // ── Банк: кредиты, погашение ────────────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/bank/loan") {
    try { createBankLoan(player, body.productKey, body.amount); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    broadcast(); persistState();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/bank/repay") {
    try { repayBankLoan(player, body.loanId, body.amount, body.full === true); }
    catch (error) { return json(res, error.status || 400, { error: error.message }); }
    broadcast(); persistState();
    return json(res, 200, snapshot(player));
  }

  // ── Мошенничество: защита покупателя ────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/fraud/check") {
    const car = market.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Автомобиль недоступен: лот мог уйти с рынка" });
    if (player.garage.some((item) => item.id === car.id)) return json(res, 400, { error: "Проверка доступна для объявлений на рынке" });
    const cost = fraud.legalCheckCost(car);
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Юридическая проверка стоит ${cost.toLocaleString("ru-RU")} ₽` });
    player.cash -= cost;
    const spec = fraud.fraudSpec(car.fraud?.type);
    const chance = fraud.legalCheckChance({
      appraisal: player.skills.appraisal, terminal: player.equipment.historyTerminal,
      reputation: player.reputation?.score || 50, depth: spec?.depth || 3
    });
    const lucky = Math.random() < chance;
    const revealed = lucky && Boolean(spec);
    if (revealed) {
      revealListingFraud(car, player.id, "legal");
      player.notifications.push({ id: id("notification_"), type: "fraud", title: "Проверка вскрыла обман", text: `${spec.name}. ${spec.hint}`, carId: car.id, createdAt: Date.now(), read: false });
    } else {
      car.fraudCheckedBy ||= {};
      car.fraudCheckedBy[player.id] = { at: Date.now(), revealed: false, source: "legal" };
    }
    addXp(player, revealed ? 26 : 8);
    addLedger(player, "fraud-check", `Юридическая проверка: ${car.model}`, -cost, { carId: car.id, result: revealed ? "found" : "clean", category: "Риск" });
    broadcast(); persistState();
    return json(res, 200, {
      ...snapshot(player),
      fraudCheck: { revealed, carId: car.id, cost, chance: Math.round(chance * 100), fraud: revealed && spec ? { name: spec.name, hint: spec.hint } : null }
    });
  }

  if (req.method === "POST" && pathname === "/api/fraud/expose") {
    const carIndex = market.findIndex((item) => item.id === body.carId);
    if (carIndex < 0) return json(res, 404, { error: "Объявление уже снято с рынка" });
    const car = market[carIndex];
    if (car.sellerId) return json(res, 400, { error: "Жалоба на игрока рассматривает администратор: используйте жалобу в профиле" });
    if (!car.fraud || !car.fraud.revealed) return json(res, 400, { error: "Сначала докажите обман: проверка документов или юридическая экспертиза" });
    ensurePlayerFraud(player);
    if (player.fraud.lastExposeAt > Date.now() - FRAUD_EXPOSE_COOLDOWN_MS) return json(res, 429, { error: "Жалобы оформляются реже: подождите немного" });
    const spec = fraud.fraudSpec(car.fraud.type);
    const reward = fraud.exposeReward(car, levelForXp(player.xp));
    player.fraud.lastExposeAt = Date.now();
    player.fraud.exposed += 1;
    player.fraud.notoriety = Math.max(0, player.fraud.notoriety - 2);
    player.cash += reward.cash;
    player.reputation.score = Math.min(100, player.reputation.score + reward.reputation);
    addXp(player, reward.xp);
    car.history.push({ type: "fraud", text: `Объявление снято с рынка по жалобе: ${spec?.name || "мошенничество"}`, at: Date.now() });
    market.splice(carIndex, 1);
    for (const offer of offers.values()) if (offer.carId === car.id && ["active", "counter"].includes(offer.status)) offer.status = "closed";
    restock();
    addLedger(player, "fraud-bounty", `Премия рынка за разоблачение: ${car.model}`, reward.cash, { category: "Риск" });
    pushFraudHistory(player, { kind: "exposed", title: `Разоблачён продавец: ${spec?.name || "мошенник"}`, amount: reward.cash, car: car.model });
    player.notifications.push({ id: id("notification_"), type: "fraud", title: reward.title, text: reward.text, createdAt: Date.now(), read: false });
    broadcast(); persistState();
    return json(res, 200, { ...snapshot(player), fraudResult: { exposed: true, bounty: reward.cash, xp: reward.xp, reputation: reward.reputation, model: car.model } });
  }

  if (req.method === "POST" && pathname === "/api/fraud/claim") {
    const car = player.garage.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    if (!car.fraud?.applied && !car.legalHold) return json(res, 400, { error: "Претензия подаётся, только если после покупки вскрылся обман продавца" });
    if (car.fraudClaimed) return json(res, 409, { error: "Претензия по этой машине уже подана" });
    const fee = Math.max(500, Math.round(fraud.legalCheckCost(car) * 0.6 / 100) * 100);
    if (player.cash - reservedCash(player) < fee) return json(res, 400, { error: `На юриста нужно ${fee.toLocaleString("ru-RU")} ₽` });
    player.cash -= fee;
    const evidence = Boolean(car.serviceDiagnosed || Object.keys(car.publicInspectionRecords || {}).length || (car.defects || []).some((defect) => defect.fraud && car.discovered.includes(defect.code)));
    const chance = fraud.claimChance({ appraisal: player.skills.appraisal, reputation: player.reputation?.score || 50, evidence });
    const success = Math.random() < chance;
    const share = success ? 0.55 + Math.min(0.2, (player.skills.appraisal || 0) * 0.04) : 0.06;
    const payout = fraud.claimPayout(car, share);
    player.cash += payout;
    ensurePlayerFraud(player);
    player.fraud.claims += 1;
    if (success) {
      player.fraud.claimsWon += 1;
      player.reputation.score = Math.min(100, player.reputation.score + 1);
      if (car.legalHold) { car.legalHold = null; const defect = car.defects.find((item) => item.fraud && !item.repaired); if (defect) { defect.repaired = true; defect.repairQuality = "Юридическое сопровождение"; defect.repairReliability = 95; car.repairs.push(defect.name); car.condition = Math.min(100, car.condition + 4); } }
    }
    car.fraudClaimed = true;
    car.history.push({ type: "fraud", text: success ? `Претензия удовлетворена: вернули ${payout.toLocaleString("ru-RU")} ₽` : `Претензия отклонена: компенсация ${payout.toLocaleString("ru-RU")} ₽`, at: Date.now() });
    addXp(player, success ? 34 : 14);
    addLedger(player, "fraud-claim", `Претензия продавцу: ${car.model}`, payout - fee, { payout, fee, success, category: "Риск" });
    pushFraudHistory(player, { kind: "claim", title: success ? "Претензию выиграли" : "Претензию отклонили", amount: payout - fee, car: car.model });
    player.notifications.push({ id: id("notification_"), type: "fraud", title: success ? "Деньги вернули" : "Отказ", text: success ? `Продавец вернул ${payout.toLocaleString("ru-RU")} ₽, юридическая проблема закрыта.` : `Удалось выбить только ${payout.toLocaleString("ru-RU")} ₽. Соберите больше доказательств: осмотр документов и диагностика сервиса повышают шансы.`, carId: car.id, createdAt: Date.now(), read: false });
    broadcast(); persistState();
    return json(res, 200, { ...snapshot(player), fraudResult: { recovered: success, amount: payout, fee, model: car.model } });
  }

  // ── Мошенничество: серые схемы игрока ────────────────────────────────────────
  if (req.method === "POST" && pathname === "/api/fraud/scheme") {
    ensurePlayerFraud(player);
    if (player.fraud.blockedUntil > Date.now()) return json(res, 403, { error: "Пока идёт разбирательство, серые схемы недоступны" });
    // Готовить машину можно и прямо под покупателя: объявление с машины не снимается,
    // иначе «задаток у другого» и «чистая история» были бы недоступны именно там, где они нужны.
    const car = player.garage.find((item) => item.id === body.carId) || market.find((item) => item.id === body.carId && item.sellerId === player.id);
    if (!car) return json(res, 404, { error: "Машины нет в гараже: снимите объявление" });
    const spec = fraud.schemeSpec(body.scheme || body.key);
    if (!spec) return json(res, 400, { error: "Такой схемы не существует" });
    const level = levelForXp(player.xp);
    if (level < spec.requires.level) return json(res, 403, { error: `Схема «${spec.name}» откроется с ${spec.requires.level} уровня` });
    if (player.fraud.notoriety < spec.requires.notoriety) return json(res, 403, { error: `Нужен криминальный авторитет ${spec.requires.notoriety}: текущий ${Math.round(player.fraud.notoriety)}` });
    if (spec.skill && (player.skills[spec.skill.key] || 0) < spec.skill.level) return json(res, 400, { error: `Нужен навык «${skillInfo[spec.skill.key].name}» ${spec.skill.level} уровня` });
    if ((car.schemes || []).some((item) => (item.key || item) === spec.key)) return json(res, 409, { error: "Эту схему уже применили к автомобилю" });
    if (player.fraud.lastSchemeAt > Date.now() - FRAUD_SCHEME_COOLDOWN_MS) return json(res, 429, { error: "Рынок заметит слишком частые «улучшения»: подождите" });
    const cost = fraud.schemeCost(car, spec);
    if (spec.needsOpenDefects && !car.defects.some((defect) => !defect.repaired)) return json(res, 400, { error: "Прятать нечего: сначала найдите неисправность" });
    if (spec.needsPlayerOffer) {
      const target = [...offers.values()].filter((offer) => offer.carId && market.some((item) => item.id === offer.carId && item.sellerId === player.id) && ["active", "counter"].includes(offer.status)).sort((a, b) => b.amount - a.amount)[0];
      if (!target) return json(res, 400, { error: "Нужно живое предложение по вашей машине: сначала выставьте объявление" });
      const deposit = Math.max(1000, Math.round(target.amount * spec.depositShare / 100) * 100);
      player.cash += deposit;
      target.status = "closed";
      target.reason = "Продавец взял задаток у другого покупателя и пропал";
      const victim = players.get(target.buyerId);
      if (victim && target.buyerType === "player") {
        victim.cash += deposit;
        victim.reputation.score = Math.min(100, victim.reputation.score + 1);
        victim.notifications.push({ id: id("notification_"), type: "fraud", title: "Рынок вернул ваш задаток", text: `Сделка с «${car.model}» сорвалась по вине продавца, предоплату компенсировали: +${deposit.toLocaleString("ru-RU")} ₽.`, createdAt: Date.now(), read: false });
      }
      car.scamDeposit = deposit;
    } else if (player.cash - reservedCash(player) < cost) {
      return json(res, 400, { error: `На подготовку нужно ${cost.toLocaleString("ru-RU")} ₽` });
    } else {
      player.cash -= cost;
    }
    if (spec.key === "odometer") {
      car.fraudCover = { originalMileage: car.mileage, at: Date.now() };
      car.mileage = Math.max(1000, Math.round(car.mileage * 0.4 / 1000) * 1000);
    }
    if (spec.key === "cleanHistory") {
      car.publicInspectionRecords = {};
      car.publicDiscovered = [];
      car.serviceDiagnosed = true;
    }
    if (spec.key === "fakeDocs") {
      car.legalHold = null;
      for (const defect of car.defects.filter((item) => item.fraud && !item.repaired)) {
        defect.repaired = true; defect.repairQuality = "Дубликат ПТС"; defect.repairReliability = 42;
        car.repairs.push(defect.name);
      }
    }
    car.schemes = [...(car.schemes || []), { key: spec.key, at: Date.now(), name: spec.name, bonus: spec.priceBonus }];
    player.fraud.schemes += 1;
    player.fraud.lastSchemeAt = Date.now();
    player.fraud.notoriety += Math.round(spec.notoriety * 0.6);
    addSuspicion(player, spec.suspicion);
    car.history.push({ type: "fraud", text: `Подготовка: ${spec.name}. Покупатель увидит ${spec.key === "odometer" ? `пробег ${car.mileage.toLocaleString("ru-RU")} км` : "лучшую машину, чем есть на самом деле"}. ${spec.exposure}`, at: Date.now() });
    addLedger(player, "fraud-scheme", `Серая схема: ${spec.name}`, -cost, { carId: car.id, risk: Math.round(spec.risk * 100), category: "Риск" });
    pushFraudHistory(player, { kind: "scheme", title: `Подготовили машину: ${spec.name}`, amount: -cost, car: car.model, text: spec.exposure });
    addXp(player, 12);
    broadcast(); persistState();
    return json(res, 200, { ...snapshot(player), fraudResult: { scheme: spec.key, cost, mileage: spec.key === "odometer" ? car.mileage : null, suspicion: Math.round(player.fraud.suspicion), notoriety: Math.round(player.fraud.notoriety) } });
  }

  if (req.method === "POST" && pathname === "/api/fraud/lawyer") {
    ensurePlayerFraud(player);
    const cost = fraud.lawyerCost(playerNetWorth(player));
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Услуги адвоката стоят ${cost.toLocaleString("ru-RU")} ₽` });
    if (player.fraud.suspicion <= 0) return json(res, 400, { error: "Дело не открыто — адвокат не нужен" });
    player.cash -= cost;
    player.fraud.suspicion = Math.max(0, player.fraud.suspicion - fraud.lawyerRelief());
    player.fraud.suspicionAt = Date.now();
    addLedger(player, "fraud-lawyer", "Договорной адвокат: дело замято", -cost, { category: "Риск" });
    pushFraudHistory(player, { kind: "lawyer", title: "Адвокат снизил подозрение", amount: -cost });
    player.notifications.push({ id: id("notification_"), type: "fraud", title: "Дело притихло", text: `Подозрение снижено до ${Math.round(player.fraud.suspicion)}.`, createdAt: Date.now(), read: false });
    broadcast(); persistState();
    return json(res, 200, { ...snapshot(player), fraudResult: { cost, suspicion: Math.round(player.fraud.suspicion) } });
  }

  if (req.method === "POST" && pathname === "/api/inspection/start") {
    const car = [...player.garage, ...market].find(item => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Автомобиль недоступен" });
    if (!Object.hasOwn(inspectionRequirements, body.category) || !Object.hasOwn(inspectionMethods, body.method)) return json(res, 400, { error: "Неизвестный осмотр" });
    const challenge = createInspection(body.category);
    const session = { id: crypto.randomUUID(), carId: car.id, category: body.category, method: body.method, challenge, expires: Date.now() + 300000 };
    for (const [key, value] of inspectionSessions) if (value.expires < Date.now()) inspectionSessions.delete(key);
    inspectionSessions.set(player.id, session);
    return json(res, 200, { challengeId: session.id, ...challenge, rounds: challenge.rounds.map(({ answer, ...round }) => round) });
  }

  if (req.method === "POST" && pathname === "/api/check") {
    const car = player.garage.find((item) => item.id === body.carId);
    const category = String(body.category || "");
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    if (!Object.hasOwn(inspectionRequirements, category)) return json(res, 400, { error: "Неизвестная система автомобиля" });
    ensureCarDefaults(car);
    if (car.serviceDiagnosed) return json(res, 400, { error: "Сервис уже выдал полное заключение" });
    const requirement = inspectionRequirements[category];
    const method = body.method || "visual";
    if (!Object.hasOwn(inspectionMethods, method)) return json(res, 400, { error: "Неизвестный метод осмотра" });
    const quote = inspectionQuote(method, player.skills[requirement.skill], player.equipment[requirement.equipment], balance.inspectionScale(car));
    const baseScore = quote.depth;
    let result;
    try { result = inspectionResult(player, car, category, body, quote); } catch (error) { return json(res, 400, { error: error.message }); }
    const score = result.depth;
    const interactionScore = result.accuracy;
    const previous = car.inspectionRecords[category];
    if (previous && score <= previous.bestScore) return json(res, 400, { error: "Новых данных нет. Попробуйте более точный осмотр; деньги не списаны" });
    const cost = inspectionCosts(car)[method];
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Не хватает денег на расходники" });
    player.cash -= cost;
    player.stats.inspections += 1;
    if (cost) car.invested += cost;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.discovered.includes(defect.code));
    for (const defect of found) if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
    const confidence = Math.min(100, Math.round(score / 6 * 100));
    car.inspectionRecords[category] = { bestScore: score, attempts: (previous?.attempts || 0) + 1, confidence, foundCodes: found.map((defect) => defect.code), interactionScore };
    car.checkedCategories = Object.keys(car.inspectionRecords);
    if (interactionScore === 100) player.stats.perfectInspections += 1;
    addXp(player, 20 + newFound.length * 15 + (interactionScore >= 80 ? 8 : 0));
    if (cost) addLedger(player, "inspection", `Осмотр: ${car.model} · ${category}`, -cost, { carId: car.id, score: interactionScore, category: "Гараж" });
    broadcast();
    persistState();
    return json(res, 200, { ...snapshot(player), checkResult: { category, cost, found: newFound.map((defect) => publicDefect(defect, car)), confidence, accuracy: interactionScore, improvedFrom: previous?.bestScore || 0, canImprove: score < 8 } });
  }

  if (req.method === "POST" && pathname === "/api/market-check") {
    const car = market.find((item) => item.id === body.carId);
    const category = String(body.category || "");
    if (!car) return json(res, 404, { error: "Автомобиль уже ушёл с рынка" });
    if (!Object.hasOwn(inspectionRequirements, category)) return json(res, 400, { error: "Неизвестная система автомобиля" });
    ensureCarDefaults(car);
    const requirement = inspectionRequirements[category];
    const method = body.method || "visual";
    if (!Object.hasOwn(inspectionMethods, method)) return json(res, 400, { error: "Неизвестный метод осмотра" });
    const quote = inspectionQuote(method, player.skills[requirement.skill], player.equipment[requirement.equipment], balance.inspectionScale(car));
    const baseScore = quote.depth;
    let result;
    try { result = inspectionResult(player, car, category, body, quote); } catch (error) { return json(res, 400, { error: error.message }); }
    const score = result.depth;
    const interactionScore = result.accuracy;
    const previous = car.publicInspectionRecords[category];
    if (previous && score <= previous.bestScore) return json(res, 400, { error: "Новых данных нет; деньги не списаны. Выберите более точный осмотр" });
    const cost = inspectionCosts(car)[method];
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно средств на осмотр" });
    player.cash -= cost;
    player.stats.inspections += 1;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.publicDiscovered.includes(defect.code));
    for (const defect of found) if (!car.publicDiscovered.includes(defect.code)) car.publicDiscovered.push(defect.code);
    car.buyerFindings ||= {};
    car.buyerFindings[player.id] = [...new Set([...(car.buyerFindings[player.id] || []), ...found.map(defect => defect.code)])];
    for (const defect of found) if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
    if (found.length) for (const offer of offers.values()) if (offer.carId === car.id && offer.buyerType === 'bot') offer.status = 'rejected';
    const confidence = Math.min(100, Math.round(score / 6 * 100));
    car.publicInspectionRecords[category] = { bestScore: score, confidence, inspector: player.name, at: Date.now(), interactionScore };
    const fraudRevealed = revealsFraudIn(car, { category, score }) && revealListingFraud(car, player.id, "inspection");
    if (fraudRevealed) {
      const spec = fraud.fraudSpec(car.fraud?.type);
      player.notifications.push({ id: id("notification_"), type: "fraud", title: "В объявлении нашли обман", text: `${spec?.name}. ${spec?.hint} Продажа лота остановлена: оформите жалобу и получите премию рынка.`, carId: car.id, createdAt: Date.now(), read: false });
    }
    if (interactionScore === 100) player.stats.perfectInspections += 1;
    addXp(player, 12 + newFound.length * 10 + (interactionScore >= 80 ? 6 : 0) + (fraudRevealed ? 30 : 0));
    if (cost) addLedger(player, "inspection", `Предпродажный осмотр: ${car.model}`, -cost, { carId: car.id, score: interactionScore, category: "Рынок" });
    broadcast();
    persistState();
    return json(res, 200, { ...snapshot(player), checkResult: { category, found: newFound.map((defect) => publicDefect(defect, car)), confidence, accuracy: interactionScore } });
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
    addLedger(player, "diagnostic", `Полная диагностика: ${car.model}`, -cost, { carId: car.id, category: "Гараж" });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/repair") {
    const car = player.garage.find((item) => item.id === body.carId);
    if (!car) return json(res, 404, { error: "Машины нет в гараже" });
    const defect = car.defects.find((item) => item.code === body.defect && !item.repaired && car.discovered.includes(item.code));
    if (!defect) return json(res, 404, { error: "Сначала обнаружьте эту неисправность" });
    const requirements = publicDefect(defect, car);
    const plan = body.plan || "standard";
    if (!Object.hasOwn(repairPlans, plan)) return json(res, 400, { error: "Неизвестный план ремонта" });
    const selfRepair = body.mode === "self";
    const assistedRepair = body.mode === "assisted";
    const serviceRepair = !selfRepair && !assistedRepair;
    const analogOffer = requirements.partRequired ? partOffer(car, defect, "analog") : null;
    const serviceLabor = requirements.partRequired ? Math.max(500, defect.repair - analogOffer.retailPrice) : defect.repair;
    let repairCost = serviceLabor;
    if (selfRepair || assistedRepair) {
      if (!requirements.selfRepairable) return json(res, 400, { error: "Эту проблему нельзя законно устранить самостоятельно" });
      if (selfRepair && player.skills[requirements.repairSkill] < requirements.repairSkillLevel) return json(res, 400, { error: `Нужна профессия «${skillInfo[requirements.repairSkill].name}» уровня ${requirements.repairSkillLevel}` });
      if (selfRepair && player.equipment[requirements.repairEquipment] < requirements.repairEquipmentLevel) return json(res, 400, { error: `Нужен комплект «${equipmentInfo[requirements.repairEquipment].name}» уровня ${requirements.repairEquipmentLevel}` });
      repairCost = selfRepair ? requirements.selfRepairCost : requirements.assistedRepairCost;
    }
    const benefits = workplaceBenefits(player);
    const mechanicDiscount = Math.min(.3, benefits.repair + (player.skills.mechanics || 0) * .02);
    let installedPart = null;
    if (body.partId && !body.plan) {
      const partIndex = player.partInventory.findIndex((part) => part.id === body.partId);
      if (partIndex < 0) return json(res, 404, { error: "Выбранная деталь не найдена на складе" });
      const part = player.partInventory[partIndex];
      if (part.partKey !== requirements.partKey) return json(res, 400, { error: `Для ремонта нужна деталь «${requirements.partName}»` });
      if (part.compatibleModel !== car.model) return json(res, 400, { error: `Деталь предназначена для модели ${part.compatibleModel}` });
      installedPart = player.partInventory[partIndex];
    }
    if (requirements.partRequired && !installedPart && !serviceRepair) return json(res, 400, { error: `Для ремонта сначала купите «${requirements.partName}» для ${car.model}` });
    let suppliedPartCost = 0;
    if (requirements.partRequired && !installedPart && serviceRepair) {
      installedPart = makeSpecificPart(car, defect, repairPlans[plan].quality, 100, "Поставлено сервисом");
      suppliedPartCost = Math.max(500, Math.round(installedPart.purchasePrice * 1.12 * (1 - benefits.parts) / 500) * 500);
      installedPart.purchasePrice = suppliedPartCost;
    }
    repairCost = repairQuote({ labor: serviceRepair ? serviceLabor : repairCost, plan, discount: serviceRepair ? mechanicDiscount : 0 }).labor;
    const totalCashCost = repairCost + suppliedPartCost;
    if (player.cash - reservedCash(player) < totalCashCost) return json(res, 400, { error: `На ремонт и детали нужно ${totalCashCost.toLocaleString("ru-RU")} ₽` });
    if (installedPart) {
      const inventoryIndex = player.partInventory.findIndex((part) => part.id === installedPart.id);
      if (inventoryIndex >= 0) {
        player.partInventory.splice(inventoryIndex, 1);
        player.parts[partStockType(installedPart)] = Math.max(0, player.parts[partStockType(installedPart)] - 1);
      }
      installedPart.installedAt = Date.now();
      installedPart.installedForDefect = defect.code;
      installedPart.installationMode = selfRepair ? "self" : assistedRepair ? "assisted" : "workshop";
    }
    const interactionScore = clamp(Math.round(Number(body.interactionScore) || 0), 0, 100);
    player.cash -= totalCashCost;
    car.invested += totalCashCost + (suppliedPartCost ? 0 : installedPart?.purchasePrice || 0);
    defect.repairQuality = repairPlans[plan].name;
    defect.repairReliability = repairReliability(plan, installedPart?.reliability || 100, installedPart?.conditionPct ?? 100);
    defect.repaired = true;
    const partConditionFactor = installedPart ? 0.55 + installedPart.reliability / 200 : 1;
    const interactionBonus = selfRepair && interactionScore >= 85 ? 2 : selfRepair && interactionScore >= 65 ? 1 : 0;
    car.condition = Math.min(100, car.condition + Math.max(1, Math.round(defect.severity * 4 * partConditionFactor)) + interactionBonus);
    car.repairs.push(defect.name);
    if (installedPart) car.installedParts.push(installedPart);
    car.history.push({ type: "repair", text: `Ремонт: ${defect.name}${installedPart ? ` · ${installedPart.brand} ${installedPart.name}, ресурс ${installedPart.conditionPct}%, надёжность ${installedPart.reliability}%` : ""}`, at: Date.now() });
    if (defect.fraud) {
      car.legalHold = null;
      player.reputation.score = Math.min(100, player.reputation.score + 1);
      player.notifications.push({ id: id("notification_"), type: "fraud", title: "Юридический вопрос закрыт", text: `Документы на ${car.model} приведены в порядок: продажу и регистрацию это больше не блокирует.`, carId: car.id, createdAt: Date.now(), read: false });
    }
    if (selfRepair) player.stats.selfRepairs += 1;
    else if (assistedRepair) player.stats.assistedRepairs += 1;
    else player.stats.workshopRepairs += 1;
    addXp(player, (selfRepair ? 60 : assistedRepair ? 40 : 25) + defect.severity * 10 + (selfRepair ? Math.round(interactionScore / 10) : 0));
    addLedger(player, "repair", `Ремонт: ${car.model} · ${defect.name}`, -totalCashCost, { carId: car.id, score: selfRepair ? interactionScore : null, category: "Гараж" });
    useWorkplace(player, ["workshop", "parts"]);
    // Repairs mutate nested part history; persist before responding so a restart cannot lose the installed component.
    persistState();
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/skill/reset") {
    const total = Object.keys(skillInfo).reduce((sum, key) => sum + player.skills[key], 0);
    const cost = Math.max(10000, total * 5000);
    if (!total) return json(res, 400, { error: "Распределённых очков нет" });
    if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег для смены специализации" });
    player.cash -= cost; player.skillPoints += total;
    for (const key of Object.keys(player.skills)) player.skills[key] = 0;
    addLedger(player, "skills", "Смена специализации", -cost, { category: "Развитие" });
    broadcast(); persistState(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/skill") {
    const skill = String(body.skill || "");
    if (!skillInfo[skill]) return json(res, 400, { error: "Навык не найден" });
    if (player.skillPoints < 1) return json(res, 400, { error: "Нет свободных очков навыков" });
    if (player.skills[skill] >= skillInfo[skill].maxLevel) return json(res, 400, { error: "Профессия уже максимального уровня" });
    const parent = prerequisites[skill];
    if (parent && player.skills[parent] < requiredSkillLevel(player.skills[skill])) return json(res, 400, { error: `Сначала повысьте навык «${skillInfo[parent].name}» до ${requiredSkillLevel(player.skills[skill])}` });
    player.skillPoints -= 1;
    player.skills[skill] += 1;
    broadcast();
    persistState();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/training") {
    const now = Date.now(); const cooldown = 45000;
    if (now - player.training.lastAt < cooldown) return json(res, 429, { error: `Следующее задание будет доступно через ${Math.ceil((cooldown - (now - player.training.lastAt)) / 1000)} сек.` });
    player.training.lastAt = now; player.training.completed += 1;
    player.cash += TRAINING_REWARD_CASH; addXp(player, 75);
    if (player.training.completed % 4 === 0) player.skillPoints += 1;
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/activity") return json(res, 410, { error: "Доска сделок закрыта" });

  if (req.method === "POST" && pathname === "/api/equipment") {
    const equipment = String(body.equipment || "");
    const info = equipmentInfo[equipment];
    if (!info) return json(res, 400, { error: "Оборудование не найдено" });
    const nextLevel = player.equipment[equipment] + 1;
    if (nextLevel > 3) return json(res, 400, { error: "Оборудование уже максимального уровня" });
    const price = nextLevel === 1 ? balance.equipmentPrice(info.prices, levelForXp(player.xp)) : info.prices[nextLevel];
    if (player.cash < price) return json(res, 400, { error: `Нужно ${price.toLocaleString("ru-RU")} ₽ — не хватает ${Math.max(0, price - player.cash).toLocaleString("ru-RU")} ₽` });
    player.cash -= price;
    player.equipment[equipment] = nextLevel;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/garage/expand") {
    const price = balance.garageExpandPrice(player.garageCapacity, levelForXp(player.xp));
    if (player.cash < price) return json(res, 400, { error: `Расширение гаража стоит ${price.toLocaleString("ru-RU")} ₽` });
    player.cash -= price;
    player.garageCapacity += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/parts/buy") {
    const type = body.type === "premium" ? "premium" : "common";
    const model = catalog.some((item) => item.model === body.model) ? body.model : catalog[randomInt(0, catalog.length - 1)].model;
    const price = balance.fee(type === "premium" ? 42000 : 18000, levelForXp(player.xp));
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на комплект деталей" });
    player.cash -= price;
    player.parts[type] += 1; player.stats.partsBought += 1;
    player.partInventory.push(makePart(["engine", "chassis", "body", "electrics", "tires"][randomInt(0, 4)], type === "premium" ? "original" : "analog", 100, "all", model));
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/parts/order") {
    const car = player.garage.find((item) => item.id === body.carId); const defect = car?.defects.find((item) => item.code === body.defect);
    if (!car || !defect || !partSpecForDefect(defect)) return json(res, 404, { error: "Для этой неисправности отдельная деталь не требуется" });
    if (defect.repaired) return json(res, 400, { error: "Неисправность уже устранена" });
    if (!car.discovered.includes(defect.code)) return json(res, 400, { error: "Сначала обнаружьте неисправность" });
    const quality = ["economy", "analog", "original"].includes(body.quality) ? body.quality : "analog";
    const part = makeSpecificPart(car, defect, quality, 100, "Магазин запчастей");
    const price = part.purchasePrice;
    if (player.cash < price) return json(res, 400, { error: "Не хватает денег на заказ детали" });
    player.cash -= price; player.partInventory.push(part); player.parts[partStockType(part)] += 1; player.stats.partsBought += 1;
    addLedger(player, "part", `Заказ детали: ${part.name}`, -price, { carId: car.id, category: "Запчасти" });
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/car/upgrade") {
    const car = player.garage.find((item) => item.id === body.carId);
    const upgrade = upgradeCatalog.find((item) => item.key === body.upgrade);
    if (!car || !upgrade) return json(res, 404, { error: "Автомобиль или улучшение не найдено" });
    ensureCarDefaults(car);
    if (car.upgrades.includes(upgrade.key)) return json(res, 400, { error: "Это улучшение уже установлено" });
    const canSelf = player.skills[upgrade.skill] >= upgrade.skillLevel && player.equipment[upgrade.equipment] >= upgrade.equipmentLevel;
    const scaledCost = upgrade.cost * balance.upgradeScale(car);
    const upgradeCost = Math.max(500, Math.round((canSelf ? scaledCost : scaledCost * 1.55 * (1 - (player.skills.tuning || 0) * .04)) / 100) * 100);
    if (player.cash < upgradeCost) return json(res, 400, { error: "Не хватает денег на улучшение" });
    player.cash -= upgradeCost;
    car.invested += upgradeCost;
    car.upgrades.push(upgrade.key);
    car.upgradeStage = car.upgrades.length;
    car.upgradeValue += Math.max(500, Math.round(upgrade.value * balance.upgradeScale(car) / 100) * 100);
    car.condition = Math.min(100, car.condition + upgrade.condition);
    car.history.push({ type: "upgrade", text: `${upgrade.name}${canSelf ? " самостоятельно" : " в тюнинг-ателье"}: +${upgrade.value.toLocaleString("ru-RU")} ₽ к ценности`, at: Date.now() });
    player.stats.upgrades += 1;
    addXp(player, 55 + upgrade.skillLevel * 15);
    addLedger(player, "upgrade", `Улучшение: ${car.model} · ${upgrade.name}`, -upgradeCost, { carId: car.id, category: "Гараж" });
    broadcast(); persistState(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/list") {
    const index = player.garage.findIndex((item) => item.id === body.carId);
    if (index < 0) return json(res, 404, { error: "Машины нет в гараже" });
    const price = Math.round(Number(body.price));
    if (!Number.isFinite(price) || price < 1 || price > MAX_VEHICLE_VALUE) return json(res, 400, { error: `Цена должна быть от 1 ₽ до ${MAX_VEHICLE_VALUE.toLocaleString("ru-RU")} ₽` });
    const car = player.garage[index];
    const saleType = body.saleType === "auction" ? "auction" : "fixed";
    // Торги раскрывают все найденные дефекты прямо в карточке лота, но блокировать продажу
    // можно только по известным продавцу: иначе «невидимая» неисправность превращает
    // запрет в вечный — игрок не может ни починить то, о чём не знает, ни продать машину.
    const block = saleBlockReason(car);
    if (block) return json(res, 409, { error: block });
    if (saleType === "auction" && levelForXp(player.xp) < AUCTION_UNLOCK_LEVEL) return json(res, 403, { error: `Аукционы откроются с ${AUCTION_UNLOCK_LEVEL} уровня.` });
    const includePlate = body.includePlate === true && Boolean(car.registration?.registered && car.registration?.plate);
    car.plateIncluded = includePlate;
    if (includePlate) {
      car.history.push({ type: "registration", text: `Госномер ${car.registration.plate.number} включён в продажу автомобиля`, at: Date.now() });
    } else {
      detachPlate(player, car, "Перед продажей снят личный номер");
      if (car.registration.registered) car.history.push({ type: "registration", text: "Перед продажей автомобиль снят с регистрационного учёта", at: Date.now() });
      car.registration.registered = false; car.registration.registeredAt = null;
    }
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
      car.lastPlayerBidAt = null;
      car.lastNpcBidAt = null;
    } else {
      car.startingPrice = null;
      car.auctionEnd = null;
      car.highestBid = 0;
      car.highestBidderId = null;
      car.highestBidderName = null;
      car.highestBidderType = null;
      car.bidCount = 0;
      car.participantIds = [];
      car.lastPlayerBidAt = null;
      car.lastNpcBidAt = null;
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
    if (car.saleType === "auction" && car.highestBidderId && !saleBlockReason(car)) return json(res, 400, { error: "Нельзя снять аукцион после первой ставки" });
    car.highestBid = 0; car.highestBidderId = null; car.highestBidderType = null;
    market.splice(index, 1);
    car.plateIncluded = false;
    player.garage.push(car);
    for (const offer of offers.values()) if (offer.carId === car.id && ["active", "counter"].includes(offer.status)) offer.status = "closed";
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/list/update-price") {
    const car = market.find((item) => item.id === body.carId && item.sellerId === player.id);
    if (!car) return json(res, 404, { error: "Ваше объявление не найдено" });
    if (car.saleType === "auction" && car.highestBidderId) return json(res, 400, { error: "Нельзя менять цену аукциона после первой ставки" });
    const price = Math.round(Number(body.price));
    if (!Number.isFinite(price) || price < 1 || price > MAX_VEHICLE_VALUE) return json(res, 400, { error: `Цена должна быть от 1 ₽ до ${MAX_VEHICLE_VALUE.toLocaleString("ru-RU")} ₽` });
    const previous = car.price;
    car.price = price;
    if (car.saleType === "auction") car.startingPrice = price;
    car.history.push({ type: "price", text: `Цена объявления изменена: ${previous.toLocaleString("ru-RU")} → ${price.toLocaleString("ru-RU")} ₽`, at: Date.now() });
    broadcast();
    if (car.saleType === "fixed") scheduleBots(car);
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/bid") {
    if (levelForXp(player.xp) < AUCTION_UNLOCK_LEVEL) return json(res, 403, { error: `Аукционы откроются с ${AUCTION_UNLOCK_LEVEL} уровня.` });
    const car = market.find((item) => item.id === body.carId && item.saleType === "auction");
    if (!car || car.auctionEnd <= Date.now()) return json(res, 404, { error: "Аукцион уже завершён" });
    if (listingBlockReason(car)) return json(res, 409, { error: listingBlockReason(car) });
    if (car.sellerId === player.id) return json(res, 400, { error: "Нельзя делать ставки на свою машину" });
    if (!canAccessCar(player, car)) return json(res, 403, { error: carUnlockMessage(player, car) });
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
    car.lastPlayerBidAt = Date.now();
    extendClosingAuction(car, "auctionEnd");
    if (previousPlayerId) notifyOutbid(previousPlayerId, "car", car.model, amount, car.id);
    player.stats.bids += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/container/bid") {
    if (levelForXp(player.xp) < AUCTION_UNLOCK_LEVEL) return json(res, 403, { error: `Аукционы откроются с ${AUCTION_UNLOCK_LEVEL} уровня.` });
    const auction = containerAuctions.find((item) => item.id === body.containerId);
    if (!auction || auction.endAt <= Date.now()) return json(res, 404, { error: "Аукцион контейнера завершён" });
    if (player.garage.length >= player.garageCapacity) return json(res, 400, { error: "Освободите место в гараже перед ставкой" });
    if (auction.highestBidderType === "player" && auction.highestBidderId === player.id) return json(res, 409, { error: "Вы уже лидируете. Новая ставка понадобится, только если вас перебьют" });
    const minimum = minimumContainerBid(auction);
    const amount = Math.round(Number(body.amount)); const ownReservation = auction.highestBidderId === player.id ? auction.highestBid : 0;
    if (!Number.isFinite(amount) || amount < minimum) return json(res, 400, { error: `Минимальная ставка: ${minimum.toLocaleString("ru-RU")} ₽` });
    if (amount > player.cash - reservedCash(player) + ownReservation) return json(res, 400, { error: "Недостаточно свободных денег для ставки" });
    const previousPlayerId = auction.highestBidderType === "player" && auction.highestBidderId !== player.id ? auction.highestBidderId : null;
    auction.participantIds ||= [];
    auction.highestBid = amount; auction.highestBidderId = player.id; auction.highestBidderName = player.name; auction.highestBidderType = "player"; auction.bidCount += 1; player.stats.bids += 1;
    extendClosingAuction(auction, "endAt");
    if (!auction.participantIds.includes(player.id)) auction.participantIds.push(player.id);
    if (previousPlayerId) notifyOutbid(previousPlayerId, "container", auction.name, amount, auction.id);
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer") {
    const car = market.find((item) => item.id === body.carId);
    const amount = Math.round(Number(body.amount));
    if (!car || car.saleType === "auction") return json(res, 404, { error: "Торг доступен только в обычном объявлении" });
    if (car.sellerId === player.id) return json(res, 400, { error: "Нельзя торговаться с собой" });
    if (!canAccessCar(player, car)) return json(res, 403, { error: carUnlockMessage(player, car) });
    if (!Number.isFinite(amount) || amount < 1 || amount >= car.price) return json(res, 400, { error: "Предложение должно быть от 1 ₽ и ниже цены объявления" });
    if (amount > player.cash - reservedCash(player)) return json(res, 400, { error: "Свободных денег недостаточно: часть суммы зарезервирована в ставках" });
    const cited = body.defectCode ? car.defects.find(defect => defect.code === body.defectCode && !defect.repaired && car.buyerFindings?.[player.id]?.includes(defect.code)) : null;
    if (body.defectCode && !cited) return json(res, 400, { error: 'Можно сослаться только на неисправность, подтверждённую вашим осмотром' });
    for (const old of offers.values()) if (old.carId === car.id && old.buyerId === player.id && ["active", "counter"].includes(old.status)) old.status = "closed";
    if (!car.sellerId && !listingBlockReason(car)) {
      const estimate = saleEstimate(car);
      const sellerFloor = Math.max(1, Math.round(Math.min(car.price * 0.94, estimate.expectedNpcPrice * 0.97) / 1000) * 1000);
      const negotiationFloor = Math.max(1, Math.round(sellerFloor * 0.86 / 1000) * 1000);
      if (amount >= sellerFloor) {
        if (!completeSale(car, player, amount)) return json(res, 400, { error: "Не хватает места в гараже или свободных денег" });
        broadcast(); return json(res, 200, snapshot(player));
      }
      if (amount < negotiationFloor) return json(res, 400, { error: `NPC отказался: предложение слишком низкое. Реальный торг начинается примерно от ${negotiationFloor.toLocaleString("ru-RU")} ₽` });
      const counterAmount = Math.min(car.price - 1, Math.max(amount + 1, Math.round((amount * 0.35 + sellerFloor * 0.65) / 1000) * 1000));
      const npcSeller = bots.filter((bot) => bot.budget >= car.price).sort(() => Math.random() - 0.5)[0] || bots[0];
      const offer = { id: id("offer_"), carId: car.id, sellerId: null, buyerId: player.id, buyerName: player.name, buyerType: "player", sellerName: npcSeller.name, amount: counterAmount, originalAmount: amount, status: "counter", reason: `${npcSeller.name}: ниже не отдам, но готов уступить от цены объявления.`, createdAt: Date.now() };
      offers.set(offer.id, offer);
      broadcast(); return json(res, 200, snapshot(player));
    }
    const offer = { id: id("offer_"), carId: car.id, sellerId: car.sellerId, buyerId: player.id, buyerName: player.name, buyerType: "player", amount, status: "active", defectCode: cited?.code || null, sellerName: car.seller, reason: cited ? `Прошу скидку: ${cited.name}. Готов купить после устранения неисправности.` : 'Предложение другого игрока', createdAt: Date.now() };
    offers.set(offer.id, offer);
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer/respond") {
    const offer = offers.get(body.offerId);
    if (!offer || offer.sellerId !== player.id || !["active", "counter"].includes(offer.status)) return json(res, 404, { error: "Предложение уже недоступно" });
    const car = market.find((item) => item.id === offer.carId);
    if (!car) return json(res, 404, { error: "Автомобиль уже продан" });
    if (body.action !== 'reject' && saleBlockReason(car)) return json(res, 409, { error: saleBlockReason(car) });
    if (body.action !== 'reject' && offer.buyerType === 'bot') {
      const bot = bots.find(item => item.id === offer.buyerId);
      if (bot && inspectForNpc(car, bot)) { broadcast(); persistState(); return json(res, 409, { error: saleBlockReason(car) }); }
    }
    if (body.action === "expose") {
      ensurePlayerFraud(player);
      offer.status = "rejected";
      player.npcMuted ||= {};
      if (offer.kind === "scam") {
        const bounty = Math.max(1500, Math.round((offer.deposit || 0) * 0.6 / 100) * 100);
        player.cash += bounty;
        player.fraud.exposed += 1;
        player.reputation.score = Math.min(100, player.reputation.score + 2);
        if (offer.buyerType === "bot") player.npcMuted[offer.buyerId] = Date.now() + 15 * 60000;
        addXp(player, 34);
        addLedger(player, "fraud-bounty", "Развод раскрыт: премия", bounty, { counterparty: offer.buyerName, category: "Риск" });
        pushFraudHistory(player, { kind: "exposed-offer", title: `Раскусили «покупателя» ${offer.buyerName}`, amount: bounty });
        player.notifications.push({ id: id("notification_"), type: "fraud", title: "Развод раскрыт", text: `${offer.buyerName} пытался выманить депозит. Покупатель заблокирован на 15 минут, премия ${bounty.toLocaleString("ru-RU")} ₽.`, createdAt: Date.now(), read: false });
        broadcast(); persistState();
        return json(res, 200, { ...snapshot(player), fraudResult: { success: true, bounty, text: "Вы отказались от сделки и сообщили о разводе." } });
      }
      player.reputation.score = Math.max(0, player.reputation.score - 2);
      player.npcRelations ||= {};
      player.npcRelations[offer.buyerId] = (player.npcRelations[offer.buyerId] || 0) - 2;
      player.notifications.push({ id: id("notification_"), type: "fraud", title: "Покупатель обиделся", text: `${offer.buyerName} был честен: обвинение в разводе стоило вам доверия.`, createdAt: Date.now(), read: false });
      broadcast(); persistState();
      return json(res, 200, { ...snapshot(player), fraudResult: { success: false, text: "Предложение оказалось настоящим: репутация подмочена." } });
    }
    if (body.action === "reject") offer.status = "rejected";
    else if (body.action === "counter") {
      const amount = Math.round(Number(body.amount));
      if (offer.buyerType === "bot") {
        if (!Number.isFinite(amount) || amount <= offer.amount || amount >= car.price) return json(res, 400, { error: "Встречная цена должна быть между предложением и ценой объявления" });
        const bot = bots.find(item => item.id === offer.buyerId);
        if (!bot) return json(res, 400, { error: "Покупатель недоступен" });
        player.npcRelations ||= {};
        const outcome = negotiate({ amount, current: offer.amount, ceiling: botAuctionCeiling(car, bot), skill: player.skills.negotiation, office: workplaceBenefits(player).negotiation, relationship: player.npcRelations[bot.id] || 0, attempts: offer.attempts || 0, patience: npcProfile(bot).patience });
        player.npcRelations[bot.id] = clamp((player.npcRelations[bot.id] || 0) + outcome.relationshipDelta, -10, 10);
        offer.attempts = (offer.attempts || 0) + 1;
        useWorkplace(player, ["negotiation"]);
        if (outcome.accepted) {
          player.reputation.score = Math.min(100, player.reputation.score + 1);
          completeSale(car, null, amount);
        } else {
          offer.status = outcome.exhausted ? "rejected" : "active";
          offer.reason = outcome.exhausted ? "Покупатель завершил переговоры. Доверие снизилось." : "Слишком дорого. Моё предложение прежнее; готов выслушать ещё один вариант.";
          if (outcome.relationshipDelta < -1) player.reputation.score = Math.max(0, player.reputation.score - 1);
        }
      } else {
        if (!Number.isFinite(amount) || amount <= offer.amount || amount >= car.price) return json(res, 400, { error: "Встречная цена должна быть между предложением и ценой объявления" });
        offer.amount = amount;
        offer.status = "counter";
        offer.reason = "Продавец предложил встречную цену";
      }
    } else if (body.action === "accept") {
      if (offer.kind === "scam" && offer.deposit) {
        if (body.confirmDeposit !== true) return json(res, 409, { error: `Похоже на развод: ${offer.buyerName} просит депозит ${offer.deposit.toLocaleString("ru-RU")} ₽ до сделки. Подтвердите ещё раз, если готовы потерять деньги.` });
        if (player.cash - reservedCash(player) < offer.deposit) return json(res, 400, { error: "Свободных денег на депозит не хватает" });
        player.cash -= offer.deposit;
        offer.status = "closed";
        offer.reason = "Покупатель получил депозит и пропал";
        ensurePlayerFraud(player);
        player.fraud.scammed += 1;
        player.fraud.scammedCash += offer.deposit;
        player.reputation.score = Math.max(0, player.reputation.score - 1);
        addLedger(player, "fraud-loss", "Депозит мошеннику", -offer.deposit, { counterparty: offer.buyerName, category: "Риск" });
        pushFraudHistory(player, { kind: "scammed", title: `Развод: ${offer.buyerName}`, amount: -offer.deposit });
        player.notifications.push({ id: id("notification_"), type: "fraud", title: "Вас развели", text: `${offer.buyerName} забрал депозит ${offer.deposit.toLocaleString("ru-RU")} ₽ и исчез. В следующий раз проверяйте покупателя до сделки.`, createdAt: Date.now(), read: false });
        broadcast(); persistState();
        return json(res, 200, snapshot(player));
      }
      if (offer.buyerType === "bot") completeSale(car, null, offer.amount);
      else {
        const buyer = players.get(offer.buyerId);
        if (buyer && !canAccessCar(buyer, car)) return json(res, 403, { error: `Покупателю пока недоступна эта ценовая категория.` });
        if (!buyer || buyer.cash - reservedCash(buyer) < offer.amount || !completeSale(car, buyer, offer.amount)) return json(res, 400, { error: "У покупателя недостаточно свободных денег или места" });
      }
    } else return json(res, 400, { error: "Неизвестный ответ" });
    broadcast();
    persistState();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/offer/accept-counter") {
    const offer = offers.get(body.offerId);
    if (!offer || offer.buyerId !== player.id || offer.status !== "counter") return json(res, 404, { error: "Встречное предложение недоступно" });
    const car = market.find((item) => item.id === offer.carId);
    if (!car) return json(res, 404, { error: "Автомобиль уже продан" });
    if (listingBlockReason(car)) return json(res, 409, { error: listingBlockReason(car) });
    if (!canAccessCar(player, car)) return json(res, 403, { error: carUnlockMessage(player, car) });
    if (player.cash - reservedCash(player) < offer.amount || !completeSale(car, player, offer.amount)) return json(res, 400, { error: "Не хватает свободных денег или места в гараже" });
    broadcast();
    return json(res, 200, snapshot(player));
  }

  return json(res, 404, { error: "Команда не найдена" });
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8" };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url.pathname);
    if (url.pathname === "/runtime-config.js") {
      const publicConfig = JSON.stringify({ ads: PUBLIC_AD_CONFIG }).replace(/</g, "\\u003c");
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(`window.PEREKUP_CONFIG = ${publicConfig};`);
    }
    if (url.pathname === "/ads.txt" && ADS_TXT) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      return res.end(`${ADS_TXT}\n`);
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const filePath = path.resolve(PUBLIC_DIR, requested);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    const stat = fs.statSync(filePath);
    // no-cache + ETag: клиент всегда узнаёт, что файл свежий (правка интерфейса видна сразу),
    // но при неизменном ассете получает 304 и не качает 260 КБ заново.
    const etag = `W/"${stat.size.toString(16)}-${Math.round(stat.mtimeMs).toString(16)}"`;
    const headers = { "Content-Type": mime[path.extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache", ETag: etag };
    if (String(req.headers["if-none-match"] || "") === etag) { res.writeHead(304, headers); return res.end(); }
    res.writeHead(200, headers);
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
  if (s3Sync.configured()) {
    const snapshotPath = path.join(DATA_DIR, "game-snapshot-final.db");
    try {
      try { fs.rmSync(snapshotPath, { force: true }); } catch {}
      db.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
      const result = s3Sync.pushFileSync(snapshotPath, { timeoutMs: 8000 });
      console.log(result.pushed ? "S3_SYNC_FINAL_OK: база выгружена в хранилище" : `S3_SYNC_FINAL_FAILED: ${result.error || "снимок не отправлен"}`);
    } catch (error) {
      console.warn(`S3_SYNC_FINAL_ERROR: ${error.message}`);
    } finally {
      try { fs.rmSync(snapshotPath, { force: true }); } catch {}
    }
  }
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
