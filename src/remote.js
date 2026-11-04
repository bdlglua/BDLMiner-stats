// Opt-in personal telemetry. Each 256-bit access key has a separate Durable
// Object; only its SHA-256 digest is used as an object name. No key is stored.
import { parseReport } from './store.js';
import { validCoin } from './coins.js';
import { validPool } from './pools.js';

export const REMOTE_KEEP = 7 * 86400000;
export const REMOTE_INTERVAL = 300;
export const REMOTE_LIMIT = 32;
const integer = (n, max = 0xffffffff) => Number.isInteger(n) && n >= 0 && n <= max;
const finite = (n, max = 1e30) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
const text = (s, size) => typeof s === 'string' && s.length > 0 && s.length <= size && !/[\x00-\x1f\x7f]/.test(s);

export function parseRemote(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { id, name, board, v, coin, boot_id, uptime_s, hashrate, total_hashes, temp_c,
    accepted, rejected, best, power_percent, pool_connected, pool, firmware_trial } = value;
  if (typeof id !== 'string' || !/^[a-f0-9]{16}$/.test(id) || !text(name, 48) ||
      typeof boot_id !== 'string' || !/^[a-f0-9]{1,16}$/.test(boot_id) || !validCoin(coin) ||
      !finite(hashrate) || !parseReport({ board, v, coin, hashrate: Math.max(hashrate, 1) }) ||
      !integer(uptime_s) || !finite(total_hashes) || !integer(accepted) || !integer(rejected) ||
      !finite(best) || !integer(power_percent, 100) || typeof pool_connected !== 'boolean' ||
      typeof firmware_trial !== 'boolean' || (!validPool(pool) && pool !== 'unknown') ||
      (temp_c !== null && (typeof temp_c !== 'number' || !Number.isFinite(temp_c) || temp_c < -50 || temp_c > 150))) return null;
  return { id, name, board, v, coin, boot_id, uptime_s, hashrate, total_hashes,
    temp_c, accepted, rejected, best, power_percent, pool_connected, pool, firmware_trial };
}

export async function remoteKey(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('Authorization') ?? '');
  if (!match) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export class PrivateStore {
  constructor(sql) {
    this.sql = sql;
    sql.exec('CREATE TABLE IF NOT EXISTS remote_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS miners (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS readings (miner TEXT NOT NULL, t INTEGER NOT NULL, boot TEXT NOT NULL, rate REAL NOT NULL, temp REAL, PRIMARY KEY(miner,t))');
  }
  revoked() { return !!this.sql.exec("SELECT value FROM remote_meta WHERE key='revoked'").toArray()[0]?.value; }
  prune(now = Date.now()) {
    this.sql.exec('DELETE FROM readings WHERE t < ?', now - REMOTE_KEEP);
    this.sql.exec('DELETE FROM miners WHERE at < ?', now - REMOTE_KEEP);
  }
  add(report, now = Date.now()) {
    if (this.revoked()) return 410;
    this.prune(now);
    const old = this.sql.exec('SELECT at FROM miners WHERE id = ?', report.id).toArray()[0];
    if (old && now - old.at < 60000) return 429;
    if (!old && this.sql.exec('SELECT COUNT(*) AS n FROM miners').toArray()[0].n >= REMOTE_LIMIT) return 409;
    // All bounded, validated writes run synchronously in the DO's input gate.
    this.sql.exec('INSERT INTO miners VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at, body=excluded.body', report.id, now, JSON.stringify(report));
    this.sql.exec('INSERT OR REPLACE INTO readings VALUES (?,?,?,?,?)', report.id, now, report.boot_id, report.hashrate, report.temp_c);
    return 204;
  }
  snapshot(now = Date.now()) {
    this.prune(now);
    const miners = this.sql.exec('SELECT at, body FROM miners ORDER BY at DESC').toArray().map(row => ({
      ...JSON.parse(row.body), at: row.at, age_s: Math.max(0, (now - row.at) / 1000),
      online: now - row.at <= (REMOTE_INTERVAL * 2 + 60) * 1000,
    }));
    return { miners, hashrate: miners.reduce((n, m) => n + (m.online ? m.hashrate : 0), 0),
      recorded_at: now, report_interval_s: REMOTE_INTERVAL, retention_days: 7 };
  }
  history(miner, hours, now = Date.now()) {
    if (!/^[a-f0-9]{16}$/.test(miner) || ![1, 6, 24, 168].includes(hours)) return null;
    this.prune(now);
    const bucket = Math.max(REMOTE_INTERVAL * 1000, hours * 3600000 / 480);
    const points = this.sql.exec('SELECT CAST(t / ? AS INTEGER) * ? AS t, AVG(rate) AS rate, MAX(temp) AS temp, MIN(boot) AS boot, COUNT(DISTINCT boot) AS boots FROM readings WHERE miner=? AND t>=? GROUP BY CAST(t / ? AS INTEGER) ORDER BY t', bucket, bucket, miner, now - hours * 3600000, bucket).toArray().map(p => ({ t: p.t, rate: p.rate, temp: p.temp, boot: p.boot, mixed_boots: p.boots > 1 }));
    return { points, interval_ms: bucket };
  }
  revoke() {
    this.sql.exec('DELETE FROM miners');
    this.sql.exec('DELETE FROM readings');
    this.sql.exec("INSERT OR REPLACE INTO remote_meta VALUES ('revoked',1)");
  }
}
