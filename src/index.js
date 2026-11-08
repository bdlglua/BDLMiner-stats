// BDLMiner statistics: miners that share their hashrate (the "Share my
// hashrate anonymously" setting) post a report every 5 minutes to /report; the
// public page / shows the totals. They hold nothing about any one miner; a
// STATS_PASSWORD, if set, makes the page private again.

import { parseReport } from "./store.js";
import { PAGE } from "./page.js";
import { parseRemote, remoteKey, remoteMode } from './remote.js';
import { REMOTE_PAGE, REMOTE_APP, REMOTE_STYLE } from './remote-page.js';

const MAX_BODY = 512;

const privateHeaders = {
  'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
const privateJSON = (value, status = 200) => Response.json(value, { status, headers: privateHeaders });

// Space-separated viewer origins; the first is the address legacy links open.
const DEFAULT_VIEWERS = 'https://miner.bdl-pool.com https://bdlglua.github.io';
const viewerOrigins = env => (env.REMOTE_VIEWER_ORIGIN || DEFAULT_VIEWERS).split(/\s+/).filter(Boolean);

function remoteCors(request, env, url) {
  const origin = request.headers.get('Origin');
  if (origin && !viewerOrigins(env).includes(origin) && origin !== url.origin)
    return { error: privateJSON({ error: 'Origin not allowed' }, 403) };
  if (origin && url.pathname === '/api/remote/report')
    return { error: privateJSON({ error: 'Browser reports are not allowed' }, 403) };
  const cors = origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  if (request.method === 'OPTIONS') {
    const method = request.headers.get('Access-Control-Request-Method');
    const headers = (request.headers.get('Access-Control-Request-Headers') || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
    const methods = url.pathname === '/api/remote' ? ['GET', 'DELETE'] : url.pathname === '/api/remote/history' ? ['GET'] : [];
    if (!origin || !methods.includes(method) || headers.some(x => !['authorization', 'content-type'].includes(x)))
      return { error: privateJSON({ error: 'Preflight not allowed' }, 403) };
    return { error: new Response(null, { status: 204, headers: { ...privateHeaders, ...cors,
      'Access-Control-Allow-Methods': methods.join(', '), 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600' } }) };
  }
  return { headers: cors };
}

async function remoteBody(request) {
  if (!(request.headers.get('Content-Type') ?? '').startsWith('application/json')) return { status: 415 };
  const reader = request.body?.getReader();
  if (!reader) return { status: 400 };
  const chunks = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2048) { await reader.cancel(); return { status: 413 }; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { report: parseRemote(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }; }
  catch { return { status: 400 }; }
}

async function privateRoute(request, env, url) {
  const routes = ['/api/remote', '/api/remote/report', '/api/remote/history'];
  if (!routes.includes(url.pathname)) return privateJSON({ error: 'Not found' }, 404);
  const expected = url.pathname.endsWith('/report') ? ['POST'] : url.pathname.endsWith('/history') ? ['GET'] : ['GET', 'DELETE'];
  if (!expected.includes(request.method)) return privateJSON({ error: 'Method not allowed' }, 405);
  const key = await remoteKey(request);
  if (!key) return privateJSON({ error: 'Wallet address or private access key required' }, 401);
  if (!await store(env).remoteAllowed(request.headers.get('CF-Connecting-IP') ?? ''))
    return privateJSON({ error: 'Please wait before trying again' }, 429);
  const remote = env.REMOTE.get(env.REMOTE.idFromName(key));
  if (request.method === 'POST') {
    const body = await remoteBody(request);
    if (body.status || !body.report) return privateJSON({ error: 'Invalid private report' }, body.status || 400);
    const status = await remote.add(body.report);
    return new Response(null, { status, headers: privateHeaders });
  }
  if (request.method === 'DELETE') {
    // Anyone may know an address: only a private key can erase its space.
    // Readings sent by address expire on their own after seven days.
    if (remoteMode(request) !== 'key') return privateJSON({ error: 'Only a private access key can erase readings' }, 403);
    await remote.revoke();
    return new Response(null, { status: 204, headers: privateHeaders });
  }
  const snapshot = await remote.snapshot();
  if (snapshot === null) return privateJSON({ error: 'This access key has been revoked' }, 410);
  if (url.pathname.endsWith('/history')) {
    const history = await remote.history(url.searchParams.get('miner') ?? '', Number(url.searchParams.get('hours') ?? 24));
    return history ? privateJSON(history) : privateJSON({ error: 'Invalid history window' }, 400);
  }
  return privateJSON(snapshot);
}

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

// The figures move with every report: a short cache only spares the Durable
// Object when many people look at once.
function headers(env, type) {
  const common = { "X-Frame-Options": "DENY", ...(type ? { "Content-Type": type } : {}) };
  return env.STATS_PASSWORD
    ? { ...common, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }
    : { ...common, "Cache-Control": "public, max-age=15", "Access-Control-Allow-Origin": "*" };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/remote')) {
      const cors = remoteCors(request, env, url);
      if (cors.error) return cors.error;
      const response = await privateRoute(request, env, url);
      for (const [name, value] of Object.entries(cors.headers)) response.headers.set(name, value);
      return response;
    }
    if ((url.pathname === '/remote' || url.pathname === '/remote/') && env.REMOTE_VIEWER_REDIRECT === 'true') {
      if (request.method !== 'GET') return privateJSON({ error: 'GET only' }, 405);
      return new Response(null, { status: 302, headers: { ...privateHeaders, Location: viewerOrigins(env)[0] + '/remote/' } });
    }
    const remoteAsset = { '/remote': [REMOTE_PAGE, 'text/html; charset=utf-8'],
      '/remote.js': [REMOTE_APP, 'text/javascript; charset=utf-8'], '/remote.css': [REMOTE_STYLE, 'text/css; charset=utf-8'] }[url.pathname];
    if (remoteAsset) {
      if (request.method !== 'GET') return privateJSON({ error: 'GET only' }, 405);
      return new Response(remoteAsset[0], { headers: { ...privateHeaders, 'Content-Type': remoteAsset[1] } });
    }

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
