// Entry point of the statistics Worker: the request handler and the Durable
// Object holding the statistics (kept apart so that the tests can import the
// rest without the Workers runtime).

import { DurableObject } from "cloudflare:workers";
import { Store } from "./store.js";

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
