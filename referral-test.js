"use strict";
// Тест реферальной системы: промокод при входе, бонусы обоим, статистика для админа.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const port = 4500 + (process.pid % 400);
const base = `http://localhost:${port}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "perekup-ref-"));
let server;
let failures = 0;

function check(value, message) { if (!value) { failures += 1; console.error(`FAIL: ${message}`); } else console.log(`ok — ${message}`); }

function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const timeout = setTimeout(() => reject(new Error(`сервер не стартовал:\n${logs}`)), 20000);
    server.stdout.on("data", (chunk) => { logs += chunk; if (logs.includes("Perekup Market:")) { clearTimeout(timeout); resolve(); } });
    server.stderr.on("data", (chunk) => { logs += chunk; });
    server.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`сервер упал (код ${code}):\n${logs}`)); });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    server.once("exit", resolve);
    server.kill("SIGTERM");
    setTimeout(() => { try { server.kill("SIGKILL"); } catch {} resolve(); }, 10000).unref();
  });
}

async function request(pathname, body, token) {
  const response = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

(async () => {
  await startServer();
  try {
    // Админ (federuk автоматически получает админку при входе) и обычный игрок
    const admin = await request("/api/join", { name: "federuk" });
    check(admin.status === 200 && admin.data.token, "админ вошёл");
    check(/^[A-Z2-9]{7}$/.test(admin.data.player.referral?.code || ""), `промокод сгенерирован: ${admin.data.player.referral?.code}`);

    const friend = await request("/api/join", { name: "Drug", promo: admin.data.player.referral.code });
    check(friend.status === 200 && friend.data.referralApplied === true, "промокод применён при входе");
    check(friend.data.player.cash === 650000 + 50000, `новичок получил бонус: ${friend.data.player.cash}`);
    check(friend.data.player.referral.invitedBy === "federuk", "новичок видит, кто его пригласил");

    const stranger = await request("/api/join", { name: "Neznatok", promo: "XXXXXXX" });
    check(stranger.status === 200 && stranger.data.referralApplied === false && stranger.data.referralInvalid === true, "несуществующий промокод отклонён, вход не заблокирован");
    check(stranger.data.player.cash === 650000, "бонус за неверный промокод не начислен");

    // После перезапуска бонусы и счётчики должны сохраниться (сессия живёт в базе)
    await stopServer();
    await startServer();

    const adminAgain = await request("/api/state", null, admin.data.token);
    check(adminAgain.status === 200, "сессия пригласившего восстановилась после рестарта");
    check(adminAgain.data.player.cash === 650000 + 50000, `бонус пригласившему сохранён после рестарта: ${adminAgain.data.player.cash}`);
    check(adminAgain.data.player.referral.invited === 1 && adminAgain.data.player.referral.earned === 50000, "счётчики приглашений сохранены");

    const state = await request("/api/admin/state", null, admin.data.token);
    check(state.status === 200, "админ-статус доступен");
    check(state.data.referrals.total === 1 && state.data.referrals.paid === 50000, `сводка рефералов: пришло ${state.data.referrals.total}, выплачено ${state.data.referrals.paid}`);
    const topRow = (state.data.referrals.top || [])[0];
    check(topRow && topRow.name === "federuk" && topRow.count === 1 && topRow.code === admin.data.player.referral.code, "таблица промокодов: federuk, 1 приглашённый");
    check((topRow.recent || []).some((item) => item.name === "Drug"), "в таблице видно, кто пришёл");
    const playerRow = state.data.players.find((item) => item.name === "Drug");
    check(playerRow && playerRow.referredBy === "federuk", "в списке игроков видно пригласившего");

    // Статистика промокодов недоступна обычному игроку
    const denied = await request("/api/admin/state", null, friend.data.token);
    check(denied.status === 403, "статистика промокодов недоступна обычному игроку");
  } finally {
    await stopServer();
  }
  if (failures) { console.error(`\n${failures} проверок не прошло`); process.exit(1); }
  console.log("\nВсе проверки реферальной системы пройдены");
})().catch((error) => { console.error(error); process.exit(1); });
