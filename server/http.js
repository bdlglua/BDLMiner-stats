import { createServer } from 'node:http';
import handler from '../src/index.js';
import { LocalState } from './state.js';

const DEFAULT_VIEWERS = 'https://miner.bdl-pool.com https://bdlglua.github.io';

function limit(maximum) {
  let minute = -1, count = 0;
  return () => {
    const now = Math.floor(Date.now() / 60000);
    if (now !== minute) { minute = now; count = 0; }
    return ++count <= maximum;
  };
}

export function origin(value) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))))
    throw new Error('Use an HTTPS origin without a path');
  return value;
}

export function createCollector({ directory, publicOrigin = 'https://api.bdl-pool.com:36018',
  viewerOrigins = DEFAULT_VIEWERS, requestsPerMinute = 1200, reportsPerMinute = 300,
  maxSpaces = 2048, maxOpen = 32, timers = true } = {}) {
  origin(publicOrigin);
  for (const value of viewerOrigins.split(/\s+/).filter(Boolean)) origin(value);
  for (const value of [requestsPerMinute, reportsPerMinute, maxSpaces, maxOpen])
    if (!Number.isInteger(value) || value < 1 || value > 1000000) throw new Error('Invalid resource limit');
  const state = new LocalState(directory, { maxSpaces, maxOpen });
  const env = { REMOTE_VIEWER_ORIGIN: viewerOrigins, REMOTE_VIEWER_REDIRECT: 'true',
    STORE: { idFromName: name => name, get: () => state.publicAdapter },
    REMOTE: { idFromName: name => name, get: id => state.remote(id) } };
  const admit = limit(requestsPerMinute), admitReport = limit(reportsPerMinute);
  const allowed = new Set(viewerOrigins.split(/\s+/).filter(Boolean).concat(publicOrigin));
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 10000,
    requestTimeout: 15000, keepAliveTimeout: 5000 }, async (incoming, outgoing) => {
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.length > 2048)
        throw Object.assign(new Error(), { status: 400 });
      const url = new URL(incoming.url, publicOrigin);
      if (url.pathname === '/healthz' && ['GET', 'HEAD'].includes(incoming.method)) {
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        outgoing.end(incoming.method === 'HEAD' ? undefined : JSON.stringify({ status: 'ok', service: 'bdlminer-stats', storage: 'sqlite' }));
        return;
      }
      if (!admit() || (incoming.method === 'POST' && !admitReport()))
        throw Object.assign(new Error(), { status: 429 });
      const maximum = url.pathname === '/report' ? 512 : 2048;
      if ((incoming.headers['content-encoding'] ?? 'identity') !== 'identity')
        throw Object.assign(new Error(), { status: 415 });
      if (Number(incoming.headers['content-length']) > maximum)
        throw Object.assign(new Error(), { status: 413 });
      let length = 0; const chunks = [];
      for await (const chunk of incoming) {
        length += chunk.length;
        if (length > maximum) throw Object.assign(new Error(), { status: 413 });
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (['host', 'cf-connecting-ip', 'forwarded', 'x-forwarded-for', 'x-real-ip'].includes(name) || value === undefined) continue;
        headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(url, { method: incoming.method, headers,
        ...(!['GET', 'HEAD'].includes(incoming.method) && length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handler.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const status = [400, 413, 415, 429, 503].includes(error.status) ? error.status : 500;
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', Connection: 'close' };
      if (allowed.has(incoming.headers.origin)) {
        headers['Access-Control-Allow-Origin'] = incoming.headers.origin; headers.Vary = 'Origin';
      }
      if (status === 429 || status === 503) headers['Retry-After'] = '60';
      if (!outgoing.headersSent) outgoing.writeHead(status, headers);
      outgoing.end(JSON.stringify({ error: status === 500 ? 'Service unavailable' :
        status === 429 ? 'Please wait before trying again' : status === 503 ? 'Storage capacity reached' : 'Invalid request' }));
      // No request URLs, authorization values, bodies, IPs or SQLite errors in logs.
      if (status === 500) console.error('Statistics request failed');
    }
  });
  const intervals = timers ? [setInterval(() => state.sample(), 30000), setInterval(() => state.prune(), 3600000)] : [];
  for (const timer of intervals) timer.unref();
  return { server, state, async close() {
    for (const timer of intervals) clearInterval(timer);
    await new Promise(resolve => server.close(resolve)); state.close();
  } };
}
