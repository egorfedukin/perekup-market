"use strict";
// Сквозной тест персистентности через S3:
// регистрация → остановка сервера (финальная выгрузка снимка) → удаление локальной базы
// (имитация эфемерной файловой системы Container Apps) → новый запуск → вход под сохранённым аккаунтом.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "perekup-s3-e2e-"));
const dataDir = path.join(workdir, "data");
const storeDir = path.join(workdir, "mock-store");
fs.mkdirSync(storeDir, { recursive: true });
const port = 4400 + (process.pid % 400);
const base = `http://localhost:${port}`;
const suffix = Date.now().toString().slice(-6);
const playerName = `S3Keeper${suffix}`;
const playerPassword = "TestPass123!";

const mockScript = `
  const http = require("http");
  const fs = require("fs");
  const storeDir = ${JSON.stringify(storeDir)};
  const server = http.createServer((req, res) => {
    const key = req.url.replace(/^\\//, "").split("/").map(encodeURIComponent).join("/");
    const file = require("path").join(storeDir, key);
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          require("fs").mkdirSync(require("path").dirname(file), { recursive: true });
          require("fs").writeFileSync(file, Buffer.concat(chunks));
          res.writeHead(200); res.end();
        } catch (error) { res.writeHead(500); res.end(String(error.message)); }
      });
      return;
    }
    if (req.method === "GET") {
      if (!fs.existsSync(file)) { res.writeHead(404); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
      res.writeHead(200); return res.end(fs.readFileSync(file));
    }
    res.writeHead(405); res.end();
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port)));
`;

function wait(buffer, marker) { return buffer.includes(marker); }

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: {
        ...process.env,
        PORT: String(port),
        PEREKUP_DATA_DIR: dataDir,
        PEREKUP_S3_ENDPOINT: `http://127.0.0.1:${mockPort}`,
        PEREKUP_S3_BUCKET: "test-bucket",
        PEREKUP_S3_ACCESS_KEY_ID: "tenant:key",
        PEREKUP_S3_SECRET_ACCESS_KEY: "secret",
        PEREKUP_S3_KEY: "game.db",
        PEREKUP_S3_FORCE_PATH_STYLE: "1",
        PEREKUP_S3_TIMEOUT_MS: "8000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    const timer = setTimeout(() => reject(new Error(`сервер не стартовал за 20 с. Логи:\n${logs}`)), 20000);
    child.stdout.on("data", (chunk) => { logs += chunk; });
    child.stderr.on("data", (chunk) => { logs += chunk; });
    const poll = setInterval(() => {
      if (wait(logs, "Perekup Market:")) { clearInterval(poll); clearTimeout(timer); resolve({ child, logs: () => logs }); }
    }, 100);
    child.on("exit", (code) => { clearInterval(poll); clearTimeout(timer); reject(new Error(`сервер упал при старте (код ${code}). Логи:\n${logs}`)); });
  });
}

function stopServer(handle) {
  return new Promise((resolve) => {
    const { child } = handle;
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 15000).unref();
  });
}

async function request(pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  return { status: response.status, data };
}

function fail(message) { console.error(`FAIL: ${message}`); process.exit(1); }

let mockPort = 0;
let mock = null;

(async () => {
  mock = spawn(process.execPath, ["-e", mockScript], { stdio: ["ignore", "pipe", "pipe"] });
  mockPort = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`мок S3 не отдал порт: ${output}`)), 10000);
    mock.stdout.on("data", (chunk) => { output += chunk; const value = Number(output.trim()); if (/^\d+$/.test(output.trim())) { clearTimeout(timer); resolve(value); } });
    mock.on("exit", () => { clearTimeout(timer); reject(new Error("мок S3 упал")); });
  });
  console.log(`мок S3 на порту ${mockPort}`);

  let handle = await startServer();
  const joined = await request("/api/join", { name: playerName });
  if (joined.status !== 200 || !joined.data.player?.id) fail(`вход в игру не прошёл: ${JSON.stringify(joined.data)}`);
  const playerId = joined.data.player.id;
  console.log(`игрок ${playerName} создан (${playerId})`);

  await stopServer(handle);
  const snapshotFile = path.join(storeDir, "test-bucket", "game.db");
  if (!fs.existsSync(snapshotFile)) fail("после SIGTERM снимок базы не попал в хранилище");
  const snapshotSize = fs.statSync(snapshotFile).size;
  if (snapshotSize < 1000) fail(`снимок подозрительно мал (${snapshotSize} байт)`);
  console.log(`финальная выгрузка в S3: ${snapshotSize} байт`);

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("локальная файловая система стёрта (новый контейнер)");

  handle = await startServer();
  const logs = handle.logs();
  if (!wait(logs, "S3_RESTORE_OK")) fail(`база не восстановилась из S3. Логи:\n${logs}`);
  console.log("база восстановлена из S3");

  const health = await request("/api/health");
  if (health.status !== 200) fail(`health после восстановления недоступен: ${JSON.stringify(health.data)}`);
  await stopServer(handle);

  const { DatabaseSync } = require("node:sqlite");
  const probe = new DatabaseSync(path.join(dataDir, "game.db"));
  const row = probe.prepare("SELECT payload FROM game_state WHERE id = 1").get();
  probe.close();
  const state = JSON.parse(row.payload);
  const restored = (state.players || []).some(([, player]) => player.id === playerId && player.name === playerName);
  if (!restored) fail(`игрок ${playerName} не найден в восстановленной базе`);
  console.log(`игрок ${playerName} на месте в восстановленной базе`);

  console.log("\nOK: персистентность через S3 работает (перезапуск контейнера с чистой ФС переживает)");
  try { mock.kill("SIGKILL"); } catch {}
  process.exit(0);
})().catch((error) => { console.error(error); try { mock && mock.kill("SIGKILL"); } catch {} process.exit(1); });
