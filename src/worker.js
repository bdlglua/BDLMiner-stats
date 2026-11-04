// Entry point of the statistics Worker: the request handler and the Durable
// Object holding the statistics (kept apart so that the tests can import the
// rest without the Workers runtime).

import { DurableObject } from "cloudflare:workers";
import { Store } from "./store.js";
import { PrivateStore } from './remote.js';

export { default } from "./index.js";

export class StatsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
  }

  async add(report, address) {
    const accepted = this.store.add(report, address);
    await this.schedule();
    return accepted;
  }

  async summary() {
    const summary = this.store.summary();
    await this.schedule();
    return summary;
  }

  remoteAllowed(address) {
    this.remoteAddresses ??= new Map();
    const now = Date.now();
    if (this.remoteAddresses.size >= 10000) {
      for (const [ip, limit] of this.remoteAddresses) if (limit.until <= now) this.remoteAddresses.delete(ip);
      if (!this.remoteAddresses.has(address) && this.remoteAddresses.size >= 10000) return false;
    }
    const current = this.remoteAddresses.get(address);
    if (current && current.until > now) return ++current.count <= 600;
    this.remoteAddresses.set(address, { count: 1, until: now + 3600000 });
    return true; // Addresses are in memory only, never in SQLite or reports.
  }

  // Takes the 5-minute samples on time, with or without reports.
  async alarm() {
    this.store.sampleDue();
    await this.schedule();
  }

  async schedule() {
    const next = this.store.nextSampleAt() + 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

export class RemoteStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new PrivateStore(ctx.storage.sql);
  }
  async add(report) {
    if (this.store.revoked()) return 410;
    // Arm expiry before persisting the first reading, so a process stop cannot
    // leave an unvisited private space without a cleanup alarm.
    await this.ctx.storage.setAlarm(Date.now() + 86400000);
    return this.ctx.storage.transactionSync(() => this.store.add(report));
  }
  snapshot() { return this.store.revoked() ? null : this.store.snapshot(); }
  history(miner, hours) { return this.store.revoked() ? null : this.store.history(miner, hours); }
  async revoke() {
    this.ctx.storage.transactionSync(() => this.store.revoke());
    await this.ctx.storage.deleteAlarm();
  }
  async alarm() {
    this.store.prune();
    if (this.store.snapshot().miners.length) await this.ctx.storage.setAlarm(Date.now() + 86400000);
  }
}
