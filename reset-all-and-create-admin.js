const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const login = "federuk";
const email = "fedukinegor@gmail.com";
const password = process.env.ADMIN_INITIAL_PASSWORD;
if (!password || !/^[A-Za-z0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>/?`~]{8,72}$/.test(password)) throw new Error("Задайте ADMIN_INITIAL_PASSWORD с 8–72 ASCII-символами");
const dataDir = process.env.PEREKUP_DATA_DIR ? path.resolve(process.env.PEREKUP_DATA_DIR) : path.join(__dirname, "data");
const dbPath = path.join(dataDir, "game.db");
if (!fs.existsSync(dbPath)) throw new Error(`База не найдена: ${dbPath}`);
const db = new DatabaseSync(dbPath);
const row = db.prepare("SELECT payload FROM game_state WHERE id = 1").get();
if (!row) throw new Error("Состояние игры не найдено");
const salt = crypto.randomBytes(16).toString("hex");
const hash = crypto.scryptSync(password, salt, 64).toString("hex");
const admin = {
  id: `player_admin_${crypto.randomBytes(8).toString("hex")}`, name: login, normalizedName: login,
  email, passwordSalt: salt, passwordHash: hash, emailVerified: true, pinSalt: null, pinHash: null,
  cash: 650000, profit: 0, deals: 0, garage: [], xp: 0, skillPoints: 1, skills: {}, equipment: {},
  garageCapacity: 4, parts: { common: 0, premium: 0 }, groupId: null, groupRole: null,
  stats: {}, ownedAssets: [], businesses: [], plateInventory: [], notifications: [], reputation: { score: 50, completed: 0, failed: 0 }
};
const empty = { players: [[admin.id, admin]], sessions: [], emailVerifications: [], passwordResets: [], market: [], offers: [], salesHistory: [], marketIndices: {}, chatMessages: [], directMessages: [], moderationReports: [], assetMarket: [], groups: [], partsMarket: [], partsSalesHistory: [], plateMarket: [], partIndices: {}, paymentOrders: [], containerAuctions: [], clothingCrafts: [], clothingMarket: [], itemContainerAuctions: [], cryptoHistory: [], vehiclePricingVersion: 0 };
db.prepare("UPDATE game_state SET payload = ?, updated_at = ? WHERE id = 1").run(JSON.stringify(empty), Date.now());
db.close();
console.log(`Полный сброс выполнен. Создан подтверждённый администратор: ${login} (${email}).`);
