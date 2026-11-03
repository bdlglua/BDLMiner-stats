import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import handler, { authorized } from "../src/index.js";
import { parseReport, Store } from "../src/store.js";
import { PUBLIC_POOLS, POOL_LINKS } from "../src/pools.js";

// The Durable Object's SQL interface (ctx.storage.sql.exec) over node:sqlite.
function sqlite() {
  const db = new DatabaseSync(":memory:");
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*SELECT/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows.map((r) => ({ ...r })) };
    },
  };
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const report = (hashrate, board = "m5stickc-plus2", every = 300, v = "1.9.2") =>
  every ? { v, board, hashrate, every } : { v, board, hashrate };

// Reports of several miners, in time order: [time, report, address].
function feed(store, ...miners) {
  const events = miners.flatMap(({ from, to, period, r, address = "a" }) => {
    const out = [];
    for (let t = from; t <= to; t += period) out.push([t, r, address]);
    return out;
  }).sort((a, b) => a[0] - b[0]);
  for (const [t, r, address] of events) store.add(r, address, t);
}

const near = (actual, expected, tolerance = 0.03) =>
  assert.ok(Math.abs(actual - expected) <= expected * tolerance, `${actual} is not about ${expected}`);

describe("stats store", () => {
  let store;
  beforeEach(() => { store = new Store(sqlite()); });

  it("links recognised groups only to fixed public HTTPS websites", () => {
    assert.deepEqual(Object.keys(POOL_LINKS).sort(), Object.keys(PUBLIC_POOLS).sort());
    for (const [pool, destination] of Object.entries(POOL_LINKS)) {
      const url = new URL(destination);
      assert.equal(url.protocol, 'https:');
      assert.ok(url.hostname === pool || url.hostname.endsWith('.' + pool));
      assert.equal(url.username + url.password + url.search + url.hash, '');
    }
    assert.equal(Object.hasOwn(POOL_LINKS, 'other'), false);
    assert.equal(Object.hasOwn(POOL_LINKS, 'unknown'), false);
  });

  it("groups public, private and undisclosed pools without changing the totals", () => {
    const entries = [
      { ...report(1e6), pool: "public-pool.io" },
      { ...report(2e6), pool: "public-pool.io" },
      { ...report(5e5), pool: "nerdminers.org" },
      { ...report(3e5), pool: "other" },
      report(2e5), // old firmware or no opt-in
    ];
    entries.forEach((r, i) => store.add(r, String(i), T));
    const summary = store.summary(T + MIN);
    assert.equal(summary.miners, 5);
    assert.equal(summary.pools.reduce((n, p) => n + p.miners, 0), 5);
    assert.equal(summary.pools.reduce((n, p) => n + p.hashrate, 0), summary.hashrate);
    assert.deepEqual(summary.pools, [
      { name: "public-pool.io", miners: 2, hashrate: 3e6 },
      { name: "nerdminers.org", miners: 1, hashrate: 5e5 },
      { name: "other", miners: 1, hashrate: 3e5 },
      { name: "unknown", miners: 1, hashrate: 2e5 },
    ]);
    const restarted = new Store(store.sql);
    assert.deepEqual(restarted.summary(T + MIN).pools, summary.pools);
    assert.deepEqual(store.summary(T + 6 * MIN).pools, []);
  });

  it("applies the existing report grace to pools without counting a switch twice", () => {
    store.add({ ...report(1e6), pool: "public-pool.io" }, "a", T);
    assert.deepEqual(store.summary(T + 301000).pools, [{ name: "public-pool.io", miners: 1, hashrate: 1e6 }]);
    store.add({ ...report(1e6), pool: "ckpool.org" }, "a", T + 302000);
    assert.deepEqual(store.summary(T + 303000).pools, [{ name: "ckpool.org", miners: 1, hashrate: 1e6 }]);
  });

  it("never stores an arbitrary pool endpoint, even if the HTTP parser is bypassed", () => {
    store.add({ ...report(1e6), pool: "http://wallet:password@192.168.1.2:3333" }, "a", T);
    assert.equal(store.live[0].pool, "other");
    assert.doesNotMatch(store.get("live"), /wallet|password|192\.168/);
    assert.deepEqual(store.summary(T + MIN).pools, [{ name: "other", miners: 1, hashrate: 1e6 }]);
  });

  it("accepts only finite pool groups and keeps legacy reports unchanged", () => {
    const base = report(1e6);
    assert.deepEqual(parseReport(base), base);
    for (const pool of [...Object.keys(PUBLIC_POOLS), "other"])
      assert.deepEqual(parseReport({ ...base, pool }), { ...base, pool });
    for (const pool of ["", "unknown", "__proto__", "constructor", "192.168.1.20", "miner.local", "private.example",
      "pool.nerdminers.org", "https://wallet.worker@public-pool.io", "<script>", null, {}, 1])
      assert.equal(parseReport({ ...base, pool }), null, JSON.stringify(pool));
  });

  it("adds up miners reporting every 5 minutes and hourly, without counting one twice", () => {
    feed(store,
      // 1.9.2: every 5 minutes, a little late each time as on a board (polled every 5 s).
      { from: T - 2 * HOUR + 7000, to: T, period: 5 * MIN + 3000, r: report(1e6) },
      { from: T - 2 * HOUR + 90000, to: T, period: 5 * MIN + 1000, r: report(2e6, "esp32-headless"), address: "b" },
      // 1.9.0: hourly, without saying so.
      { from: T - 3 * HOUR + 30000, to: T, period: HOUR + 2000, r: report(5e5, "lilygo-t-display", 0, "1.9.0"), address: "c" });
    const s = store.summary(T);
    assert.equal(s.miners, 3);
    near(s.hashrate, 3.5e6);
    assert.deepEqual(s.boards.map((b) => [b.name, b.miners]), [["esp32-headless", 1], ["m5stickc-plus2", 1], ["lilygo-t-display", 1]]);
    assert.deepEqual(s.versions.map((v) => v.name), ["1.9.2", "1.9.0"]);
    // Every 5-minute sample once all three reported, and every complete hour.
    for (const p of s.recent.filter((p) => p.at > T - 100 * MIN)) near(p.hashrate, 3.5e6);
    assert.equal(s.recent.at(-1).live, true);
    assert.equal(s.recent.filter((p) => !p.live).every((p, i, a) => !i || p.at - a[i - 1].at === 5 * MIN), true);
    near(s.history.at(-1).hashrate, 3.5e6);
    assert.equal(s.history.at(-1).at, T - HOUR);
    near(s.record.hashrate, 3.5e6);
  });

  it("drops a miner within 5 minutes of its last report, and counts it offline", () => {
    feed(store,
      // Ran together for over an hour, then one stopped 30 minutes ago.
      { from: T - 2 * HOUR, to: T - 30 * MIN, period: 5 * MIN + 2000, r: report(1e11, "nerdnos") },
      { from: T - 2 * HOUR + 1000, to: T, period: 5 * MIN + 2000, r: report(1e11, "nerdnos"), address: "b" },
      { from: T - 2 * HOUR + 2000, to: T, period: 5 * MIN + 2000, r: report(1e6) , address: "c" });
    const s = store.summary(T);
    assert.equal(s.miners, 2);
    near(s.hashrate, 1e11 + 1e6);
    assert.deepEqual(s.fleet, [
      { board: "nerdnos", online: 1, offline: 1 },
      { board: "m5stickc-plus2", online: 1, offline: 0 },
    ]);
  });

  it("estimates the miners gone offline from full hours, not from a moment counted twice", () => {
    // Two ESP32 for two hours, one stops; a third shows up twice for 10 minutes only.
    feed(store,
      { from: T - 3 * HOUR, to: T, period: 5 * MIN + 2000, r: report(1e6, "esp32-headless"), address: "a" },
      { from: T - 3 * HOUR + 1000, to: T - HOUR, period: 5 * MIN + 2000, r: report(1e6, "esp32-headless"), address: "b" },
      { from: T - 2 * HOUR + 30 * MIN, to: T - 2 * HOUR + 40 * MIN, period: MIN, r: report(1e6, "m5stickc-plus2"), address: "c" });
    assert.deepEqual(store.summary(T).fleet, [{ board: "esp32-headless", online: 1, offline: 1 }]);
  });

  it("does not count a miner twice when it restarts on a new version", () => {
    // Two hourly 1.9.0 miners (one board, two homes), then both update to 1.9.1 within the hour.
    store.add(report(1e6, "m5stickc-plus2", 0, "1.9.0"), "home1", T - 50 * MIN);
    store.add(report(1e6, "esp32-headless", 0, "1.9.0"), "home2", T - 40 * MIN);
    store.add(report(1e6, "m5stickc-plus2", 0, "1.9.1"), "home1", T - 20 * MIN);
    store.add(report(1e6, "esp32-headless", 0, "1.9.1"), "home2", T - 10 * MIN);
    // Another 1.9.0 ESP32 behind a third router keeps its report.
    store.add(report(1e6, "esp32-headless", 0, "1.9.0"), "home3", T - 5 * MIN);
    const s = store.summary(T);
    assert.equal(s.miners, 3);
    assert.equal(s.hashrate, 3e6);
    assert.deepEqual(s.versions.map((x) => [x.name, x.miners]), [["1.9.1", 2], ["1.9.0", 1]]);
    assert.deepEqual(s.fleet, [{ board: "esp32-headless", online: 2, offline: 0 }, { board: "m5stickc-plus2", online: 1, offline: 0 }]);
  });

  it("ends hourly reports received before a restart when their miners update", () => {
    const sql = sqlite();
    const before = new Store(sql);
    before.add(report(1e6, "m5stickc-plus2", 0, "1.9.1"), "home1", T - 30 * MIN);
    before.add(report(1e6, "esp32-headless", 0, "1.9.1"), "home2", T - 30 * MIN);
    const after = new Store(sql);
    after.add(report(1e6, "m5stickc-plus2", 300, "1.9.2"), "home1", T - MIN);
    const s = after.summary(T);
    assert.equal(s.miners, 2);
    assert.deepEqual(s.versions.map((x) => [x.name, x.miners]).sort(), [["1.9.1", 1], ["1.9.2", 1]]);
    assert.deepEqual(s.boards.map((x) => [x.name, x.miners]).sort(), [["esp32-headless", 1], ["m5stickc-plus2", 1]]);
  });

  it("forgets old reports, including those from before a restart", () => {
    const sql = sqlite();
    const before = new Store(sql);
    before.add(report(1e6), "a", T - 3 * HOUR);
    const after = new Store(sql);  // the Durable Object restarted: senders unknown
    after.add(report(1e6), "b", T);
    assert.equal(after.live.length, 1);
    assert.equal(after.senders.size, 1);
  });

  it("tells the exact models apart when miners give them", () => {
    store.add({ v: "1.9.4", board: "m5stack-esp32", hashrate: 1e6, every: 300, model: "M5Stack Core2" }, "a", T - 60000);
    store.add({ v: "1.9.4", board: "m5stack-esp32", hashrate: 9e5, every: 300, model: "M5StickC Plus" }, "b", T - 50000);
    store.add({ v: "1.9.3", board: "m5stack-esp32", hashrate: 8e5, every: 300 }, "c", T - 40000);
    store.add({ v: "1.9.4", board: "esp32-headless", hashrate: 7e5, every: 300 }, "d", T - 30000);
    const s = store.summary(T);
    assert.deepEqual(s.models.map((m) => [m.board, m.model, m.miners]), [
      ["m5stack-esp32", "M5Stack Core2", 1], ["m5stack-esp32", "M5StickC Plus", 1], ["m5stack-esp32", null, 1], ["esp32-headless", null, 1]]);
    assert.deepEqual(s.boards.map((b) => [b.name, b.miners]), [["m5stack-esp32", 3], ["esp32-headless", 1]]);
  });

  it("counts a miner online, with its whole hashrate, from its first report", () => {
    store.add(report(1e6), "a", T - 10000);
    const s = store.summary(T);
    assert.equal(s.miners, 1);
    assert.equal(s.hashrate, 1e6);
    assert.equal(s.recent.at(-1).hashrate, 1e6);
    assert.deepEqual(s.fleet, [{ board: "m5stickc-plus2", online: 1, offline: 0 }]);
  });

  it("keeps sampling with no report, and prunes samples older than 35 days", () => {
    store.add(report(1e6), "a", T);
    const later = T + 40 * 24 * HOUR;
    const s = store.summary(later);
    assert.equal(s.miners, 0);
    assert.equal(s.hashrate, 0);
    assert.equal(s.recent.length, 24 * 12 + 1);  // a day of zero samples, then now
    assert.equal(store.sql.exec("SELECT MIN(t) AS t FROM samples").toArray()[0].t > later - 35 * 24 * HOUR, true);
  });

  it("turns the hourly reports of the first version into live ones", () => {
    const sql = sqlite();
    const now = Date.now();
    sql.exec("CREATE TABLE reports (t INTEGER NOT NULL, v TEXT NOT NULL, board TEXT NOT NULL, hashrate REAL NOT NULL)");
    sql.exec("INSERT INTO reports VALUES (?, '1.9.0', 'esp32-headless', 1000000), (?, '1.9.0', 'esp32-headless', 1000000)", now - 2 * HOUR, now - 10 * MIN);
    const migrated = new Store(sql);
    assert.equal(migrated.summary(now).miners, 1);
    assert.equal(sql.exec("SELECT name FROM sqlite_master WHERE name = 'reports'").toArray().length, 0);
    assert.equal(new Store(sql).summary(now).miners, 1);  // kept across restarts
  });

  it("limits the reports per address", () => {
    for (let i = 0; i < 400; i++) assert.equal(store.add(report(1e6), "flood", T + i), true);
    assert.equal(store.add(report(1e6), "flood", T + 401), false);
    assert.equal(store.add(report(1e6), "other", T + 402), true);
    assert.equal(store.add(report(1e6), "flood", T + HOUR + 1), true);
  });

  it("accepts only what a miner sends", () => {
    assert.deepEqual(parseReport({ v: "1.9.0", board: "nerdnos", hashrate: 1.5e11 }), { v: "1.9.0", board: "nerdnos", hashrate: 1.5e11 });
    assert.deepEqual(parseReport({ v: "1.9.2", board: "x", hashrate: 1, every: 300 }), { v: "1.9.2", board: "x", hashrate: 1, every: 300 });
    assert.deepEqual(parseReport({ v: "1.9.4", board: "x", hashrate: 1, every: 300, model: "M5Stack Core2" }).model, "M5Stack Core2");
    assert.equal("model" in parseReport({ v: "1.9.4", board: "m5stickc-plus2", hashrate: 1, model: "M5StickC Plus2" }), false);
    for (const model of ["", "<script>", "x".repeat(40), 5]) assert.equal(parseReport({ v: "1.9.4", board: "x", hashrate: 1, model }), null, String(model));
    for (const bad of [null, {}, { v: "1.9", board: "x", hashrate: 1 }, { v: "1.9.0", board: "Bad Board", hashrate: 1 },
      { v: "1.9.0", board: "x", hashrate: 0 }, { v: "1.9.0", board: "x", hashrate: 1e14 }, { v: "1.9.0", board: "x", hashrate: "1e6" },
      { v: "1.9.2", board: "x", hashrate: 1, every: 5 }, { v: "1.9.2", board: "x", hashrate: 1, every: 1.5 }])
      assert.equal(parseReport(bad), null, JSON.stringify(bad));
  });

  it("accepts firmware SemVer prereleases without accepting malformed version labels", () => {
    for (const v of ["1.9.15", "2.0.0-beta.1", "2.0.0-rc.2", "2.0.0-alpha.0", "2.0.0-dev", "2.0.0-beta.1+abc", "2.0.0+build.001"])
      assert.equal(parseReport({ v, board: "bitaxe-gamma-601", hashrate: 1.08e12, every: 300 })?.v, v);
    for (const v of ["2.0", "2.0.0-", "2.0.0-beta..1", "2.0.0-beta.01", "2.0.0-01", "2.0.0+", "2.0.0-beta.1\n",
      "2.0.0-<script>", "02.0.0-beta.1", "2.0.0-" + "a".repeat(20)])
      assert.equal(parseReport({ v, board: "bitaxe-gamma-601", hashrate: 1.08e12, every: 300 }), null, v);
  });

  it("refuses a hashrate the board cannot do", () => {
    const ok = (board, hashrate) => parseReport({ v: "1.9.6", board, hashrate, every: 300 }) !== null;
    assert.ok(ok("m5stickc-plus2", 1.02e6) && ok("esp32-headless", 5e6) && ok("dev", 3e5));
    assert.ok(!ok("m5stickc-plus2", 6e6) && !ok("esp32-headless", 1e13) && !ok("unknown-board", 1e9));
    assert.ok(ok("nerdnos", 5e11) && !ok("nerdnos", 3e12));
    assert.ok(ok("bitaxe-gamma-601", 1.2e12) && !ok("bitaxe-gamma-601", 1e13));
  });
});

describe("stats worker", () => {
  let env, store;
  beforeEach(() => {
    store = new Store(sqlite());
    env = { STATS_PASSWORD: "s3cret", STORE: { idFromName: (n) => n, get: () => store } };
  });
  const post = (body, ip = "1.2.3.4") => handler.fetch(new Request("https://stats.example/report", {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "CF-Connecting-IP": ip },
  }), env);
  const get = (path, password) => handler.fetch(new Request("https://stats.example" + path, {
    headers: password === undefined ? {} : { Authorization: "Basic " + btoa("me:" + password) },
  }), env);

  it("stores a miner's report and refuses anything else", async () => {
    assert.equal((await post(report(1.02e6))).status, 204);
    assert.equal((await post("{not json")).status, 400);
    assert.equal((await post({ v: "1.9.0" })).status, 400);
    assert.equal((await post("x".repeat(600))).status, 413);
    assert.equal((await handler.fetch(new Request("https://stats.example/report"), env)).status, 405);
    assert.equal(store.summary().miners, 1);
  });

  it("exposes only pool aggregates and rejects endpoint or credential payloads", async () => {
    delete env.STATS_PASSWORD;
    assert.equal((await post({ ...report(1e6), pool: "public-pool.io" })).status, 204);
    assert.equal((await post(report(1e6), "b")).status, 204);
    assert.equal((await post({ ...report(1e6), pool: "wallet:secret@private.example" })).status, 400);
    const summary = await (await get("/api/summary")).json();
    assert.deepEqual(summary.pools.map(({ name, miners }) => [name, miners]).sort(), [["public-pool.io", 1], ["unknown", 1]]);
    assert.doesNotMatch(JSON.stringify(summary), /wallet|secret|private\.example/);
    const page = await (await get("/")).text();
    assert.match(page, /<h2>Par pool<\/h2>/);
    assert.match(page, /BDLMiner 2\.0\.3, le partage de la pool est activé par défaut/);
    assert.match(page, /Les noms des pools mènent à leur site officiel/);
  });

  it("stores real V2 beta report shapes for ESP32 and Gamma while keeping hardware caps", async () => {
    const gamma = { v: "2.0.0-beta.1", board: "bitaxe-gamma-601", hashrate: 1.08e12, every: 300 };
    const m5 = { v: "2.0.0-beta.1", board: "m5stickc-plus2", hashrate: 1.02e6, every: 300 };
    assert.equal((await post(gamma)).status, 204);
    assert.equal((await post(m5)).status, 204);
    assert.equal((await post({ ...gamma, hashrate: 1e13 })).status, 400);
    assert.equal((await post({ ...m5, hashrate: 6e6 })).status, 400);
    const summary = store.summary();
    near(summary.hashrate, gamma.hashrate + m5.hashrate);
    assert.equal(summary.miners, 2);
    assert.deepEqual(summary.versions.map(({name, miners}) => [name, miners]), [["2.0.0-beta.1", 2]]);
  });

  it("shows the page and the summary to everyone", async () => {
    delete env.STATS_PASSWORD;
    await post(report(1e6));
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Hashrate total/);
    assert.equal(page.headers.get("Cache-Control"), "public, max-age=15");
    const summary = await get("/api/summary");
    assert.equal(summary.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal((await summary.json()).miners, 1);
  });

  it("keeps the page and the summary behind a password when one is set", async () => {
    await post(report(1e6));
    for (const path of ["/", "/api/summary"]) {
      const locked = await get(path);
      assert.equal(locked.status, 401);
      assert.match(locked.headers.get("WWW-Authenticate"), /^Basic /);
      assert.equal((await get(path, "wrong")).status, 401);
    }
    const page = await get("/", "s3cret");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Hashrate total/);
    assert.equal(page.headers.get("Cache-Control"), "no-store");
    const summary = await (await get("/api/summary", "s3cret")).json();
    assert.equal(summary.miners, 1);
    assert.equal((await get("/elsewhere", "s3cret")).status, 404);
  });

  it("checks the password only when one is set", () => {
    const request = new Request("https://x/", { headers: { Authorization: "Basic " + btoa("me:") } });
    assert.equal(authorized(new Request("https://x/"), undefined), true);
    assert.equal(authorized(request, ""), true);
    assert.equal(authorized(request, "p"), false);
    assert.equal(authorized(new Request("https://x/", { headers: { Authorization: "Basic !!!" } }), "p"), false);
  });
});


it("counts BTC and BCH separately without retaining account details", () => {
  const store = new Store(sqlite()), now = 1800000000000;
  const base = {v:"2.1.0",board:"esp32-headless",hashrate:1e6,every:300};
  for (const coin of ["BTC","BCH"]) {
    const parsed = parseReport({...base,coin,worker:"private",address:"secret"});
    assert.equal(parsed.coin,coin);assert.equal(parsed.worker,undefined);assert.equal(parsed.address,undefined);
    store.add(parsed,coin,now);
  }
  store.add(base,"legacy",now);
  const result = new Store(store.sql).summary(now+1000);
  assert.deepEqual(result.coins,[{name:"BTC",miners:2,hashrate:2e6},{name:"BCH",miners:1,hashrate:1e6}]);
  for (const coin of ["LTC","DOGE","bch","",1,null,"<script>"])
    assert.equal(parseReport({...base,coin}),null);
});
