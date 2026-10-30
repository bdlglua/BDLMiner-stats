import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import handler, { authorized } from "../src/index.js";
import { parseReport, Store } from "../src/store.js";

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

const HOUR = 3600 * 1000;
const T = Date.UTC(2026, 9, 30, 12, 0, 0);
const report = (hashrate, board = "m5stickc-plus2", v = "1.9.0") => ({ v, board, hashrate });

describe("stats store", () => {
  let store;
  beforeEach(() => { store = new Store(sqlite()); });

  it("adds up the reports of the last hour, by board and version", () => {
    store.add(report(1e6), "a", T - 2 * HOUR);  // older than the window
    store.add(report(1e6), "a", T - 30 * 60000);
    store.add(report(2e6, "esp32-headless"), "b", T - 10 * 60000);
    store.add(report(3e6, "esp32-headless", "1.8.0"), "c", T - 60000);
    const s = store.summary(T);
    assert.equal(s.miners, 3);
    assert.equal(s.hashrate, 6e6);
    assert.deepEqual(s.boards, [{ name: "esp32-headless", miners: 2, hashrate: 5e6 }, { name: "m5stickc-plus2", miners: 1, hashrate: 1e6 }]);
    assert.deepEqual(s.versions.map((v) => v.name), ["1.9.0", "1.8.0"]);
  });

  it("keeps a history per full hour and the best hour", () => {
    store.add(report(1e6), "a", T - 3 * HOUR + 1000);
    store.add(report(2e6), "b", T - 3 * HOUR + 2000);
    store.add(report(1e6), "a", T - 2 * HOUR + 1000);
    store.add(report(5e6), "a", T + 1000);  // the hour still filling up
    const s = store.summary(T + 2000);
    assert.deepEqual(s.history, [{ at: T - 3 * HOUR, miners: 2, hashrate: 3e6 }, { at: T - 2 * HOUR, miners: 1, hashrate: 1e6 }]);
    assert.deepEqual(s.record, { at: T, hashrate: 5e6 });
  });

  it("limits the reports per address, and forgets old ones", () => {
    for (let i = 0; i < 30; i++) assert.equal(store.add(report(1e6), "flood", T + i), true);
    assert.equal(store.add(report(1e6), "flood", T + 31), false);
    assert.equal(store.add(report(1e6), "other", T + 32), true);
    assert.equal(store.add(report(1e6), "flood", T + HOUR + 1), true);
    store.add(report(1e6), "x", T + 40 * 24 * HOUR);  // prunes what is older than 35 days
    assert.equal(store.summary(T + 40 * 24 * HOUR).history.length, 0);
  });

  it("accepts only what a miner sends", () => {
    assert.deepEqual(parseReport({ v: "1.9.0", board: "nerdnos", hashrate: 1.5e11 }), { v: "1.9.0", board: "nerdnos", hashrate: 1.5e11 });
    for (const bad of [null, {}, { v: "1.9", board: "x", hashrate: 1 }, { v: "1.9.0", board: "Bad Board", hashrate: 1 },
      { v: "1.9.0", board: "x", hashrate: 0 }, { v: "1.9.0", board: "x", hashrate: 1e14 }, { v: "1.9.0", board: "x", hashrate: "1e6" }])
      assert.equal(parseReport(bad), null, JSON.stringify(bad));
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

  it("shows the page and the summary to everyone", async () => {
    delete env.STATS_PASSWORD;
    await post(report(1e6));
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Hashrate total/);
    assert.equal(page.headers.get("Cache-Control"), "public, max-age=60");
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
