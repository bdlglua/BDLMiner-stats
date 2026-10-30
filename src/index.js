// BDLMiner statistics: miners that share their hashrate (the "Share my
// hashrate anonymously" setting) post a report every hour to /report; the
// public page / shows the totals. They hold nothing about any one miner; a
// STATS_PASSWORD, if set, makes the page private again.

import { parseReport } from "./store.js";
import { PAGE } from "./page.js";

const MAX_BODY = 512;

function store(env) {
  return env.STORE.get(env.STORE.idFromName("global"));
}

// HTTP Basic, only when a password is set: the browser asks once and remembers.
export function authorized(request, password) {
  if (!password) return true;
  const header = request.headers.get("Authorization") ?? "";
  if (!header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return false;
  }
  const given = decoded.slice(decoded.indexOf(":") + 1);
  // Same time whatever the first difference.
  let diff = given.length ^ password.length;
  for (let i = 0; i < password.length; i++) diff |= password.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0;
}

const LOCKED = () => new Response("Password required", {
  status: 401, headers: { "WWW-Authenticate": 'Basic realm="BDLMiner stats", charset="UTF-8"' },
});

// Public figures change once a minute at most: a short cache spares the
// Durable Object when many people look.
function headers(env, type) {
  const common = { "X-Frame-Options": "DENY", ...(type ? { "Content-Type": type } : {}) };
  return env.STATS_PASSWORD
    ? { ...common, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
    : { ...common, "Cache-Control": "public, max-age=60", "Access-Control-Allow-Origin": "*" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/report") {
      if (request.method !== "POST") return new Response("POST only", { status: 405 });
      const text = await request.text();
      if (text.length > MAX_BODY) return new Response("Too large", { status: 413 });
      let report;
      try {
        report = parseReport(JSON.parse(text));
      } catch {
        report = null;
      }
      if (!report) return new Response("Bad report", { status: 400 });
      // The address only limits the number of reports; it is never stored.
      const address = request.headers.get("CF-Connecting-IP") ?? "";
      const accepted = await store(env).add(report, address);
      return new Response(null, { status: accepted ? 204 : 429 });
    }

    if (url.pathname === "/" || url.pathname === "/api/summary") {
      if (request.method !== "GET") return new Response("GET only", { status: 405 });
      if (!authorized(request, env.STATS_PASSWORD)) return LOCKED();
      if (url.pathname === "/") return new Response(PAGE, { headers: headers(env, "text/html; charset=utf-8") });
      return Response.json(await store(env).summary(), { headers: headers(env) });
    }

    return new Response("Not found", { status: 404 });
  },
};
