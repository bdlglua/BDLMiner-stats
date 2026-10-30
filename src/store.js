// The reports, in the SQLite database of one Durable Object. Each miner
// reports once an hour, so the reports of the last hour add up to the total
// hashrate of the miners that share it, and those of each past hour to its
// history.

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const KEEP = 35 * DAY;
// A little over an hour: a miner's next report comes a few seconds after the
// hour, so a shorter window would sometimes miss it.
const WINDOW = 61 * 60 * 1000;
const PER_ADDRESS_HOUR = 30;  // reports accepted per network address and hour

export class Store {
  constructor(sql) {
    this.sql = sql;
    sql.exec("CREATE TABLE IF NOT EXISTS reports (t INTEGER NOT NULL, v TEXT NOT NULL, board TEXT NOT NULL, hashrate REAL NOT NULL)");
    sql.exec("CREATE INDEX IF NOT EXISTS reports_t ON reports (t)");
    this.addresses = new Map();  // address -> {count, until}: in memory only, never stored
    this.prunedAt = 0;
  }

  // false when refused: too many reports from one address (a whole fleet
  // behind one router stays well below the limit).
  add(report, address, now = Date.now()) {
    const seen = this.addresses.get(address);
    if (seen && seen.until > now) {
      if (seen.count >= PER_ADDRESS_HOUR) return false;
      seen.count++;
    } else {
      this.addresses.set(address, { count: 1, until: now + HOUR });
    }
    this.sql.exec("INSERT INTO reports (t, v, board, hashrate) VALUES (?, ?, ?, ?)", now, report.v, report.board, report.hashrate);
    if (now - this.prunedAt > 6 * HOUR) {
      this.prunedAt = now;
      this.sql.exec("DELETE FROM reports WHERE t < ?", now - KEEP);
      for (const [a, s] of this.addresses) if (s.until <= now) this.addresses.delete(a);
    }
    return true;
  }

  summary(now = Date.now()) {
    const since = now - WINDOW;
    const rows = (q, ...b) => this.sql.exec(q, ...b).toArray();
    const current = rows("SELECT COUNT(*) AS miners, COALESCE(SUM(hashrate), 0) AS hashrate FROM reports WHERE t > ?", since)[0];
    const group = (column) => rows(
      `SELECT ${column} AS name, COUNT(*) AS miners, SUM(hashrate) AS hashrate FROM reports WHERE t > ? GROUP BY ${column} ORDER BY hashrate DESC`,
      since);
    const hours = rows(
      "SELECT CAST(t / ? AS INTEGER) AS hour, COUNT(*) AS miners, SUM(hashrate) AS hashrate FROM reports WHERE t > ? GROUP BY hour ORDER BY hour",
      HOUR, now - 7 * DAY);
    const record = rows(
      "SELECT hour, MAX(total) AS hashrate FROM (SELECT CAST(t / ? AS INTEGER) AS hour, SUM(hashrate) AS total FROM reports GROUP BY hour)", HOUR)[0];
    return {
      at: now,
      miners: current.miners,
      hashrate: current.hashrate,
      boards: group("board"),
      versions: group("v"),
      // The current hour is still filling up: the chart stops at the last full one.
      history: hours.filter((h) => h.hour < Math.floor(now / HOUR)).map((h) => ({ at: h.hour * HOUR, miners: h.miners, hashrate: h.hashrate })),
      record: record?.hashrate ? { at: record.hour * HOUR, hashrate: record.hashrate } : null,
    };
  }
}

// What a miner sends (src/share.cpp in BDLMinerV1); null for anything else.
export function parseReport(value) {
  if (!value || typeof value !== "object") return null;
  const { v, board, hashrate } = value;
  if (typeof v !== "string" || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) return null;
  if (typeof board !== "string" || !/^[a-z0-9-]{1,32}$/.test(board)) return null;
  // Up to 10 TH/s: the fastest board, a Bitaxe Gamma, does about 1.2 TH/s.
  if (typeof hashrate !== "number" || !(hashrate > 0) || hashrate > 1e13) return null;
  return { v, board, hashrate };
}
