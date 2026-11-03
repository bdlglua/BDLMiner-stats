// The statistics, in the SQLite database of one Durable Object.
//
// A miner reports its hashrate every `every` seconds (5 minutes from BDLMiner
// 1.9.2; 1.9.0 and 1.9.1 report hourly and do not say so). Reports carry no
// identifier, so each one stands for its miner during the interval that
// follows it, [t, t + every): consecutive reports of a miner tile the
// timeline without overlapping, and a total over any span is the sum of the
// reports' hashrates weighted by how much of the span they cover. Every 5
// minutes that total is kept as one sample: the 24-hour chart, the 7-day
// hourly history and the records come from the samples.

import { poolGroup, validPool } from "./pools.js";
import { validCoin, coinGroup } from "./coins.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
export const SAMPLE = 5 * MINUTE;
const KEEP = 35 * DAY;
const DEFAULT_EVERY = 3600;  // seconds, for reports that do not say
// A miner reporting every 5 minutes sends 12 an hour: this lets a few dozen
// share one router's address.
const PER_ADDRESS_HOUR = 400;
// A report's interval ends a few seconds before the next one arrives (the
// firmware checks every 5 s): its miner still counts as online meanwhile.
const ONLINE_GRACE = 30 * 1000;

export class Store {
  constructor(sql) {
    this.sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY, hashrate REAL NOT NULL, miners REAL NOT NULL, boards TEXT NOT NULL)");
    this.live = JSON.parse(this.get("live") ?? "[]");
    this.migrate();
    // The samples of the first evening counted updating miners twice (before
    // add() ended their previous reports, and while the reports of miners
    // still on 1.9.0 and 1.9.1 overlapped): they are dropped once, after all
    // of those miners moved to 1.9.2.
    if (this.get("samples-reset") !== "3") {
      sql.exec("DELETE FROM samples WHERE t <= ?", 1793391000000);  // 2026-10-30 21:10 Paris time
      this.put("samples-reset", "3");
    }
    this.addresses = new Map();  // address -> {count, until}: in memory only, never stored
    // Which address sent each live report, in memory only (lost on a restart
    // of the Durable Object, never stored): see add().
    this.senders = new Map();
  }

  get(key) {
    return this.sql.exec("SELECT value FROM state WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  put(key, value) {
    this.sql.exec("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  // The first version stored every report in a table: the last hour of them
  // becomes the live list (they were hourly reports).
  migrate() {
    const old = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reports'").toArray();
    if (!old.length) return;
    for (const r of this.sql.exec("SELECT t, v, board, hashrate FROM reports WHERE t > ?", Date.now() - HOUR).toArray())
      this.live.push({ t: r.t, every: DEFAULT_EVERY, v: r.v, board: r.board, hashrate: r.hashrate });
    this.sql.exec("DROP TABLE reports");
    this.put("live", JSON.stringify(this.live));
  }

  // false when refused: too many reports from one address.
  add(report, address, now = Date.now()) {
    const seen = this.addresses.get(address);
    if (seen && seen.until > now) {
      if (seen.count >= PER_ADDRESS_HOUR) return false;
      seen.count++;
    } else {
      this.addresses.set(address, { count: 1, until: now + HOUR });
      if (this.addresses.size > 10000) for (const [a, s] of this.addresses) if (s.until <= now) this.addresses.delete(a);
    }
    this.sampleDue(now);
    const { v, board, hashrate, every = DEFAULT_EVERY, model, pool, coin } = report;
    // A miner that installs an update restarts and reports again while the
    // report of its previous version still stands for up to an hour: the same
    // board from the same address with another version is that miner, so its
    // previous report ends now. (Two miners of one board behind one router
    // that update at different times only lose a few minutes of each other.)
    // Hourly reports whose sender is unknown (received before a restart of
    // the Durable Object) end when a report of the same board comes from a
    // version that says its interval, i.e. 1.9.2 or later.
    for (const r of this.live) {
      const sender = this.senders.get(r);
      const same = sender === address || (sender === undefined && report.every !== undefined && r.every === DEFAULT_EVERY);
      if (r.board === board && r.v !== v && same && r.t + r.every * 1000 > now) r.every = Math.max(1, (now - r.t) / 1000);
    }
    const entry = { t: now, every, v, board, hashrate, ...(validCoin(coin) ? { coin } : {}), ...(model ? { model } : {}),
      ...(pool === undefined ? {} : { pool: poolGroup(pool) }) };
    this.live.push(entry);
    this.senders.set(entry, address);
    // Kept while its interval may still be sampled or counted as online.
    const keep = Math.min(this.lastSample(now), now) - SAMPLE;
    this.live = this.live.filter((r) => {
      const kept = r.t + r.every * 1000 + ONLINE_GRACE > keep;
      if (!kept) this.senders.delete(r);
      return kept;
    });
    this.put("live", JSON.stringify(this.live));
    return true;
  }

  lastSample(now = Date.now()) {
    return this.sql.exec("SELECT MAX(t) AS t FROM samples").toArray()[0]?.t ?? Math.floor(now / SAMPLE) * SAMPLE;
  }

  nextSampleAt(now = Date.now()) {
    return this.lastSample(now) + SAMPLE;
  }

  // The totals over [from, to): hashrate and miners, overall and per board and version.
  span(from, to) {
    const total = { hashrate: 0, miners: 0, boards: {}, versions: {} };
    for (const r of this.live) {
      const share = Math.max(0, Math.min(to, r.t + r.every * 1000) - Math.max(from, r.t)) / (to - from);
      if (!share) continue;
      total.hashrate += r.hashrate * share;
      total.miners += share;
      for (const [map, key] of [[total.boards, r.board], [total.versions, r.v]]) {
        map[key] ??= { miners: 0, hashrate: 0 };
        map[key].miners += share;
        map[key].hashrate += r.hashrate * share;
      }
    }
    return total;
  }

  // One sample per 5 minutes that ended since the last one (the Durable
  // Object's alarm calls it on time; a report or a page view catches up).
  sampleDue(now = Date.now()) {
    const last = this.sql.exec("SELECT MAX(t) AS t FROM samples").toArray()[0]?.t;
    let at = last ? last + SAMPLE : Math.floor(now / SAMPLE) * SAMPLE;
    if (now - at > DAY) at = Math.floor((now - DAY) / SAMPLE) * SAMPLE;  // a long outage leaves a gap
    for (; at <= now; at += SAMPLE) {
      const s = this.span(at - SAMPLE, at);
      const boards = Object.fromEntries(Object.entries(s.boards).map(([b, x]) => [b, Math.round(x.miners)]));
      this.sql.exec("INSERT OR IGNORE INTO samples (t, hashrate, miners, boards) VALUES (?, ?, ?, ?)",
        at, s.hashrate, s.miners, JSON.stringify(boards));
    }
    if (!this.prunedAt || now - this.prunedAt > 6 * HOUR) {
      this.prunedAt = now;
      this.sql.exec("DELETE FROM samples WHERE t < ?", now - KEEP);
    }
  }

  summary(now = Date.now()) {
    this.sampleDue(now);
    // Now: the reports whose interval covers this moment count in full (a
    // miner that just started counts at once). A report whose interval ended
    // in the last few seconds (its miner checks every 5 s before sending the
    // next) fills in only where no newer report has come, so that a miner
    // changing reports is not counted twice: the count over the last 5
    // minutes, weighted by coverage, settles it.
    const recent = this.span(now - SAMPLE, now);
    const ends = (r) => r.t + r.every * 1000;
    const active = this.live.filter((r) => r.t <= now && now < ends(r));
    const late = this.live.filter((r) => ends(r) <= now && now < ends(r) + ONLINE_GRACE);
    const count = (list) => list.reduce((c, r) => ({ ...c, [r.board]: (c[r.board] ?? 0) + 1 }), {});
    const strict = count(active), grace = count(late);
    const online = {};
    for (const board of new Set([...Object.keys(strict), ...Object.keys(grace)])) {
      const sure = strict[board] ?? 0;
      online[board] = Math.max(sure, Math.min(sure + (grace[board] ?? 0), Math.round(recent.boards[board]?.miners ?? 0)));
      if (!online[board]) delete online[board];
    }
    const miners = Object.values(online).reduce((a, b) => a + b, 0);
    const live = { hashrate: 0, boards: {}, versions: {}, models: {}, pools: {}, coins: {} };
    const weigh = (r, share) => {
      live.hashrate += r.hashrate * share;
      // Models: the exact one when the miner tells it (M5Stack), otherwise its board.
      for (const [map, key] of [[live.boards, r.board], [live.versions, r.v], [live.models, `${r.board}\n${r.model ?? ""}`],
        [live.pools, poolGroup(r.pool)], [live.coins, coinGroup(r.coin)]]) {
        map[key] ??= { miners: 0, hashrate: 0 };
        map[key].miners += share;
        map[key].hashrate += r.hashrate * share;
      }
    };
    for (const r of active) weigh(r, 1);
    for (const r of late) {
      const missing = (online[r.board] ?? 0) - (strict[r.board] ?? 0);
      if (missing > 0) weigh(r, missing / grace[r.board]);
    }

    const samples = this.sql.exec("SELECT t, hashrate, miners, boards FROM samples WHERE t > ? ORDER BY t", now - 7 * DAY).toArray();
    // Reports carry no identifier, so the miners of a board that went offline
    // are estimated: how many ran together over 7 days, minus those online
    // now. "Together" is the fewest seen during an hour (a full hour of
    // samples), so that a miner counted twice for a few minutes while it
    // restarts does not add one; the most of those minimums is kept.
    const peak = { ...online };
    const perHour = new Map();
    for (const s of samples) {
      const h = Math.floor((s.t - 1) / HOUR);
      const e = perHour.get(h) ?? { n: 0, boards: [] };
      e.n++;
      e.boards.push(JSON.parse(s.boards));
      perHour.set(h, e);
    }
    for (const { n, boards } of perHour.values()) {
      if (n < HOUR / SAMPLE) continue;
      for (const b of new Set(boards.flatMap(Object.keys)))
        peak[b] = Math.max(peak[b] ?? 0, Math.min(...boards.map((x) => x[b] ?? 0)));
    }
    const fleet = Object.keys(peak).map((board) => ({ board, online: online[board] ?? 0, offline: Math.max(0, peak[board] - (online[board] ?? 0)) }))
      .filter((f) => f.online || f.offline)
      .sort((a, b) => b.online - a.online || b.offline - a.offline || a.board.localeCompare(b.board));

    // A sample at t covers the 5 minutes before t.
    const hours = new Map();
    for (const s of samples) {
      const h = Math.floor((s.t - 1) / HOUR) * HOUR;
      const e = hours.get(h) ?? { at: h, hashrate: 0, miners: 0, n: 0 };
      e.hashrate += s.hashrate; e.miners += s.miners; e.n++;
      hours.set(h, e);
    }
    const thisHour = Math.floor(now / HOUR) * HOUR;
    const history = [...hours.values()].filter((h) => h.at < thisHour)
      .map((h) => ({ at: h.at, hashrate: h.hashrate / h.n, miners: Math.round(h.miners / h.n) }));
    // The best hour with at least half of its samples.
    const best = this.sql.exec(`SELECT h, AVG(hashrate) AS hashrate FROM (SELECT (t - 1) / ${HOUR} AS h, hashrate FROM samples)
                                GROUP BY h HAVING COUNT(*) >= 6 ORDER BY 2 DESC LIMIT 1`).toArray()[0];
    const breakdown = (map) => Object.entries(map)
      .map(([name, x]) => ({ name, miners: Math.max(1, Math.round(x.miners)), hashrate: x.hashrate }))
      .sort((a, b) => b.hashrate - a.hashrate);

    return {
      at: now,
      miners,
      hashrate: live.hashrate,
      boards: breakdown(live.boards),
      versions: breakdown(live.versions),
      pools: breakdown(live.pools),
      coins: breakdown(live.coins),
      models: breakdown(live.models).map(({ name, ...x }) => {
        const [board, model] = name.split("\n");
        return { board, model: model || null, ...x };
      }),
      fleet,
      // Every 5 minutes over the last 24 hours, then now.
      recent: [...samples.filter((s) => s.t > now - DAY).map((s) => ({ at: s.t, hashrate: s.hashrate, miners: Math.round(s.miners) })),
        { at: now, hashrate: live.hashrate, miners, live: true }],
      history,
      record: best?.hashrate > 0 ? { at: best.h * HOUR, hashrate: best.hashrate } : null,
    };
  }
}

// The most a board can do, with room to spare: a report beyond it is made up
// and would inflate the total. The ESP32 boards hash in software (about
// 1 MH/s at best); the ASIC boards in GH/s (NerdNOS) and TH/s (Bitaxe Gamma,
// about 1.2 TH/s).
const ASIC_MAX = { nerdnos: 2e12, "bitaxe-gamma-601": 5e12 };
const SOFTWARE_MAX = 5e6;
const maxHashrate = (board) => (Object.hasOwn(ASIC_MAX, board) ? ASIC_MAX[board] : SOFTWARE_MAX);

// What a miner sends (src/share.cpp in BDLMinerV2); null for anything else.
export function parseReport(value) {
  if (!value || typeof value !== "object") return null;
  const { v, board, hashrate, every, model, pool, coin } = value;
  // Firmware versions fit 23 characters and may be SemVer prereleases/builds.
  // Keep the original bounds on core components and reject leading zeroes in
  // numeric prerelease identifiers; labels are stored exactly as reported.
  const version = typeof v === "string" && v.length <= 23
    ? /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(v)
    : null;
  if (!version || version[0] !== v || (version[1] ?? "").split(".").some((part) => /^0\d+$/.test(part))) return null;
  if (typeof board !== "string" || !/^[a-z0-9-]{1,32}$/.test(board)) return null;
  if (typeof hashrate !== "number" || !(hashrate > 0) || hashrate > maxHashrate(board)) return null;
  if (every !== undefined && (!Number.isInteger(every) || every < 60 || every > 86400)) return null;
  // The exact model (M5Stack boards, from 1.9.4): a short name, nothing else.
  if (model !== undefined && (typeof model !== "string" || !/^[A-Za-z0-9 .+()-]{1,39}$/.test(model))) return null;
  if (pool !== undefined && !validPool(pool)) return null;
  if (coin !== undefined && !validCoin(coin)) return null;
  // 1.9.4 also sends a model that only repeats its board ("M5StickC Plus2" for
  // m5stickc-plus2): it tells nothing more.
  const plain = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const tells = model !== undefined && plain(model) !== plain(board);
  return { v, board, hashrate, ...(every !== undefined ? { every } : {}), ...(tells ? { model } : {}),
    ...(pool === undefined ? {} : { pool }), ...(coin === undefined ? {} : { coin }) };
}
