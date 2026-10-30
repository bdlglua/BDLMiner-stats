// Entry point of the statistics Worker: the request handler and the Durable
// Object holding the reports (kept apart so that the tests can import the
// rest without the Workers runtime).

import { DurableObject } from "cloudflare:workers";
import { Store } from "./store.js";

export { default } from "./index.js";

export class StatsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx.storage.sql);
  }

  add(report, address) {
    return this.store.add(report, address);
  }

  summary() {
    return this.store.summary();
  }
}
