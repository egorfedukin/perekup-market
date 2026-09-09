"use strict";
/*
 * Синхронизация SQLite-базы игры с S3-совместимым объектным хранилищем (Cloud.ru Object Storage).
 * Зависимостей нет — только встроенные модули Node.js. Запросы подписываются по AWS Signature V4.
 *
 * Переменные окружения:
 *   PEREKUP_S3_ENDPOINT           — адрес хранилища (по умолчанию https://s3.cloud.ru)
 *   PEREKUP_S3_REGION             — регион (по умолчанию ru-central-1)
 *   PEREKUP_S3_BUCKET             — имя бакета (обязательно)
 *   PEREKUP_S3_ACCESS_KEY_ID      — Key ID доступа (обязательно; для Cloud.ru вид «tenant:keyid»)
 *   PEREKUP_S3_SECRET_ACCESS_KEY  — Key Secret (обязательно)
 *   PEREKUP_S3_KEY                — ключ объекта со снимком базы (по умолчанию game.db)
 *   PEREKUP_S3_FORCE_PATH_STYLE   — «1», чтобы обращаться как endpoint/bucket/key вместо bucket.endpoint/key
 *   PEREKUP_S3_SYNC_INTERVAL_MS   — период автосохранения (по умолчанию 60000, минимум 15000)
 *   PEREKUP_S3_TIMEOUT_MS         — таймаут запросов (по умолчанию 15000)
 *
 * CLI-режим (используется сервером через spawnSync, чтобы не блокировать событийный цикл):
 *   node s3-sync.js --fetch-to <путь>   — скачать снимок базы в файл (exit 1, если снимка нет)
 *   node s3-sync.js --push-file <путь>  — загрузить файл в хранилище как снимок базы
 */

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_ENDPOINT = "https://s3.cloud.ru";
const DEFAULT_REGION = "ru-central-1";

function readConfig(env = process.env) {
  let endpoint = String(env.PEREKUP_S3_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT;
  if (!/^https?:\/\//i.test(endpoint)) endpoint = `https://${endpoint}`;
  return {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: String(env.PEREKUP_S3_REGION || DEFAULT_REGION).trim() || DEFAULT_REGION,
    bucket: String(env.PEREKUP_S3_BUCKET || "").trim(),
    accessKeyId: String(env.PEREKUP_S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(env.PEREKUP_S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY || "").trim(),
    key: String(env.PEREKUP_S3_KEY || "game.db").replace(/^\/+/, ""),
    pathStyle: String(env.PEREKUP_S3_FORCE_PATH_STYLE || "") === "1",
    intervalMs: Math.max(15000, Number(env.PEREKUP_S3_SYNC_INTERVAL_MS) || 60000),
    timeoutMs: Math.max(3000, Number(env.PEREKUP_S3_TIMEOUT_MS) || 15000),
  };
}

function configured(config = readConfig()) {
  return Boolean(config.bucket && config.accessKeyId && config.secretAccessKey);
}

function describeTarget(config = readConfig()) {
  if (!configured(config)) return "выключено";
  return `${objectUrl(config, config.key)}`;
}

function objectUrl(config, key) {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  if (config.pathStyle) return `${config.endpoint}/${encodeURIComponent(config.bucket)}/${encodedKey}`;
  const parsed = new URL(config.endpoint);
  return `${parsed.protocol}//${config.bucket}.${parsed.host}/${encodedKey}`;
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

// Подпись одного запроса по AWS Signature V4. extraHeaders — дополнительные подписываемые заголовки
// (например, Range). Возвращает опции для http/https.request.
function signRequest({ method, url, config, body = Buffer.alloc(0), contentType = null, amzDate = null, extraHeaders = {} }) {
  const target = new URL(url);
  const date = amzDate || new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = date.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headerEntries = [];
  if (contentType) headerEntries.push(["content-type", contentType]);
  for (const [name, value] of Object.entries(extraHeaders)) headerEntries.push([name.toLowerCase(), String(value)]);
  headerEntries.push(["host", target.host]);
  headerEntries.push(["x-amz-content-sha256", payloadHash]);
  headerEntries.push(["x-amz-date", date]);
  headerEntries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const canonicalHeaders = headerEntries.map(([name, value]) => `${name}:${value.trim()}\n`).join("");
  const signedHeaders = headerEntries.map(([name]) => name).join(";");
  const canonicalRequest = [method, target.pathname, target.search.replace(/^\?/, ""), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), config.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const headers = { Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  for (const [name, value] of headerEntries) {
    if (name === "host") continue;
    headers[name === "content-type" ? "Content-Type" : name] = value;
  }
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port ? Number(target.port) : undefined,
    path: `${target.pathname}${target.search}`,
    method,
    headers,
  };
}

function request(options, body, timeoutMs) {
  const transport = options.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`таймаут запроса ${timeoutMs} мс`)));
    req.on("error", reject);
    if (body && body.length) req.write(body);
    req.end();
  });
}

function errorXmlCode(body) {
  const match = /<Code>([^<]+)<\/Code>/.exec(String(body || ""));
  return match ? match[1] : "";
}

// Скачивает снимок базы. null — снимка нет (404/NoSuchKey) или S3 не настроен.
async function fetchSnapshot(config = readConfig()) {
  if (!configured(config)) return null;
  const options = signRequest({ method: "GET", url: objectUrl(config, config.key), config });
  const res = await request(options, null, config.timeoutMs);
  if (res.status === 200) return res.body;
  const code = errorXmlCode(res.body);
  if (res.status === 404 || code === "NoSuchKey") return null;
  if (res.status === 403 && code === "AccessDenied") return null; // снимка нет, а права на листинг не выданы
  if (code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId" || code === "AccessDenied") {
    throw new Error(`S3 отклонил запрос (${code}) — проверьте PEREKUP_S3_ACCESS_KEY_ID и PEREKUP_S3_SECRET_ACCESS_KEY`);
  }
  throw new Error(`S3 GET ${config.key}: HTTP ${res.status}${code ? ` ${code}` : ""}`);
}

async function pushSnapshot(buffer, config = readConfig()) {
  const options = signRequest({ method: "PUT", url: objectUrl(config, config.key), config, body: buffer, contentType: "application/octet-stream" });
  const res = await request(options, buffer, config.timeoutMs);
  if (res.status < 200 || res.status >= 300) {
    const code = errorXmlCode(res.body);
    if (code === "SignatureDoesNotMatch" || code === "InvalidAccessKeyId" || code === "AccessDenied") {
      throw new Error(`S3 отклонил запрос (${code}) — проверьте ключи доступа и права на запись в бакет`);
    }
    throw new Error(`S3 PUT ${config.key}: HTTP ${res.status}${code ? ` ${code}` : ""}`);
  }
  return true;
}

function runCli(command, targetPath, { timeoutMs = 15000 } = {}) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "s3-sync.js"), command, targetPath], { timeout: timeoutMs, encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (result.error) return { code: 3, error: result.error.message, output };
  if (result.status === null) return { code: 3, error: `дочерний процесс завершён сигналом ${result.signal || "unknown"}`, output };
  return { code: result.status, output };
}

// Синхронное восстановление снимка в targetPath (вызывается до открытия базы).
// Возвращает { restored: true } либо причину отказа.
function restoreSync(targetPath, options = {}) {
  if (!configured()) return { configured: false };
  const tempPath = `${targetPath}.restore`;
  try { fs.rmSync(tempPath, { force: true }); } catch {}
  const result = runCli("--fetch-to", tempPath, options);
  if (result.code !== 0) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    if (result.code === 1) return { missing: true };
    return { error: result.output || `код ${result.code}` };
  }
  if (!fs.existsSync(tempPath)) return { error: "снимок не сохранён" };
  try {
    fs.renameSync(tempPath, targetPath);
    return { restored: true };
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    return { error: error.message };
  }
}

// Синхронная выгрузка файла снимка (вызывается при остановке сервера).
function pushFileSync(snapshotPath, options = {}) {
  if (!configured()) return { configured: false };
  if (!fs.existsSync(snapshotPath)) return { error: "файл снимка не найден" };
  const result = runCli("--push-file", snapshotPath, options);
  if (result.code === 0) return { pushed: true };
  return { error: result.output || `код ${result.code}` };
}

module.exports = { readConfig, configured, describeTarget, objectUrl, signRequest, fetchSnapshot, pushSnapshot, restoreSync, pushFileSync };

if (require.main === module) {
  const [command, targetArg] = process.argv.slice(2);
  const config = readConfig();
  (async () => {
    if (!configured(config)) {
      console.error("S3_SYNC_NOT_CONFIGURED: задайте PEREKUP_S3_BUCKET, PEREKUP_S3_ACCESS_KEY_ID и PEREKUP_S3_SECRET_ACCESS_KEY");
      process.exit(2);
    }
    if (command === "--fetch-to" && targetArg) {
      const buffer = await fetchSnapshot(config);
      if (!buffer) {
        console.log("S3_SNAPSHOT_MISSING");
        process.exit(1);
      }
      fs.writeFileSync(targetArg, buffer);
      console.log(`S3_SNAPSHOT_SAVED: ${buffer.length} байт`);
      process.exit(0);
    }
    if (command === "--push-file" && targetArg) {
      const buffer = fs.readFileSync(targetArg);
      await pushSnapshot(buffer, config);
      console.log(`S3_SNAPSHOT_PUSHED: ${buffer.length} байт`);
      process.exit(0);
    }
    console.error("Использование: node s3-sync.js --fetch-to <путь> | --push-file <путь>");
    process.exit(2);
  })().catch((error) => {
    console.error(`S3_SYNC_ERROR: ${error.message}`);
    process.exit(3);
  });
}
