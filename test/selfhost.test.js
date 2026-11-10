import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { createCollector, origin } from '../server/http.js';
import { LocalState, importPublic } from '../server/state.js';

const temporary = [], applications = [];
function directory() { const result = mkdtempSync(join(tmpdir(), 'bdl-selfhost-')); temporary.push(result); return result; }
async function start(options = {}) {
  const app = createCollector({ directory: directory(), timers: false, ...options });
  applications.push(app);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  app.url = 'http://127.0.0.1:' + app.server.address().port;
  return app;
}
afterEach(async () => {
  for (const app of applications.splice(0)) if (app.server.listening) await app.close();
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const key = '17'.repeat(32), secondKey = '28'.repeat(32);
const auth = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
const report = { v: '2.5.6', board: 'esp32-headless', hashrate: 1e6, every: 300, coin: 'BTC' };
const privateReport = { ...report, id: '0123456789abcdef', name: 'Atelier', boot_id: 'aabbccdd',
  uptime_s: 600, total_hashes: 6e8, temp_c: 45, accepted: 2, rejected: 0, best: 50,
  power_percent: 100, pool_connected: true, pool: 'other', firmware_trial: false };
const post = (app, path, body, headers = {}) => fetch(app.url + path,
  { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('native HTTP uses the existing public contract and survives a process restart', async () => {
  const dir = directory(); let app = await start({ directory: dir });
  const health = await (await fetch(app.url + '/healthz')).json();
  assert.equal(health.service, 'bdlminer-stats'); assert.equal(health.storage, 'sqlite');
  assert.equal((await post(app, '/report', report, { 'CF-Connecting-IP': 'spoofed' })).status, 204);
  const response = await fetch(app.url + '/api/summary');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  const before = await response.json(); assert.equal(before.miners, 1); assert.equal(before.hashrate, 1e6);
  assert.equal(before.periods[168].expected_samples, 2016);
  assert.equal(app.state.store.addresses.size, 0);
  await app.close(); app = await start({ directory: dir });
  const after = await (await fetch(app.url + '/api/summary')).json();
  assert.equal(after.hashrate, before.hashrate); assert.equal(after.miners, before.miners);
  assert.equal(statSync(join(dir, 'public.sqlite')).mode & 0o777, 0o600);
});

test('a TCP relay neither conflates firmware versions nor gives all miners one IP quota', () => {
  const state = new LocalState(directory());
  try {
    for (let i = 0; i < 450; i++) assert.equal(state.publicAdapter.add({ ...report, v: i % 2 ? '2.5.4' : '2.5.6' }), true);
    assert.equal(state.summary().miners, 450);
    assert.equal(state.store.addresses.size, 0);
  } finally { state.close(); }
});

test('private spaces, histories, CORS and revocation survive cache eviction and restart', async () => {
  const dir = directory(); let app = await start({ directory: dir, maxOpen: 1 });
  assert.equal((await fetch(app.url + '/api/remote')).status, 401);
  assert.equal((await post(app, '/api/remote/report', privateReport, auth)).status, 204);
  assert.equal((await post(app, '/api/remote/report', { ...privateReport, name: 'Second' },
    { ...auth, Authorization: 'Bearer ' + secondKey })).status, 204);
  const originHeaders = { ...auth, Origin: 'https://miner.bdl-pool.com' };
  let response = await fetch(app.url + '/api/remote', { headers: originHeaders });
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), originHeaders.Origin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).miners[0].name, 'Atelier');
  const history = await (await fetch(app.url + '/api/remote/history?miner=' + privateReport.id + '&hours=24', { headers: auth })).json();
  assert.equal(history.summary.reports, 1); assert.equal(history.summary.average, 1e6);
  assert.equal((await post(app, '/api/remote/report', privateReport, { ...auth, Origin: originHeaders.Origin })).status, 403);
  assert.equal((await fetch(app.url + '/api/remote', { headers: { ...auth, Origin: 'https://evil.test' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/remote', { method: 'OPTIONS', headers: { Origin: originHeaders.Origin,
    'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 204);
  assert.equal((await fetch(app.url + '/api/remote', { headers: auth, method: 'DELETE' })).status, 204);
  await app.close(); app = await start({ directory: dir, maxOpen: 1 });
  assert.equal((await fetch(app.url + '/api/remote', { headers: auth })).status, 410);
  assert.equal((await post(app, '/api/remote/report', privateReport, auth)).status, 410);
  response = await fetch(app.url + '/api/remote', { headers: { Authorization: 'Bearer ' + secondKey } });
  assert.equal((await response.json()).miners[0].name, 'Second');
  const publicData = await (await fetch(app.url + '/api/summary')).json();
  assert.equal(publicData.miners, 0); assert.equal(publicData.hashrate, 0);
});

test('unknown authenticated reads do not allocate files; writes are bounded', async () => {
  const dir = directory(), app = await start({ directory: dir, maxSpaces: 1 });
  assert.deepEqual((await (await fetch(app.url + '/api/remote', { headers: auth })).json()).miners, []);
  assert.deepEqual(readdirSync(join(dir, 'private')), []);
  assert.equal((await post(app, '/api/remote/report', privateReport, auth)).status, 204);
  assert.equal((await post(app, '/api/remote/report', privateReport, { ...auth, Authorization: 'Bearer ' + secondKey })).status, 503);
  assert.equal(readdirSync(join(dir, 'private')).filter(name => name.endsWith('.sqlite')).length, 1);
});

test('native admission limits, encoded and oversized bodies fail without storing reports', async () => {
  const app = await start();
  assert.equal((await post(app, '/report', { ...report, padding: 'x'.repeat(1024) })).status, 413);
  assert.equal((await post(app, '/report', report, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal((await post(app, '/report', { ...report, hashrate: -1 })).status, 400);
  assert.equal((await (await fetch(app.url + '/api/summary')).json()).miners, 0);
  const limited = await start({ reportsPerMinute: 1 });
  assert.equal((await post(limited, '/report', report)).status, 204);
  const refused = await post(limited, '/report', report);
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('Retry-After'), '60');
});

test('bootstrap preserves real five-minute data, older hourly charts and records without inventing finer samples', () => {
  const dir = directory(), now = Math.floor(Date.now() / 3600000) * 3600000;
  const snapshot = { at: now, recent: [
    { at: now - 600000, hashrate: 2e6, miners: 2, average_miners: 1.5, samples: 1, interval_ms: 300000 },
    { at: now - 300000, hashrate: 4e6, miners: 4, samples: 1, interval_ms: 300000 },
    { at: now, hashrate: 9e6, miners: 9, live: true },
    { at: now - 1000, hashrate: 99e6, miners: 99, samples: 1, interval_ms: 300000 },
  ], history: [{ at: now - 2 * 3600000, end_at: now - 3600000, hashrate: 8e6, miners: 8, samples: 12 }],
  record: { at: now - 86400000, hashrate: 10e6 } };
  writeFileSync(join(dir, 'legacy-summary.json'), JSON.stringify(snapshot));
  let state = new LocalState(dir);
  let result = state.summary(now);
  assert.equal(result.hashrate, 0, 'historical reports never become live miners');
  assert.equal(result.history[0].hashrate, 8e6);
  assert.equal(result.periods[168].samples, 3, 'two imported samples plus the genuine empty current bucket');
  assert.equal(result.periods[168].expected_samples, 2016);
  assert.equal(result.record.hashrate, 10e6);
  assert.equal(state.publicSQL.exec('SELECT miners FROM samples WHERE t=?', now - 600000).toArray()[0].miners, 1.5);
  state.close(); state = new LocalState(dir);
  try {
    result = state.summary(now); assert.equal(result.record.hashrate, 10e6);
    assert.throws(() => importPublic(state.store, { at: Infinity, recent: [], history: [] }), /Invalid/);
  } finally { state.close(); }
});

test('maintenance expires unread private readings while preserving revocations', async () => {
  const app = await start();
  await post(app, '/api/remote/report', privateReport, auth);
  const [id] = app.state.spaces;
  const store = app.state.privateStore(id);
  store.sql.exec('UPDATE miners SET at=?', Date.now() - 8 * 86400000);
  store.sql.exec('UPDATE readings SET t=?', Date.now() - 8 * 86400000);
  app.state.prune(); assert.deepEqual(store.snapshot().miners, []);
  await fetch(app.url + '/api/remote', { headers: auth, method: 'DELETE' });
  app.state.prune(); assert.equal((await fetch(app.url + '/api/remote', { headers: auth })).status, 410);
});

test('public API origins cannot downgrade TLS or carry credentials or paths', () => {
  assert.equal(origin('https://api.bdl-pool.com:36018'), 'https://api.bdl-pool.com:36018');
  for (const value of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/'])
    assert.throws(() => origin(value));
});

test('daily backup includes committed WAL data, excludes private readings and prunes only old public backups', () => {
  const dir = directory(), backups = join(directory(), 'backups');
  const state = new LocalState(dir);
  try {
    state.publicAdapter.add(report);
    state.privateStore('aa'.repeat(32), true).add(privateReport);
    const old = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
    // The script must create its own protected destination directory.
    execFileSync(process.execPath, ['server/backup.js'], { env: { ...process.env, STATS_DATA: dir, STATS_BACKUPS: backups } });
    writeFileSync(join(backups, 'public-' + old + '.sqlite'), 'old');
    writeFileSync(join(backups, 'keep.txt'), 'unrelated');
    execFileSync(process.execPath, ['server/backup.js'], { env: { ...process.env, STATS_DATA: dir, STATS_BACKUPS: backups } });
    const files = readdirSync(backups);
    assert.ok(files.includes('keep.txt'));
    assert.ok(!files.includes('public-' + old + '.sqlite'));
    const backup = join(backups, files.find(name => name.endsWith('.sqlite')));
    const restored = new DatabaseSync(backup, { readOnly: true });
    try {
      const live = JSON.parse(restored.prepare("SELECT value FROM state WHERE key='live'").get().value);
      assert.equal(live[0].hashrate, 1e6);
      assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('miners','readings')").get().n, 0);
    } finally { restored.close(); }
    assert.equal(statSync(backup).mode & 0o777, 0o600);
  } finally { state.close(); }
});
