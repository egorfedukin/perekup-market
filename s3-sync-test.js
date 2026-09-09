"use strict";
// Тесты s3-sync.js: корректность подписи AWS SigV4 (эталон из документации AWS)
// и полный цикл «выгрузка — восстановление» через локальный мок S3-хранилища.

const assert = require("assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const s3Sync = require("./s3-sync");

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok — ${name}`); }
  catch (error) { failures += 1; console.error(`FAIL — ${name}: ${error.message}`); }
}

// 1. Подпись должна совпадать с эталонным примером «GET Object» из AWS Signature V4 docs.
check("sigv4 соответствует эталону AWS", () => {
  const config = {
    endpoint: "https://s3.amazonaws.com",
    region: "us-east-1",
    bucket: "examplebucket",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    key: "test.txt",
    pathStyle: false,
  };
  const options = s3Sync.signRequest({
    method: "GET",
    url: "https://examplebucket.s3.amazonaws.com/test.txt",
    config,
    amzDate: "20130524T000000Z",
    extraHeaders: { Range: "bytes=0-9" },
  });
  assert.strictEqual(options.headers["x-amz-date"], "20130524T000000Z");
  assert.strictEqual(options.headers["x-amz-content-sha256"], "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.match(options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20130524\/us-east-1\/s3\/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

// 2. Адресация объекта: виртуальные хосты по умолчанию, path-style по флагу.
check("objectUrl: virtual-hosted и path-style", () => {
  const virtual = s3Sync.objectUrl({ endpoint: "https://s3.cloud.ru", bucket: "my-bucket", pathStyle: false }, "game.db");
  assert.strictEqual(virtual, "https://my-bucket.s3.cloud.ru/game.db");
  const pathStyle = s3Sync.objectUrl({ endpoint: "https://s3.cloud.ru", bucket: "my-bucket", pathStyle: true }, "perekup/game.db");
  assert.strictEqual(pathStyle, "https://s3.cloud.ru/my-bucket/perekup/game.db");
});

// 3. Полный цикл через мок S3: push-file сохраняет объект с подписанным запросом, fetch-to возвращает байты.
// Мок-сервер запускаем отдельным процессом: родитель блокируется в spawnSync и не смог бы обслуживать соединения.
async function roundtrip() {
  const mockScript = `
    const http = require("http");
    const stored = new Map();
    const server = http.createServer((req, res) => {
      const key = req.url;
      if (req.method === "PUT") {
        if (!/^AWS4-HMAC-SHA256 /.test(req.headers.authorization || "")) { res.writeHead(401); return res.end("<Error><Code>AccessDenied</Code></Error>"); }
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => { stored.set(key, Buffer.concat(chunks)); res.writeHead(200); res.end(); });
        return;
      }
      if (req.method === "GET") {
        if (!stored.has(key)) { res.writeHead(404); return res.end("<Error><Code>NoSuchKey</Code></Error>"); }
        res.writeHead(200); return res.end(stored.get(key));
      }
      res.writeHead(405); res.end();
    });
    server.listen(0, "127.0.0.1", () => { process.stdout.write(String(server.address().port)); });
  `;
  const mock = require("child_process").spawn(process.execPath, ["-e", mockScript], { stdio: ["ignore", "pipe", "pipe"] });
  let mockStderr = "";
  mock.stderr.on("data", (chunk) => { mockStderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`мок-сервер не отдал порт: ${output} ${mockStderr}`)), 10000);
    mock.stdout.on("data", (chunk) => {
      output += chunk;
      const parsed = Number(output.trim());
      if (/^\d+$/.test(output.trim())) { clearTimeout(timer); resolve(parsed); }
    });
    mock.on("exit", (code) => { clearTimeout(timer); reject(new Error(`мок-сервер упал (код ${code}): ${mockStderr}`)); });
  });
  const env = {
    ...process.env,
    PEREKUP_S3_ENDPOINT: `http://127.0.0.1:${port}`,
    PEREKUP_S3_BUCKET: "test-bucket",
    PEREKUP_S3_ACCESS_KEY_ID: "tenant:key",
    PEREKUP_S3_SECRET_ACCESS_KEY: "secret",
    PEREKUP_S3_KEY: "game.db",
    PEREKUP_S3_FORCE_PATH_STYLE: "1",
    PEREKUP_S3_TIMEOUT_MS: "5000",
  };
  try {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "perekup-s3-test-"));
    const dbFile = path.join(workdir, "game.db");
    fs.writeFileSync(dbFile, Buffer.from("perekup-sqlite-payload-123"));

    const beforeFetch = spawnSync(process.execPath, [path.join(__dirname, "s3-sync.js"), "--fetch-to", path.join(workdir, "restore.db")], { env, encoding: "utf8" });
    assert.strictEqual(beforeFetch.status, 1, "пока снимка нет, fetch-to должен вернуть код 1");

    const push = spawnSync(process.execPath, [path.join(__dirname, "s3-sync.js"), "--push-file", dbFile], { env, encoding: "utf8" });
    assert.strictEqual(push.status, 0, `push-file должен пройти: ${push.stdout} ${push.stderr}`);

    const fetch = spawnSync(process.execPath, [path.join(__dirname, "s3-sync.js"), "--fetch-to", path.join(workdir, "restore.db")], { env, encoding: "utf8" });
    assert.strictEqual(fetch.status, 0, `fetch-to должен пройти: ${fetch.stdout} ${fetch.stderr}`);
    assert.strictEqual(fs.readFileSync(path.join(workdir, "restore.db")).toString(), "perekup-sqlite-payload-123", "байты снимка должны совпасть");
    console.log("ok — roundtrip push/fetch через мок S3");
  } finally {
    try { process.kill(mock.pid, "SIGKILL"); } catch {}
  }
}

(async () => {
  await roundtrip();
  if (failures) { console.error(`\n${failures} проверок не прошло`); process.exit(1); }
  console.log("\nВсе проверки s3-sync пройдены");
})().catch((error) => { console.error(error); process.exit(1); });
