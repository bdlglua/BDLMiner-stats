// Compatibility for installed firmware that embeds workers.dev. New firmware
// and the website contact the native collector directly. This adapter never
// reads/writes a Durable Object; the Worker request allowance still applies.
const PATHS = new Set(['/report', '/api/summary', '/api/remote', '/api/remote/report',
  '/api/remote/history', '/healthz', '/remote.js', '/remote.css']);
const PRIVATE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

export async function relay(request, destination, viewers) {
  const source = new URL(request.url);
  let target;
  try {
    target = new URL(destination);
    if (target.origin !== destination || target.protocol !== 'https:' || target.username || target.password || target.origin === source.origin)
      throw new Error();
  } catch { return Response.json({ error: 'Collector unavailable' }, { status: 503, headers: PRIVATE }); }
  if (['/', '/remote', '/remote/'].includes(source.pathname)) {
    if (request.method !== 'GET') return new Response('GET only', { status: 405, headers: PRIVATE });
    return new Response(null, { status: 302, headers: { ...PRIVATE,
      Location: viewers[0] + (source.pathname === '/' ? '/stats.html' : '/remote/') } });
  }
  if (!PATHS.has(source.pathname)) return new Response('Not found', { status: 404, headers: PRIVATE });
  target.pathname = source.pathname;
  target.search = source.search;
  const headers = new Headers();
  for (const name of ['Authorization', 'Content-Type', 'Origin', 'Accept', 'Access-Control-Request-Method', 'Access-Control-Request-Headers']) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  // The old same-origin viewer had implicit access to its own API. Its
  // original origin is validated by index.js before it reaches this adapter.
  if (headers.get('Origin') === source.origin) headers.set('Origin', target.origin);
  try {
    const response = await fetch(target, { method: request.method, headers,
      ...(!['GET', 'HEAD'].includes(request.method) && request.body ? { body: request.body, duplex: 'half' } : {}),
      redirect: 'manual', signal: AbortSignal.timeout(15000) });
    // Never send an access value through a redirect or silently fall back to
    // a separate database: both can break privacy or split miner histories.
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error(); }
    return new Response(response.body, { status: response.status, headers: response.headers });
  } catch {
    return Response.json({ error: 'Collector temporarily unavailable' }, { status: 503,
      headers: { ...PRIVATE, 'Retry-After': '15',
        ...(source.pathname === '/api/summary' ? { 'Access-Control-Allow-Origin': '*' } : {}) } });
  }
}
