'use strict';
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'market-auth-'));
const port = 6500 + process.pid % 300;
let server;
async function start() {
  server = spawn(process.execPath, ['server.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), PEREKUP_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Server timeout')), 15000);
    server.stdout.on('data', data => { if (String(data).includes('Perekup Market:')) { clearTimeout(timer); resolve(); } });
    server.once('error', error => { clearTimeout(timer); reject(error); });
  });
}
async function stop() {
  if (server && server.exitCode === null) await new Promise(resolve => { server.once('exit', resolve); server.kill(); });
}
async function request(url, token, body, expected = 200) {
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  assert.equal(response.status, expected, `${url}: ${data.error}`);
  return data;
}
async function run() {
  await start();
  await request('/api/login', null, { name: 'marketadmin', password: 'wrong-password' }, 401);
  const login = await request('/api/login', null, { name: 'marketadmin', password: 'MarketAdmin2026!' });
  const state = await request('/api/state', login.token);
  assert.equal(state.player.id, login.player.id);
  await request('/api/profile/appearance', login.token, { cosmeticId: 'workshop' });
  await request('/api/state', 'invalid-session', null, 401);
  const guest = await request('/api/join', null, { name: 'SessionRegression' });
  await request('/api/profile/appearance', guest.token, { cosmeticId: 'workshop' });
  await stop();
  await start();
  assert.equal((await request('/api/state', login.token)).player.id, login.player.id);
  assert.equal((await request('/api/state', guest.token)).player.id, guest.player.id);
  const again = await request('/api/login', null, { name: 'marketadmin', password: 'MarketAdmin2026!' });
  assert.equal(again.player.id, login.player.id);
  await request('/api/profile/appearance', again.token, { cosmeticId: 'workshop' });
  console.log('PASS: first admin login, actions, repeated login, persisted admin and guest sessions, invalid credentials');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await stop(); fs.rmSync(directory, { recursive: true, force: true }); });
