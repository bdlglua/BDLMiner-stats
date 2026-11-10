import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, SAMPLE } from '../src/store.js';
import { PrivateStore } from '../src/remote.js';
import { database } from './sqlite.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const number = n => typeof n === 'number' && Number.isFinite(n) && n >= 0;

export class CapacityError extends Error { status = 503; }

// Only import genuine five-minute samples. An hourly mean cannot recreate
// the underlying extrema, deviations, sample coverage or board inventory.
export function importPublic(store, snapshot, now = Date.now()) {
  if (!snapshot || !Number.isSafeInteger(snapshot.at) || snapshot.at > now + 60000 ||
      !Array.isArray(snapshot.recent) || !Array.isArray(snapshot.history))
    throw new Error('Invalid public snapshot');
  let imported = 0;
  for (const point of snapshot.recent) {
    if (!point || typeof point !== 'object') continue;
    const miners = point.average_miners ?? point.miners;
    if (point.live || point.samples !== 1 || point.interval_ms !== SAMPLE ||
        !Number.isSafeInteger(point.at) || point.at % SAMPLE || point.at > Math.min(now, snapshot.at) ||
        point.at <= now - 35 * DAY || !number(point.hashrate) || !number(miners)) continue;
    store.sql.exec('INSERT OR IGNORE INTO samples VALUES (?,?,?,?)', point.at, point.hashrate, miners, '{}');
    imported++;
  }
  const history = snapshot.history.filter(point => point && typeof point === 'object' && Number.isSafeInteger(point.at) &&
    point.at % HOUR === 0 && point.at > now - 7 * DAY - HOUR &&
    point.at < snapshot.at && Number.isSafeInteger(point.end_at) &&
    point.end_at <= Math.min(now, snapshot.at) && number(point.hashrate) && number(point.miners) &&
    Number.isInteger(point.samples) && point.samples > 0 && point.samples <= 12);
  const record = snapshot.record;
  store.put('selfhost-archive', JSON.stringify({ history, record:
    record && Number.isSafeInteger(record.at) && record.at <= snapshot.at &&
    record.at > now - 35 * DAY && number(record.hashrate) ? record : null }));
  store.put('selfhost-imported-at', String(now));
  return imported;
}

export class LocalState {
  constructor(directory, { maxSpaces = 2048, maxOpen = 32 } = {}) {
    this.directory = directory;
    this.privateDirectory = join(directory, 'private');
    mkdirSync(this.privateDirectory, { recursive: true, mode: 0o700 });
    this.publicSQL = database(join(directory, 'public.sqlite'));
    this.store = new Store(this.publicSQL);
    this.emptySQL = database(':memory:');
    this.empty = new PrivateStore(this.emptySQL);
    this.cache = new Map();
    this.maxSpaces = maxSpaces;
    this.maxOpen = maxOpen;
    this.spaces = new Set(readdirSync(this.privateDirectory)
      .filter(name => /^[a-f0-9]{64}\.sqlite$/.test(name)).map(name => name.slice(0, -7)));
    const snapshot = join(directory, 'legacy-summary.json');
    if (!this.store.get('selfhost-imported-at') && existsSync(snapshot)) {
      const value = JSON.parse(readFileSync(snapshot, 'utf8'));
      this.publicSQL.transaction(() => importPublic(this.store, value));
    }
    this.publicAdapter = {
      add: report => this.publicSQL.transaction(() => this.store.add(report, null)),
      summary: () => this.summary(),
      // A TCP tunnel has no trustworthy per-client IP; http.js bounds traffic.
      remoteAllowed: () => true,
    };
  }

  summary(now = Date.now()) {
    const result = this.publicSQL.transaction(() => this.store.summary(now));
    const archive = JSON.parse(this.store.get('selfhost-archive') ?? 'null');
    if (!archive) return result;
    const first = this.publicSQL.exec('SELECT MIN(t) AS t FROM samples').toArray()[0]?.t;
    // Do not replace partial locally observed hours with an archived mean.
    const cutoff = first === null ? now : Math.floor((first - 1) / HOUR) * HOUR;
    result.history = [...archive.history.filter(point => point.at >= now - 7 * DAY &&
      point.end_at <= cutoff), ...result.history];
    if (archive.record?.at > now - 35 * DAY && archive.record.hashrate > (result.record?.hashrate ?? 0))
      result.record = archive.record;
    return result;
  }

  privateStore(id, create = false) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid space');
    if (!this.spaces.has(id)) {
      if (!create) return this.empty;
      if (this.spaces.size >= this.maxSpaces) throw new CapacityError('Private storage capacity reached');
    }
    let entry = this.cache.get(id);
    if (!entry) {
      const sql = database(join(this.privateDirectory, id + '.sqlite'));
      entry = { sql, store: new PrivateStore(sql) };
      this.spaces.add(id);
    }
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > this.maxOpen) {
      const [old, value] = this.cache.entries().next().value;
      value.sql.close(); this.cache.delete(old);
    }
    return entry.store;
  }

  remote(id) {
    return {
      add: report => {
        const store = this.privateStore(id, true);
        return this.cache.get(id).sql.transaction(() => store.add(report));
      },
      snapshot: () => { const store = this.privateStore(id); return store.revoked() ? null : store.snapshot(); },
      history: (miner, hours) => this.privateStore(id).history(miner, hours),
      revoke: () => {
        const store = this.privateStore(id, true);
        this.cache.get(id).sql.transaction(() => store.revoke());
      },
    };
  }

  sample() { this.publicSQL.transaction(() => this.store.sampleDue()); }
  prune() { for (const id of this.spaces) this.privateStore(id).prune(); }
  close() {
    for (const entry of this.cache.values()) entry.sql.close();
    this.cache.clear(); this.emptySQL.close(); this.publicSQL.close();
  }
}
