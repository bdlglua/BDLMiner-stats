import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import handler from '../src/index.js';

const native = 'https://api.bdl-pool.com:36018';
const legacy = 'https://bdlminer-stats.bdlminer-bot.workers.dev';
const env = { SELF_HOSTED_ORIGIN: native,
  STORE: { get() { throw Error('Legacy database must not be touched'); } },
  REMOTE: { get() { throw Error('Legacy database must not be touched'); } } };
const request = (path, options = {}) => new Request(legacy + path, options);

test('legacy firmware sends its original body and authentication only to the verified native origin', async () => {
  const auth = 'Bearer ' + '19'.repeat(32);
  const mocked = mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), native + '/api/remote/report');
    assert.equal(options.headers.get('Authorization'), auth);
    for (const name of ['Cookie', 'CF-Connecting-IP', 'X-Forwarded-For']) assert.equal(options.headers.get(name), null);
    assert.equal(await new Response(options.body).text(), '{"hashrate":42}');
    assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 204 });
  });
  try {
    const response = await handler.fetch(request('/api/remote/report', { method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', Cookie: 'private',
        'CF-Connecting-IP': 'spoofed', 'X-Forwarded-For': 'spoofed' }, body: '{"hashrate":42}' }), env);
    assert.equal(response.status, 204); assert.equal(mocked.mock.calls.length, 1);
  } finally { mocked.mock.restore(); }
});

test('legacy cross-origin reads retain exact CORS and browser reports remain forbidden', async () => {
  const mocked = mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.get('Origin'), 'https://miner.bdl-pool.com');
    return Response.json({ error: 'Access required' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
  });
  try {
    const Origin = 'https://miner.bdl-pool.com';
    const response = await handler.fetch(request('/api/remote', { headers: { Origin } }), env);
    assert.equal(response.status, 401); assert.equal(response.headers.get('Access-Control-Allow-Origin'), Origin);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await handler.fetch(request('/api/remote', { headers: { Origin: 'https://evil.test' } }), env)).status, 403);
    assert.equal((await handler.fetch(request('/api/remote/report', { method: 'POST', headers: { Origin } }), env)).status, 403);
    assert.equal(mocked.mock.calls.length, 1);
  } finally { mocked.mock.restore(); }
});

test('old viewer redirects never carry a query or access value', async () => {
  for (const [path, destination] of [['/', '/stats.html'], ['/remote?key=secret', '/remote/']]) {
    const response = await handler.fetch(request(path), env);
    assert.equal(response.status, 302); assert.equal(response.headers.get('Location'), 'https://miner.bdl-pool.com' + destination);
  }
});

test('network failures and upstream redirects never use legacy storage or forward credentials elsewhere', async () => {
  for (const answer of [() => { throw Error('offline'); }, () => new Response(null, { status: 302, headers: { Location: 'https://other.test/' } })]) {
    const mocked = mock.method(globalThis, 'fetch', async () => answer());
    try {
      const response = await handler.fetch(request('/api/summary'), env);
      assert.equal(response.status, 503); assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(response.headers.get('Location'), null);
    } finally { mocked.mock.restore(); }
  }
  for (const destination of ['http://api.example.com', native + '/path', 'https://user:pass@example.com', legacy])
    assert.equal((await handler.fetch(request('/api/summary'), { ...env, SELF_HOSTED_ORIGIN: destination })).status, 503);
});
