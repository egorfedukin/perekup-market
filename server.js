const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT || 4173);
const MAX_ADMIN_VALUE = Number.MAX_SAFE_INTEGER;
const PUBLIC_DIR = path.join(__dirname, "public");
const STARTING_CASH = 650000;
const MAX_GARAGE = 4;
const BOT_BID_CHANCE = process.env.PEREKUP_BOT_ALWAYS === "1" ? 1 : 0.48;
const AUCTION_EXTENSION_MS = Math.max(1000, Number(process.env.PEREKUP_ANTI_SNIPE_MS) || 30000);
const NPC_ROTATION_MS = Math.max(60000, Number(process.env.PEREKUP_ROTATION_MS) || 180000);
const NPC_ROTATION_COUNT = 10;
const GROUP_JOB_TIME_SCALE = process.env.PEREKUP_FAST_JOBS === "1" ? 0.02 : 1;
const ASSET_INCOME_CYCLE_MS = process.env.PEREKUP_FAST_ASSETS === "1" ? 600 : 60000;
const ADMIN_NAMES = new Set(String(process.env.PEREKUP_ADMIN_NAMES || "Егор пк").split(",").map((name) => name.trim().toLocaleLowerCase("ru-RU")).filter(Boolean));
const YOOKASSA_SHOP_ID = process.env.YOOKASSA_SHOP_ID || "";
const YOOKASSA_SECRET_KEY = process.env.YOOKASSA_SECRET_KEY || "";
const PUBLIC_URL = String(process.env.PEREKUP_PUBLIC_URL || "https://perekup-market-production.up.railway.app").replace(/\/$/, "");
const AD_PROVIDER = ["yandex", "adsense"].includes(String(process.env.PEREKUP_AD_PROVIDER || "").toLowerCase()) ? String(process.env.PEREKUP_AD_PROVIDER).toLowerCase() : "";
const PUBLIC_AD_CONFIG = {
  provider: AD_PROVIDER,
  marketSlot: process.env.PEREKUP_AD_MARKET_SLOT || "",
  garageSlot: process.env.PEREKUP_AD_GARAGE_SLOT || "",
  adsenseClient: process.env.PEREKUP_ADSENSE_CLIENT || ""
};
const ADS_TXT = String(process.env.PEREKUP_ADS_TXT || "").trim();
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const AUTH_FROM_EMAIL = String(process.env.AUTH_FROM_EMAIL || "Рынок <onboarding@resend.dev>").trim();
const cashPackages = [
  { id: "starter", rubles: 99, cash: 250000, name: "Первый оборот", tag: "Старт", description: "На диагностику, инструменты и первую выгодную сделку", bonus: "+ статус Бронза", supporterTier: "bronze" },
  { id: "dealer", rubles: 249, cash: 800000, name: "Капитал дилера", tag: "Выгодно", description: "Запас на торг, ремонт и несколько автомобилей", bonus: "+ статус Серебро", supporterTier: "silver" },
  { id: "business", rubles: 499, cash: 1900000, name: "Развитие бизнеса", tag: "Выбор игроков", description: "Для командного гаража, персонала и среднего сегмента", bonus: "+ статус Золото", supporterTier: "gold", popular: true },
  { id: "holding", rubles: 999, cash: 4500000, name: "Торговый холдинг", tag: "Крупный капитал", description: "Недвижимость, дорогие лоты и развитие команды", bonus: "+ статус Платина", supporterTier: "platinum" },
  { id: "founder", rubles: 1990, cash: 10000000, name: "Партнёр проекта", tag: "Максимум", description: "Большой капитал и особый статус раннего сторонника", bonus: "+ статус Партнёр", supporterTier: "founder" }
];
const supporterTierRank = { none: 0, bronze: 1, silver: 2, gold: 3, platinum: 4, founder: 5 };
const DATA_DIR = process.env.PEREKUP_DATA_DIR ? path.resolve(process.env.PEREKUP_DATA_DIR) : path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "game.db"));
db.exec("CREATE TABLE IF NOT EXISTS game_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL)");

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
const VEHICLE_PRICING_VERSION = 6;
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
  const value = model.toLowerCase().replace(/[^a-zа-яё0-9]+/giu, " ").trim();
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
  currentBase = domesticProfile?.marketAnchor || entry.referencePrice || modelPriceOverrides[entry.model] || currentBase;
  currentBase = Math.round(Math.max(500000, Math.min(MAX_VEHICLE_VALUE, currentBase)) / 10000) * 10000;
  const classicHint = /\b(type|hp|cv|litre|zeppelin|phantom i|phantom ii|silver ghost)\b/i.test(entry.model)
    || /^(?:Ferrari (?:2\d\d|3\d\d|4(?:0\d|12)|5(?:0\d|12)|6(?:12))|Lamborghini (?:350|400|Countach|Miura)|Toyota 2000GT)\b/i.test(entry.model);
  const modernHint = /\b(ev|electric|électrique|e-tron|ioniq|model [3sxy]|polestar|rivian|lucid)\b/i.test(entry.model) || ["BYD", "Genesis"].includes(entry.make);
  const knownYears = domesticProfile || vehicleProductionYears[entry.model];
  const inferredStartYear = classicHint ? 1950 + Math.floor(stableVehicleUnit(entry.model, "year") * 28) : modernHint ? 2012 + Math.floor(stableVehicleUnit(entry.model, "year") * 10) : 1988 + Math.floor(stableVehicleUnit(entry.model, "year") * 27);
  const startYear = knownYears?.startYear || inferredStartYear;
  const endYear = knownYears?.endYear || Math.min(2026, startYear + 8 + Math.floor(stableVehicleUnit(entry.model, "span") * 15));
  return { ...entry, className, startYear, endYear, currentBase, marketAnchor: domesticProfile?.marketAnchor || null };
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

const skillInfo = {
  diagnostics: { name: "Диагност", description: "Двигатель, подвеска и поиск скрытых симптомов", maxLevel: 5 },
  mechanics: { name: "Механик", description: "Ремонт двигателя, ходовой и колёс", maxLevel: 5 },
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
  { key: "detailing", name: "Профессиональный детейлинг", description: "Глубокая очистка салона, полировка кузова и фото-подготовка.", skill: "bodywork", equipment: "bodyStation", skillLevel: 1, equipmentLevel: 1, cost: 22000, value: 36000, condition: 4 },
  { key: "maintenance", name: "Большое ТО", description: "Масла, фильтры и регламентные расходники с записью в историю.", skill: "mechanics", equipment: "workshop", skillLevel: 1, equipmentLevel: 1, cost: 34000, value: 52000, condition: 6 },
  { key: "suspension", name: "Настройка ходовой", description: "Развал-схождение и настройка подвески для уверенного хода.", skill: "mechanics", equipment: "workshop", skillLevel: 2, equipmentLevel: 2, cost: 76000, value: 112000, condition: 8 },
  { key: "electronics", name: "Профилактика электроники", description: "Проверка блоков, контактов и обновление сервисной истории.", skill: "electrics", equipment: "electricalBench", skillLevel: 2, equipmentLevel: 2, cost: 68000, value: 104000, condition: 5 },
  { key: "restoration", name: "Предпродажная реставрация", description: "Комплексная подготовка редкого автомобиля с подтверждёнными работами.", skill: "appraisal", equipment: "bodyStation", skillLevel: 3, equipmentLevel: 3, cost: 165000, value: 255000, condition: 10 }
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
  { key: "garage_block", type: "property", category: "commercial", name: "Блок из шести гаражей", description: "Полностью заняты арендаторами, минимальные расходы на содержание.", basePrice: 6100000, income: 74000, liquidity: 78, risk: 1, skill: "propertyManagement" },
  { key: "office", type: "property", category: "commercial", name: "Офисное помещение", description: "Первый этаж бизнес-центра, договор аренды ещё на два года.", basePrice: 18500000, income: 195000, liquidity: 64, risk: 2, skill: "propertyManagement" },
  { key: "warehouse", type: "property", category: "commercial", name: "Тёплый склад", description: "Промышленная зона, удобный подъезд и стабильный арендатор.", basePrice: 32000000, income: 365000, liquidity: 59, risk: 3, skill: "propertyManagement" },
  { key: "retail", type: "property", category: "commercial", name: "Торговое помещение", description: "Угловой вход на первой линии, высокий трафик и дорогая эксплуатация.", basePrice: 68000000, income: 790000, liquidity: 52, risk: 4, skill: "propertyManagement" },
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
    players: [...players.entries()], sessions: [...sessions.entries()], emailVerifications: [...emailVerifications.entries()], market,
    offers: [...offers.entries()], salesHistory, marketIndices, chatMessages, directMessages, moderationReports, assetMarket,
    groups: [...groups.entries()], partsMarket, partsSalesHistory, plateMarket, partIndices, paymentOrders: [...paymentOrders.entries()], containerAuctions, clothingCrafts: [...clothingCrafts.entries()], clothingMarket, itemContainerAuctions, cryptoHistory,
    vehiclePricingVersion: VEHICLE_PRICING_VERSION
  });
  db.prepare("INSERT INTO game_state (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at")
    .run(payload, Date.now());
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
  const row = db.prepare("SELECT payload FROM game_state WHERE id = 1").get();
  if (!row) return false;
  try {
    const saved = JSON.parse(row.payload);
    loadedVehiclePricingVersion = Number(saved.vehiclePricingVersion || 0);
    for (const [key, value] of saved.players || []) { ensurePlayerDefaults(value); players.set(key, value); }
    for (const [key, value] of saved.sessions || []) sessions.set(key, value);
    for (const [key, value] of saved.emailVerifications || []) emailVerifications.set(key, value);
    for (const car of saved.market || []) { ensureCarDefaults(car); market.push(car); }
    for (const [key, value] of saved.offers || []) offers.set(key, value);
    for (const sale of saved.salesHistory || []) salesHistory.push(sale);
    Object.assign(marketIndices, saved.marketIndices || {});
    chatMessages.push(...(saved.chatMessages || []).slice(-100));
    directMessages.push(...(saved.directMessages || []).slice(-1000));
    moderationReports.push(...(saved.moderationReports || []).slice(-500));
    assetMarket.push(...(saved.assetMarket || []));
    for (const [key, value] of saved.groups || []) { ensureGroupDefaults(value); groups.set(key, value); }
    partsMarket.push(...(saved.partsMarket || []).map(ensurePartLot));
    partsSalesHistory.push(...(saved.partsSalesHistory || []).slice(-500));
    plateMarket.push(...(saved.plateMarket || []).map(ensurePlateLot));
    Object.assign(partIndices, saved.partIndices || {});
    for (const [key, value] of saved.paymentOrders || []) paymentOrders.set(key, value);
  containerAuctions.push(...(saved.containerAuctions || []));
  for (const [playerId, craft] of (saved.clothingCrafts || [])) clothingCrafts.set(playerId, craft);
  clothingMarket.push(...(saved.clothingMarket || [])); itemContainerAuctions.push(...(saved.itemContainerAuctions || [])); Object.assign(cryptoHistory, saved.cryptoHistory || {});
    return market.length > 0;
  } catch (error) {
    console.error("Failed to load saved game:", error.message);
    return false;
  }
}

function ensurePlayerDefaults(player) {
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
  player.stats ||= { purchases: 0, inspections: 0, serviceDiagnostics: 0, selfRepairs: 0, assistedRepairs: 0, workshopRepairs: 0, auctionsWon: 0, bids: 0, partsSold: 0, partsBought: 0, upgrades: 0 };
  for (const key of ["purchases", "inspections", "serviceDiagnostics", "selfRepairs", "assistedRepairs", "workshopRepairs", "auctionsWon", "bids", "partsSold", "partsBought", "upgrades", "assetsBought", "assetsSold"]) player.stats[key] ??= 0;
  player.chatState ||= { sentAt: [], lastNormalized: "", lastDuplicateAt: 0, violations: 0, mutedUntil: 0 };
  player.plateInventory ||= [];
  player.plateInventory = player.plateInventory.map(ensurePlate);
  player.bannedUntil ??= 0;
  player.banReason ||= "";
  player.ownedAssets ||= [];
  player.assetIncomeLastAt ??= Date.now();
  for (const asset of player.ownedAssets) if (asset.type === "property") {
    asset.incomeLastAt ??= asset.acquiredAt || player.assetIncomeLastAt;
    asset.rentalStatus ||= "vacant";
    asset.tenant ||= null;
    asset.taxLastAt ??= Date.now();
    asset.taxDebt ??= 0;
    asset.maintenance ??= 100;
  }
  player.businesses ||= [];
  player.reputation ||= { score: 50, completed: 0, failed: 0 };
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
  if (!player.contracts.length) player.contracts = generateContracts(player);
}

function addLedger(player, type, title, amount = 0, details = {}, at = Date.now()) {
  if (!player) return;
  player.ledger ||= [];
  player.ledger.push({ id: id("ledger_"), type, title, amount: Math.round(Number(amount) || 0), at, ...details });
  if (player.ledger.length > 160) player.ledger.splice(0, player.ledger.length - 160);
}

function isAdmin(player) {
  return Boolean(player && ADMIN_NAMES.has(String(player.normalizedName || player.name).toLocaleLowerCase("ru-RU")));
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

function generateContracts() {
  const models = catalog.slice().sort(() => Math.random() - 0.5);
  const contractId = () => `contract_${crypto.randomBytes(7).toString("hex")}`;
  return [
    { id: contractId(), title: "Быстрый оборот", description: `Купите и продайте ${models[0].model} с прибылью`, kind: "profit", model: models[0].model, reward: 42000, expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Честный подбор", description: `Продайте ${models[1].model} без скрытых проблем в описании`, kind: "honest", model: models[1].model, reward: 36000, expiresAt: Date.now() + 7 * 86400000, status: "active" },
    { id: contractId(), title: "Сервисная история", description: "Продайте диагностированную и отремонтированную машину", kind: "restored", reward: 58000, expiresAt: Date.now() + 7 * 86400000, status: "active" }
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
}

function currentValue(car) {
  ensureCarDefaults(car);
  const unresolved = car.defects.filter((defect) => !defect.repaired).reduce((sum, defect) => sum + defect.impact, 0);
  const salvageFloor = Math.max(40000, Math.round(car.cleanValue * 0.3 / 1000) * 1000);
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
  const repairPremium = Math.min(marketPrice * 0.055, repairValue * 0.08);
  const documentationPremium = car.serviceDiagnosed ? marketPrice * 0.045 : inspection.confidence >= 70 ? marketPrice * 0.018 : 0;
  const restoredPremium = repaired.length && !unresolved.length ? marketPrice * 0.07 : 0;
  const upgradePremium = Math.min(marketPrice * 0.11, car.upgradeValue * 0.22);
  const conditionAdjustment = clamp((car.condition - 65) * marketPrice * 0.0022, -marketPrice * 0.08, marketPrice * 0.08);
  const repairLiquidityPenalty = repaired.length ? Math.min(marketPrice * 0.035, repaired.length * 7000) : 0;
  const employeePremium = marketPrice * (groupEmployeeRating(employeePlayer, "sales") / 100) * 0.04 + marketPrice * (groupEmployeeRating(employeePlayer, "appraisal") / 100) * 0.025;
  const installedPartsPremium = Math.min(marketPrice * 0.085, car.installedParts.reduce((sum, part) => {
    const qualityBonus = part.quality === "original" ? 1.35 : part.quality === "economy" ? 0.55 : part.quality === "restored" ? 0.7 : 1;
    return sum + part.estimatedValue * qualityBonus * (0.16 + part.reliability / 500);
  }, 0));
  const platePremium = car.plateIncluded && car.registration?.plate ? car.registration.plate.estimatedValue : 0;
  const expectedNpcPrice = Math.max(1, Math.round((technicalValue * 0.58 + marketPrice * 0.42 + repairPremium + documentationPremium + restoredPremium + upgradePremium + conditionAdjustment - repairLiquidityPenalty + employeePremium + installedPartsPremium + platePremium) / 1000) * 1000);
  const recommendedLow = Math.max(1, Math.round(expectedNpcPrice * 0.94 / 1000) * 1000);
  const recommendedHigh = Math.max(recommendedLow, Math.round(expectedNpcPrice * 1.09 / 1000) * 1000);
  const breakEven = Math.max(1, Math.ceil(car.invested * 1.02 / 1000) * 1000);
  return {
    technicalValue, marketPrice, repairPremium: Math.round(repairPremium), documentationPremium: Math.round(documentationPremium + restoredPremium), upgradePremium: Math.round(upgradePremium),
    expectedNpcPrice, recommendedLow, recommendedHigh, breakEven, invested: car.invested,
    unresolvedCount: unresolved.length, repairedCount: repaired.length,
    inspectionConfidence: inspection.confidence, inspectionLabel: inspection.label, upgradeValue: car.upgradeValue, upgradeCount: car.upgrades.length,
    employeePremium: Math.round(employeePremium), installedPartsPremium: Math.round(installedPartsPremium), platePremium: Math.round(platePremium)
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
  if (roll < 0.12) return { key: "urgent", tag: "Срочная продажа", min: 0.78, max: 0.89 };
  if (roll < 0.22) return { key: "project", tag: "Проект", min: 0.68, max: 0.82 };
  if (roll < 0.8) return { key: "fair", tag: "Рыночная цена", min: 0.9, max: 1.04 };
  return { key: "optimistic", tag: "Есть торг", min: 1.05, max: 1.14 };
}

function makeCar(index, seller = "Авторынок") {
  const item = catalog[index % catalog.length];
  const age = 2026 - item.year;
  const annualMileage = ["premium", "coupe", "roadster", "electric"].includes(item.className) ? [4, 11] : item.className === "classic" ? [3, 9] : ["van", "pickup"].includes(item.className) ? [12, 26] : [8, 18];
  const mileage = randomInt(Math.max(1, age * annualMileage[0]), Math.max(8, age * annualMileage[1])) * 1000;
  const pricing = npcPricingProfile();
  const naturalDefects = randomInt(1, Math.min(4, Math.floor(age / 4) + 1));
  const count = pricing.key === "project" ? Math.max(3, naturalDefects) : naturalDefects;
  const pool = [...defectCatalog].sort(() => Math.random() - 0.5).slice(0, count);
  if (!pool.some((defect) => defectPartCatalog[defect.code])) {
    const physicalDefects = defectCatalog.filter((defect) => defectPartCatalog[defect.code]);
    pool[0] = physicalDefects[randomInt(0, physicalDefects.length - 1)];
  }
  const wear = Math.min(0.4, mileage / 850000);
  const cleanValue = Math.round(item.base * (1 - wear) / 1000) * 1000;
  const provisional = { cleanValue, defects: pool.map((d) => ({ ...d, repaired: false })) };
  const fair = currentValue(provisional);
  const indexed = marketIndices[item.model]?.price;
  const pricingBase = clamp(indexed || fair, fair * 0.78, fair * 1.28);
  const asking = Math.max(minimumNpcPrice(item.model), Math.round((pricingBase * (pricing.min + Math.random() * (pricing.max - pricing.min))) / 1000) * 1000);
  const listedAt = Date.now();
  return {
    id: id("car_"), make: item.make, photoQuery: item.photoQuery, photoUrl: item.photoUrl, photoSource: item.photoSource, model: item.model, year: item.year, mileage, price: asking,
    purchasePrice: asking, invested: asking, seller, sellerId: null, ownerId: null,
    color: item.color, className: item.className, cleanValue,
    condition: clamp(95 - Math.round(wear * 100) - count * 7, 28, 92),
    defects: provisional.defects, discovered: [], checkedCategories: [], inspectionRecords: {}, serviceDiagnosed: false, repairs: [],
    description: pricing.key === "project" ? "Цена снижена: автомобиль под восстановление, состояние проверяйте внимательно." : count <= 1 ? "Ухоженная машина, сел и поехал." : ["Едет бодро, есть возрастные моменты.", "Продажа без спешки. Торг у капота.", "На ходу каждый день, требует внимания."][randomInt(0, 2)],
    marketTag: pricing.tag, listedAt,
    history: [{ type: "listed", text: "Первичное объявление на рынке", at: listedAt }]
  };
}

function publicDefect(defect, car = null) {
  const repairSkill = defect.category === "engine" ? "engineRepair" : defect.category === "chassis" ? "chassisRepair" : defect.category === "tires" ? "tireService" : defect.category === "body" ? "bodywork" : defect.category === "electrics" ? "electrics" : "appraisal";
  const repairEquipment = defect.category === "engine" ? "engineStand" : defect.category === "chassis" ? "chassisTools" : defect.category === "tires" ? "tireStation" : defect.category === "body" ? "bodyStation" : defect.category === "electrics" ? "electricalBench" : "historyTerminal";
  const selfRepairable = defect.category !== "documents";
  const partSpec = partSpecForDefect(defect);
  const analogOffer = car && partSpec ? partOffer(car, defect, "analog") : null;
  const laborBase = partSpec && analogOffer ? Math.max(500, defect.repair - analogOffer.retailPrice) : defect.repair;
  const serviceRepairCost = Math.max(500, Math.round((laborBase + (analogOffer?.retailPrice || 0) * 1.12) / 500) * 500);
  return {
    code: defect.code, category: defect.category, name: defect.name, symptom: defect.symptom,
    consequence: defect.consequence, severity: defect.severity, skill: defect.skill,
    partName: partSpec?.name || null, partKey: partSpec?.sku || null, partRequired: Boolean(partSpec), partComponent: partSpec?.component || null,
    equipment: defect.equipment, equipmentLevel: defect.equipmentLevel,
    repair: serviceRepairCost, repaired: defect.repaired,
    selfRepairable,
    serviceRepairCost, serviceLaborCost: laborBase,
    assistedRepairCost: Math.max(500, Math.round(laborBase * 0.58 / 500) * 500),
    selfRepairCost: Math.max(500, Math.round(laborBase * 0.3 / 500) * 500),
    repairSkill, repairSkillLevel: Math.min(5, defect.severity + 1),
    repairEquipment, repairEquipmentLevel: defect.severity,
    assistedSkillLevel: defect.severity,
    assistedEquipmentLevel: Math.max(0, defect.severity - 1)
  };
}

function publicCar(car, ownerView = false, viewer = null) {
  ensureCarDefaults(car);
  const visibleCodes = new Set([
    ...(car.publicDiscovered || []),
    ...(ownerView ? car.discovered : []),
    ...(car.saleType === "auction" ? car.defects.filter((defect) => !defect.repaired).map((defect) => defect.code) : [])
  ]);
  const result = {
    id: car.id, make: car.make, photoQuery: car.photoQuery, photoUrl: car.photoUrl, photoSource: car.photoSource, model: car.model, year: car.year, mileage: car.mileage, price: car.price,
    seller: car.seller, sellerId: car.sellerId, color: car.color, className: car.className,
    condition: car.condition, description: car.description, repairs: car.repairs,
    registration: { registered: Boolean(car.registration.registered), plate: car.registration.plate ? { ...car.registration.plate } : null },
    plateIncluded: Boolean(car.plateIncluded),
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

function offerView(offer) {
  const car = market.find((item) => item.id === offer.carId);
  return { ...offer, car: car ? { id: car.id, model: car.model, price: car.price, color: car.color, year: car.year } : offer.car };
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
  const grossPerCycle = occupied ? Math.round((asset.income || 0) * managementBonus * (asset.maintenance || 100) / 100) : 0;
  const operatingCost = occupied ? Math.round(grossPerCycle * 0.12) : Math.round((asset.income || 0) * 0.025);
  const taxPerCycle = Math.max(100, Math.round((asset.fairValue || asset.purchasePrice || 0) * 0.00018));
  const taxCycles = Math.min(60, Math.floor((now - (asset.taxLastAt || now)) / ASSET_INCOME_CYCLE_MS));
  const taxDue = (asset.taxDebt || 0) + taxCycles * taxPerCycle;
  const netPerCycle = Math.max(0, grossPerCycle - operatingCost);
  return { cycles: elapsedCycles, amount: netPerCycle * elapsedCycles, nextAt: lastAt + (elapsedCycles + 1) * ASSET_INCOME_CYCLE_MS, perCycle: grossPerCycle, netPerCycle, operatingCost, taxPerCycle, taxDue, occupied };
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
  return {
    id: player.id, name: player.name, cash: player.cash, profit: player.profit, deals: player.deals, isAdmin: isAdmin(player), purchasedCash: player.purchasedCash, supporterTier: player.supporterTier, training: player.training,
    availableCash: player.cash - reserved, reservedCash: reserved,
    xp: player.xp, level: levelForXp(player.xp), levelStartXp: xpForLevel(levelForXp(player.xp)), nextLevelXp: levelForXp(player.xp) >= 30 ? player.xp : xpForLevel(levelForXp(player.xp) + 1),
    skillPoints: player.skillPoints, skills: player.skills, equipment: player.equipment, stats: player.stats,
    reputation: player.reputation, contracts: player.contracts, garageCapacity: player.garageCapacity, parts: player.parts,
    group: player.groupId && groups.get(player.groupId) ? publicGroupView(groups.get(player.groupId), player) : null, groupRole: player.groupRole,
    garage: player.garage.map((car) => publicCar(car, true, player)), partInventory: player.partInventory, plateInventory: player.plateInventory,
    ownedAssets: player.ownedAssets.map((asset) => ({ ...asset, resaleValue: assetResaleValue(asset, player), incomeState: propertyIncomeState(asset, player), propertyHistory: asset.type === "property" ? propertyHistory(asset) : undefined })),
    businesses: player.businesses.map((business) => ({ ...business, state: businessState(business) })),
    clothingCraft: clothingCrafts.get(player.id) || null,
    assetIncomeAvailable: assetIncomeAvailable(player), businessCatalog, clothingCatalog: clothingCatalog.filter((_, index) => index < 200).map((item) => ({ ...item, rarityName: clothingRarityNames[item.rarity] })),
    incomingOffers: [...offers.values()].filter((offer) => offer.sellerId === player.id && ["active", "counter"].includes(offer.status)).map(offerView),
    outgoingOffers: [...offers.values()].filter((offer) => offer.buyerId === player.id && ["active", "counter"].includes(offer.status)).map(offerView),
    containerRewards: player.containerRewards.filter((reward) => !reward.acknowledged).slice(-3),
    notifications: player.notifications.slice(-20).reverse(), unreadNotifications: player.notifications.filter((item) => !item.read).length,
    activities: { ...player.activities, catalog: activityCatalog },
    ledger: player.ledger.slice(-100).reverse()
  };
}

function leaderboardView(viewer) {
  const isActive = (candidate) => candidate.deals > 0 || candidate.profit !== 0 || candidate.xp > 0
    || candidate.stats?.purchases > 0 || candidate.stats?.bids > 0 || candidate.stats?.inspections > 0
    || candidate.stats?.assetsBought > 0 || candidate.training?.completed > 0;
  const participants = [...players.values()].filter((candidate) => isActive(candidate) || candidate.id === viewer?.id)
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
    level: levelForXp(candidate.xp),
    reputation: candidate.reputation?.score || 50,
    completedDeals: candidate.reputation?.completed || candidate.deals || 0,
    deals: candidate.deals || 0,
    supporterTier: candidate.supporterTier || "none",
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
    market: market.map((car) => publicCar(car, car.sellerId === player?.id, player)),
    skillInfo,
    equipmentInfo,
    inspectionCategories: inspectionCategories(),
    inspectionRequirements,
    marketStats: marketStatistics(),
    partsMarketStats: partsMarketStatistics(),
    chatMessages: chatMessages.slice(-100).map((message) => ({ ...message, supporterTier: players.get(message.playerId)?.supporterTier || "none" })),
    directMessages: playerDirectMessages,
    directUnread: playerDirectMessages.filter((message) => message.recipientId === player?.id && !message.readAt).length,
    playerDirectory: player ? [...directContactIds].map((playerId) => players.get(playerId)).filter((candidate) => candidate && !banMessage(candidate)).map((candidate) => ({ id: candidate.id, name: candidate.name, level: levelForXp(candidate.xp), reputation: candidate.reputation?.score || 50 })) : [],
    partsMarket: partsMarket.slice(-100),
    plateMarket: plateMarket.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 120),
    partNeeds: player ? playerPartNeeds(player) : [],
    partQualities: partQualityCatalog,
    partComponents,
    marketRotation: { nextAt: marketRotationNextAt, intervalSeconds: Math.round(NPC_ROTATION_MS / 1000), replaceCount: NPC_ROTATION_COUNT },
    groups: [...groups.values()].map((group) => ({ id: group.id, name: group.name, rating: group.rating, members: group.members.length })),
    npcProfiles: bots.map((bot) => ({ id: bot.id, name: bot.name, type: bot.type, rating: Math.round((bot.risk * 80 + bot.skill * 4) * 10) / 10, budget: bot.budget })),
    employeeCandidates, groupJobCatalog: Object.values(groupJobCatalog),
    store: { enabled: Boolean(YOOKASSA_SHOP_ID && YOOKASSA_SECRET_KEY), provider: "YooKassa", packages: cashPackages },
    catalogCount: catalog.length,
    containerAuctions: containerAuctions.map((container) => publicContainer(container, player)),
    assetMarket: assetMarket.filter((listing) => listing.stock > 0).map((listing) => publicAssetListing(listing, player)), cryptoQuotes: cryptoQuotes(), clothingMarket: clothingMarket.map((lot) => ({ ...lot, viewerOwned: lot.sellerId === player.id })), itemContainerAuctions: itemContainerAuctions.map((box) => ({ ...box, viewerLeading: box.highestBidderId === player.id, viewerParticipated: box.participantIds.includes(player.id) })),
    assetCategories: { electronics: "Техника", collectibles: "Коллекции", business: "Оборудование", clothing: "Одежда", residential: "Жилая недвижимость", commercial: "Коммерческая недвижимость", crypto: "Криптовалюта" },
    leaderboard: leaderboard.rows,
    leaderboardCurrent: leaderboard.current,
    leaderboardTotal: leaderboard.total
  };
}

function broadcast() {
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
  marketStatsCache = null;
  loadedVehiclePricingVersion = VEHICLE_PRICING_VERSION;
  persistState();
}
if (!loadState()) {
  seedMarket();
  persistState();
}
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

function verifyPassword(password, player) {
  if (!player.passwordSalt || !player.passwordHash) return false;
  const candidate = Buffer.from(hashPassword(password, player.passwordSalt).hash, "hex");
  const expected = Buffer.from(player.passwordHash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

async function sendVerificationEmail(email, name, token) {
  if (!RESEND_API_KEY) throw new Error("Подтверждение почты временно недоступно: владелец ещё не настроил почтовый сервис");
  const link = `${PUBLIC_URL}/verify-email.html?token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: AUTH_FROM_EMAIL, to: [email], subject: "Подтвердите почту в игре «Рынок»", html: `<p>Здравствуйте, ${String(name).replace(/[<>]/g, "")}</p><p>Нажмите кнопку, чтобы подтвердить адрес электронной почты:</p><p><a href="${link}">Подтвердить почту</a></p><p>Ссылка действует 24 часа.</p>` }) });
  if (!response.ok) throw new Error("Не удалось отправить письмо подтверждения");
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

function restock() {
  const npcCount = market.filter((car) => !car.sellerId).length;
  for (let i = npcCount; i < 100; i += 1) market.push(makeCar(randomInt(0, catalog.length - 1)));
  ensureNpcAuctions();
}

function configureNpcAuction(car) {
  const estimate = saleEstimate(car);
  const startFactor = 0.62 + Math.random() * 0.16;
  car.saleType = "auction";
  car.seller = ["Муниципальные торги", "Дилерский аукцион", "Страховой склад", "Лизинговый парк"][randomInt(0, 3)];
  car.startingPrice = Math.max(Math.round(minimumNpcPrice(car.model) * 0.7 / 1000) * 1000, Math.round(estimate.expectedNpcPrice * startFactor / 1000) * 1000);
  car.price = car.startingPrice;
  car.auctionEnd = Date.now() + randomInt(180, 420) * 1000;
  car.highestBid = 0; car.highestBidderId = null; car.highestBidderName = null; car.highestBidderType = null;
  car.bidCount = 0; car.participantIds = []; car.lastPlayerBidAt = null; car.lastNpcBidAt = null;
}

function ensureNpcAuctions() {
  const target = 10;
  const active = market.filter((car) => !car.sellerId && car.saleType === "auction" && car.auctionEnd > Date.now()).length;
  const candidates = market.filter((car) => !car.sellerId && car.saleType !== "auction").sort(() => Math.random() - 0.5);
  candidates.slice(0, Math.max(0, target - active)).forEach(configureNpcAuction);
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
    const ratio = (index + 0.5) / Math.max(1, npcCars.length);
    const pricing = npcPricingProfile(ratio);
    const fair = currentValue(car);
    const reference = clamp(marketIndices[car.model]?.price || fair, fair * 0.78, fair * 1.28);
    const multiplier = pricing.min + Math.random() * (pricing.max - pricing.min);
    car.price = Math.max(minimumNpcPrice(car.model), Math.round(reference * multiplier / 1000) * 1000);
    car.purchasePrice = car.price;
    car.invested = car.price;
    car.marketTag = pricing.tag;
    car.listedAt = Date.now() - randomInt(0, NPC_ROTATION_MS);
  });
  for (const car of market.filter((item) => !item.sellerId && item.saleType === "auction" && !item.bidCount)) {
    const fair = saleEstimate(car).expectedNpcPrice;
    car.startingPrice = Math.max(Math.round(minimumNpcPrice(car.model) * 0.7 / 1000) * 1000, Math.round(clamp(car.startingPrice || car.price, fair * 0.58, fair * 0.82) / 1000) * 1000);
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
  const pack = cashPackages.find((item) => item.id === order.packageId);
  player.cash += order.cash;
  player.purchasedCash += order.cash;
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
  const now = Date.now();
  const active = market.filter((car) => car.saleType === "auction" && car.auctionEnd > now + 1500);
  for (const car of active) {
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
  const text = normalizeChatText(rawText);
  const now = Date.now();
  const chat = player.chatState;
  if (chat.mutedUntil > now) throw new Error(`Чат временно недоступен ещё ${Math.ceil((chat.mutedUntil - now) / 1000)} сек.`);
  if (text.length < 2) throw new Error("Сообщение слишком короткое");
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
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2) return json(res, 400, { error: "Введите имя от 2 символов" });
    if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: "Введите корректный email" });
    if (password.length < 8 || password.length > 72) return json(res, 400, { error: "Пароль должен содержать от 8 до 72 символов" });
    const normalized = name.toLocaleLowerCase("ru-RU");
    if ([...players.values()].some((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === normalized && (item.pinHash || item.passwordHash))) {
      return json(res, 409, { error: "Аккаунт с таким именем уже существует" });
    }
    if ([...players.values()].some((item) => item.email === email)) return json(res, 409, { error: "Этот email уже зарегистрирован" });
    const player = createPlayer(name, null, { email, password, emailVerified: false });
    const verificationToken = id("verify_");
    emailVerifications.set(verificationToken, { playerId: player.id, expiresAt: Date.now() + 86400000 });
    try { await sendVerificationEmail(email, name, verificationToken); } catch (error) { emailVerifications.delete(verificationToken); return json(res, 503, { error: error.message }); }
    players.set(player.id, player);
    persistState();
    return json(res, 200, { pendingVerification: true, email });
  }

  if (req.method === "GET" && pathname === "/api/verify-email") {
    const requestUrl = new URL(req.url, `http://${req.headers.host}`);
    const verificationToken = requestUrl.searchParams.get("token") || "";
    const record = emailVerifications.get(verificationToken);
    if (!record || record.expiresAt < Date.now()) return json(res, 400, { error: "Ссылка недействительна или устарела" });
    const player = players.get(record.playerId);
    if (!player) return json(res, 404, { error: "Аккаунт не найден" });
    player.emailVerified = true; emailVerifications.delete(verificationToken); persistState();
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && pathname === "/api/login") {
    const body = await readBody(req);
    const name = String(body.name || "").trim().toLocaleLowerCase("ru-RU");
    const password = String(body.password || "");
    const pin = String(body.pin || "");
    const player = [...players.values()].find((item) => (item.normalizedName || item.name.toLocaleLowerCase("ru-RU")) === name && (item.passwordHash || item.pinHash));
    const valid = player && (player.passwordHash ? verifyPassword(password, player) : verifyPin(pin, player));
    if (!valid) return json(res, 401, { error: "Неверный логин или пароль" });
    if (player.passwordHash && !player.emailVerified) return json(res, 403, { error: "Подтвердите email по ссылке из письма" });
    const blocked = banMessage(player);
    if (blocked) return json(res, 403, { error: blocked });
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
  const blocked = banMessage(player);
  if (blocked) return json(res, 403, { error: blocked });
  if (req.method === "GET" && pathname === "/api/state") return json(res, 200, snapshot(player));
  if (req.method === "GET" && pathname === "/api/player/profile") {
    const playerId = new URL(req.url, `http://${req.headers.host}`).searchParams.get("id");
    const candidate = players.get(String(playerId || ""));
    if (!candidate || banMessage(candidate)) return json(res, 404, { error: "Профиль игрока недоступен" });
    return json(res, 200, publicPlayerProfile(candidate, player));
  }
  if (req.method === "GET" && pathname === "/api/admin/state") {
    if (!isAdmin(player)) return json(res, 403, { error: "Доступ только для администратора" });
    return json(res, 200, {
      players: [...players.values()].map((item) => ({ id: item.id, name: item.name, cash: item.cash, skillPoints: item.skillPoints, profit: item.profit, deals: item.deals, level: levelForXp(item.xp), garage: item.garage.length, reputation: item.reputation?.score || 50, purchasedCash: item.purchasedCash || 0, bannedUntil: item.bannedUntil || 0, banReason: item.banReason || "" })),
      reports: moderationReports.filter((report) => report.status === "open").slice().reverse(),
      economy: { players: players.size, marketCars: market.length, deals: salesHistory.length, activeOffers: [...offers.values()].filter((offer) => ["active", "counter"].includes(offer.status)).length, payments: [...paymentOrders.values()].filter((order) => order.status === "succeeded").length, openReports: moderationReports.filter((report) => report.status === "open").length }
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
    if (["ban", "unban", "mute"].includes(action)) {
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
    const cost = 12000;
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
      const plateIndex = player.plateInventory.findIndex((plate) => plate.id === String(body.plateId || ""));
      if (plateIndex < 0) return json(res, 400, { error: "Для постановки на учёт выберите номер" });
      const cost = 8500;
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: `Для постановки на учёт нужно ${cost.toLocaleString("ru-RU")} ₽` });
      const plate = player.plateInventory.splice(plateIndex, 1)[0];
      player.cash -= cost; car.registration.registered = true; car.registration.registeredAt = Date.now(); car.registration.plate = plate;
      car.history.push({ type: "registration", text: `Автомобиль поставлен на учёт с номером ${plate.number}`, at: Date.now() });
      addLedger(player, "registration", `Постановка на учёт: ${car.model}`, -cost, { carId: car.id, category: "Гараж" });
    } else if (action === "deregister") {
      if (!car.registration.registered) return json(res, 409, { error: "Автомобиль уже снят с учёта" });
      const cost = 2500;
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
    if (action === "rent") {
      if (asset.rentalStatus === "rented") return json(res, 400, { error: "Объект уже сдан" });
      const fee = Math.max(5000, Math.round((asset.income || 0) * 0.35 / 1000) * 1000);
      if (player.cash - reservedCash(player) < fee) return json(res, 400, { error: `Нужно ${fee.toLocaleString("ru-RU")} ₽ на поиск арендатора` });
      player.cash -= fee; asset.rentalStatus = "rented"; asset.tenant = ["Семья Орловых", "Студия Север", "ООО Вектор", "ИП Соколов", "Компания Маяк"][randomInt(0, 4)]; asset.incomeLastAt = Date.now();
      addLedger(player, "property", `Заселение: ${asset.name}`, -fee, { category: "Недвижимость" });
    } else if (action === "vacate") {
      asset.rentalStatus = "vacant"; asset.tenant = null; asset.incomeLastAt = Date.now();
    } else if (action === "tax") {
      if (incomeState.taxDue < 1) return json(res, 400, { error: "Налог пока не начислен" });
      if (player.cash - reservedCash(player) < incomeState.taxDue) return json(res, 400, { error: "Недостаточно денег для уплаты налога" });
      player.cash -= incomeState.taxDue; asset.taxDebt = 0; asset.taxLastAt = Date.now();
      addLedger(player, "tax", `Налог: ${asset.name}`, -incomeState.taxDue, { category: "Недвижимость" });
    } else if (action === "maintain") {
      if ((asset.maintenance || 100) >= 100) return json(res, 400, { error: "Объект уже в отличном состоянии" });
      const cost = Math.max(10000, Math.round((asset.fairValue || asset.purchasePrice) * 0.004 / 1000) * 1000);
      if (player.cash - reservedCash(player) < cost) return json(res, 400, { error: "Недостаточно денег на обслуживание" });
      player.cash -= cost; asset.maintenance = 100; addLedger(player, "maintenance", `Обслуживание: ${asset.name}`, -cost, { category: "Недвижимость" });
    } else return json(res, 400, { error: "Неизвестное действие с недвижимостью" });
    broadcast(); return json(res, 200, snapshot(player));
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
    const interactionScore = clamp(Math.round(Number(body.interactionScore) || 0), 0, 100);
    const baseScore = player.skills[requirement.skill] + player.equipment[requirement.equipment];
    const score = baseScore + (interactionScore >= 88 ? 1 : 0);
    const previous = car.inspectionRecords[category];
    if (previous && baseScore <= previous.bestScore) return json(res, 400, { error: "Для повторной проверки сначала повысьте навык или оборудование" });
    const cost = 0;
    if (player.cash < cost) return json(res, 400, { error: "Не хватает денег на расходники" });
    player.cash -= cost;
    player.stats.inspections += 1;
    if (cost) car.invested += cost;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.discovered.includes(defect.code));
    for (const defect of found) if (!car.discovered.includes(defect.code)) car.discovered.push(defect.code);
    const confidence = Math.min(100, Math.round(baseScore / 6 * 85 + interactionScore * 0.15));
    car.inspectionRecords[category] = { bestScore: baseScore, attempts: (previous?.attempts || 0) + 1, confidence, foundCodes: found.map((defect) => defect.code), interactionScore };
    car.checkedCategories = Object.keys(car.inspectionRecords);
    addXp(player, 20 + newFound.length * 15 + (interactionScore >= 80 ? 8 : 0));
    if (cost) addLedger(player, "inspection", `Осмотр: ${car.model} · ${category}`, -cost, { carId: car.id, score: interactionScore, category: "Гараж" });
    broadcast();
    return json(res, 200, { ...snapshot(player), checkResult: { category, found: newFound.map((defect) => publicDefect(defect, car)), confidence, improvedFrom: previous?.bestScore || 0, canImprove: score < 6 } });
  }

  if (req.method === "POST" && pathname === "/api/market-check") {
    const car = market.find((item) => item.id === body.carId);
    const category = String(body.category || "");
    if (!car) return json(res, 404, { error: "Автомобиль уже ушёл с рынка" });
    if (!inspectionRequirements[category]) return json(res, 400, { error: "Неизвестная система автомобиля" });
    ensureCarDefaults(car);
    const requirement = inspectionRequirements[category];
    const interactionScore = clamp(Math.round(Number(body.interactionScore) || 0), 0, 100);
    const baseScore = player.skills[requirement.skill] + player.equipment[requirement.equipment];
    const score = baseScore + (interactionScore >= 88 ? 1 : 0);
    const previous = car.publicInspectionRecords[category];
    if (previous && baseScore <= previous.bestScore) return json(res, 400, { error: "Эту систему уже проверили на доступной глубине" });
    const cost = 0;
    if (player.cash < cost) return json(res, 400, { error: "Недостаточно средств на осмотр" });
    player.cash -= cost;
    player.stats.inspections += 1;
    const matching = car.defects.filter((defect) => defect.category === category && !defect.repaired);
    const found = matching.filter((defect) => score >= defect.skill + defect.equipmentLevel);
    const newFound = found.filter((defect) => !car.publicDiscovered.includes(defect.code));
    for (const defect of found) if (!car.publicDiscovered.includes(defect.code)) car.publicDiscovered.push(defect.code);
    const confidence = Math.min(100, Math.round(baseScore / 6 * 85 + interactionScore * 0.15));
    car.publicInspectionRecords[category] = { bestScore: baseScore, confidence, inspector: player.name, at: Date.now(), interactionScore };
    addXp(player, 12 + newFound.length * 10 + (interactionScore >= 80 ? 6 : 0));
    if (cost) addLedger(player, "inspection", `Предпродажный осмотр: ${car.model}`, -cost, { carId: car.id, score: interactionScore, category: "Рынок" });
    broadcast();
    return json(res, 200, { ...snapshot(player), checkResult: { category, found: newFound.map((defect) => publicDefect(defect, car)), confidence } });
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
    const mechanicDiscount = groupEmployeeRating(player, "mechanics") / 100 * (selfRepair ? 0.08 : 0.18);
    repairCost = Math.max(500, Math.round(repairCost * (1 - mechanicDiscount) / 500) * 500);
    let installedPart = null;
    if (body.partId) {
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
      installedPart = makeSpecificPart(car, defect, "analog", 100, "Поставлено сервисом");
      suppliedPartCost = Math.max(500, Math.round(installedPart.purchasePrice * 1.12 / 500) * 500);
      installedPart.purchasePrice = suppliedPartCost;
    }
    const totalCashCost = repairCost + suppliedPartCost;
    if (player.cash < totalCashCost) return json(res, 400, { error: `На ремонт и детали нужно ${totalCashCost.toLocaleString("ru-RU")} ₽` });
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
    defect.repaired = true;
    const partConditionFactor = installedPart ? 0.55 + installedPart.reliability / 200 : 1;
    const interactionBonus = selfRepair && interactionScore >= 85 ? 2 : selfRepair && interactionScore >= 65 ? 1 : 0;
    car.condition = Math.min(100, car.condition + Math.max(1, Math.round(defect.severity * 4 * partConditionFactor)) + interactionBonus);
    car.repairs.push(defect.name);
    if (installedPart) car.installedParts.push(installedPart);
    car.history.push({ type: "repair", text: `Ремонт: ${defect.name}${installedPart ? ` · ${installedPart.brand} ${installedPart.name}, ресурс ${installedPart.conditionPct}%, надёжность ${installedPart.reliability}%` : ""}`, at: Date.now() });
    if (selfRepair) player.stats.selfRepairs += 1;
    else if (assistedRepair) player.stats.assistedRepairs += 1;
    else player.stats.workshopRepairs += 1;
    addXp(player, (selfRepair ? 60 : assistedRepair ? 40 : 25) + defect.severity * 10 + (selfRepair ? Math.round(interactionScore / 10) : 0));
    addLedger(player, "repair", `Ремонт: ${car.model} · ${defect.name}`, -totalCashCost, { carId: car.id, score: selfRepair ? interactionScore : null, category: "Гараж" });
    // Repairs mutate nested part history; persist before responding so a restart cannot lose the installed component.
    persistState();
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

  if (req.method === "POST" && pathname === "/api/activity") {
    ensureActivityDefaults(player);
    const key = String(body.activity || "");
    const activity = activityCatalog[key];
    if (!activity) return json(res, 400, { error: "Активность не найдена" });
    if (player.activities.completed[key]) return json(res, 400, { error: "Эта активность уже выполнена сегодня" });
    const score = clamp(Number(body.score) || 0, 0, 100);
    const precision = 0.7 + score / 333;
    const mixedPortfolio = player.garage.length > 0 && player.ownedAssets.some((asset) => asset.type === "property") && player.ownedAssets.some((asset) => asset.type === "item");
    const portfolioBonus = key === "portfolio" && mixedPortfolio ? 1.35 : 1;
    const reward = Math.max(1000, Math.round(activity.reward * precision * portfolioBonus / 1000) * 1000);
    const xp = Math.max(10, Math.round(activity.xp * (0.75 + score / 400)));
    player.cash += reward;
    addXp(player, xp);
    player.activities.completed[key] = { score, reward, xp, at: Date.now(), mixedPortfolio };
    const completedCount = Object.keys(player.activities.completed).length;
    if (completedCount >= Object.keys(activityCatalog).length) {
      player.activities.streak += 1;
      player.activities.completed._bonus = { reward: 25000, xp: 100, at: Date.now() };
      player.cash += 25000; addXp(player, 100); player.skillPoints += 1;
      addLedger(player, "activity", "Полный круг ежедневных активностей", 25000, { category: "Активности" });
    }
    addLedger(player, "activity", `${activity.name} · точность ${score}%`, reward, { category: "Активности", xp });
    broadcast();
    return json(res, 200, snapshot(player));
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
    addLedger(player, "upgrade", `Улучшение: ${car.model} · ${upgrade.name}`, -upgradeCost, { carId: car.id, category: "Гараж" });
    broadcast(); return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/list") {
    const index = player.garage.findIndex((item) => item.id === body.carId);
    if (index < 0) return json(res, 404, { error: "Машины нет в гараже" });
    const price = Math.round(Number(body.price));
    if (!Number.isFinite(price) || price < 1 || price > MAX_VEHICLE_VALUE) return json(res, 400, { error: `Цена должна быть от 1 ₽ до ${MAX_VEHICLE_VALUE.toLocaleString("ru-RU")} ₽` });
    const car = player.garage[index];
    const saleType = body.saleType === "auction" ? "auction" : "fixed";
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
    if (car.saleType === "auction" && car.highestBidderId) return json(res, 400, { error: "Нельзя снять аукцион после первой ставки" });
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
    car.lastPlayerBidAt = Date.now();
    extendClosingAuction(car, "auctionEnd");
    if (previousPlayerId) notifyOutbid(previousPlayerId, "car", car.model, amount, car.id);
    player.stats.bids += 1;
    broadcast();
    return json(res, 200, snapshot(player));
  }

  if (req.method === "POST" && pathname === "/api/container/bid") {
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
    if (!Number.isFinite(amount) || amount < 1 || amount >= car.price) return json(res, 400, { error: "Предложение должно быть от 1 ₽ и ниже цены объявления" });
    if (amount > player.cash - reservedCash(player)) return json(res, 400, { error: "Свободных денег недостаточно: часть суммы зарезервирована в ставках" });
    for (const old of offers.values()) if (old.carId === car.id && old.buyerId === player.id && ["active", "counter"].includes(old.status)) old.status = "closed";
    if (!car.sellerId) {
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
