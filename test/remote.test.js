import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import handler from '../src/index.js';
import { Store } from '../src/store.js';
import { PrivateStore, parseRemote, remoteKey, REMOTE_KEEP } from '../src/remote.js';
import { REMOTE_APP, REMOTE_PAGE } from '../src/remote-page.js';
import { remoteFiles, REMOTE_API_ORIGIN } from '../src/remote-site.js';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return { exec(query, ...bindings) {
    const statement = db.prepare(query);
    const rows = /^\s*SELECT/i.test(query) ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows.map(row => ({ ...row })) };
  } };
}
const keyA = '11'.repeat(32), keyB = '22'.repeat(32);
const report = (id = '0123456789abcdef') => ({ id, name: 'M5 bureau', v: '2.3.0', board: 'm5stickc-plus2', coin: 'BTC', boot_id: '1234abcd', uptime_s: 600, total_hashes: 6e8, hashrate: 1e6, temp_c: 48, accepted: 1, rejected: 0, best: 125, power_percent: 100, pool_connected: true, pool: 'public-pool.io', firmware_trial: false });
function environment() {
  const spaces = new Map(), publicStore = new Store(sqlite());
  return { spaces, publicStore,
    STORE: { idFromName: x => x, get: () => ({ remoteAllowed: () => true, summary: () => publicStore.summary() }) },
    REMOTE: { idFromName: x => x, get(id) {
      if (!spaces.has(id)) spaces.set(id, new PrivateStore(sqlite()));
      const s = spaces.get(id);
      return { add: r => s.add(r), snapshot: () => s.revoked() ? null : s.snapshot(), history: (m,h) => s.revoked() ? null : s.history(m,h), revoke: () => s.revoke() };
    } },
  };
}
function request(path, key, method = 'GET', body, extra = {}) {
  return new Request('https://stats.test' + path, { method, headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}

describe('private remote monitoring', () => {
  it('allows authenticated cross-origin reads only from the configured viewer', async () => {
    const env=environment(), origin='https://bdlglua.github.io';
    const missing=await handler.fetch(request('/api/remote',undefined,'GET',undefined,{Origin:origin}),env);
    assert.equal(missing.status,401);assert.equal(missing.headers.get('Access-Control-Allow-Origin'),origin);
    assert.equal(missing.headers.get('Access-Control-Allow-Credentials'),null);
    assert.equal(missing.headers.get('Cache-Control'),'no-store');assert.equal(missing.headers.get('Vary'),'Origin');
    const good=await handler.fetch(request('/api/remote',keyA,'GET',undefined,{Origin:origin}),env);
    assert.equal(good.status,200);assert.equal(good.headers.get('Access-Control-Allow-Origin'),origin);
    for(const bad of ['https://attacker.test','https://bdlglua.github.io.attacker.test','http://bdlglua.github.io','null']){
      const response=await handler.fetch(request('/api/remote',keyA,'GET',undefined,{Origin:bad}),env);
      assert.equal(response.status,403);assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    }
  });
  it('answers browser preflights without authorizing a private read or report', async () => {
    const env=environment(), Origin='https://bdlglua.github.io';
    for(const method of ['GET','DELETE']){
      const response=await handler.fetch(request('/api/remote',undefined,'OPTIONS',undefined,{Origin,'Access-Control-Request-Method':method,'Access-Control-Request-Headers':'authorization'}),env);
      assert.equal(response.status,204);assert.equal(response.headers.get('Access-Control-Allow-Origin'),Origin);
      assert.match(response.headers.get('Access-Control-Allow-Headers'),/Authorization/);
    }
    for(const extra of [
      {'Access-Control-Request-Method':'POST'},
      {'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'x-arbitrary'},
      {Origin:'https://bad.test','Access-Control-Request-Method':'GET'},
    ])assert.equal((await handler.fetch(request('/api/remote',undefined,'OPTIONS',undefined,{Origin,...extra}),env)).status,403);
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST',report(),{Origin}),env)).status,403);
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST',report()),env)).status,204);
    assert.equal((await handler.fetch(request('/api/remote',undefined,'GET',undefined,{Origin}),env)).status,401);
  });
  it('packages a standalone viewer with relative assets and an explicit API policy', () => {
    const files=remoteFiles();assert.deepEqual(Object.keys(files).sort(),['index.html','remote.css','remote.js']);
    assert.match(files['index.html'],/href="\.\/remote.css"/);assert.match(files['index.html'],/src="\.\/remote.js"/);
    assert.ok(files['index.html'].includes('connect-src '+REMOTE_API_ORIGIN));
    assert.ok(files['index.html'].includes('name="referrer" content="no-referrer"'));
    assert.ok(files['index.html'].includes('name="bdl-remote-api" content="'+REMOTE_API_ORIGIN+'"'));
    assert.match(files['remote.js'],/credentials:'omit'/);assert.match(files['remote.js'],/redirect:'error'/);
    for(const origin of ['http://outside.test','https://user:pass@example.com','https://example.com/path','https://example.com/','javascript:alert(1)'])
      assert.throws(()=>remoteFiles(origin));
  });
  it('redirects the legacy viewer only when migration is enabled and never forwards a key', async () => {
    const env=environment();env.REMOTE_VIEWER_REDIRECT='true';
    for(const path of ['/remote','/remote/','/remote?key='+keyA]){
      const response=await handler.fetch(request(path),env);
      assert.equal(response.status,302);assert.equal(response.headers.get('Location'),'https://bdlglua.github.io/remote/');
      assert.equal(response.headers.get('Cache-Control'),'no-store');
    }
    assert.equal((await handler.fetch(request('/api/remote'),env)).status,401);
  });
  it('accepts paused/disconnected reports and persists only the whitelist', () => {
    const raw = { ...report(), hashrate: 0, temp_c: null, pool_connected: false, pool: 'unknown', address: 'NEVER_STORE', password: 'NEVER_STORE', key: keyA, ip: 'NEVER_STORE' };
    const parsed = parseRemote(raw);
    assert.equal(parsed.hashrate, 0);assert.equal(parsed.temp_c, null);
    assert.doesNotMatch(JSON.stringify(parsed), /NEVER_STORE|1111111111111111/);
    for (const change of [{ id: '../bad' }, { coin: 'DOGE' }, { hashrate: Infinity }, { hashrate: 1e15 }, { hashrate: -1 }, { accepted: 1.2 }, { temp_c: 200 }, { power_percent: 101 }, { pool: '192.168.1.10' }, { boot_id: 'private' }, { name: 'x'.repeat(49) }, { name: 'line\nfeed' }, { pool_connected: 'yes' }])
      assert.equal(parseRemote({ ...report(), ...change }), null, JSON.stringify(change));
  });
  it('retains Peercoin in private monitoring without adding it to public totals', async () => {
    const env = environment();
    const ppc = { ...report(), v: '2.4.0', coin: 'PPC', pool: 'other' };
    assert.equal((await handler.fetch(request('/api/remote/report', keyA, 'POST', ppc), env)).status, 204);
    const mine = await (await handler.fetch(request('/api/remote', keyA), env)).json();
    assert.equal(mine.miners[0].coin, 'PPC');
    assert.equal(mine.hashrate, ppc.hashrate);
    assert.equal(env.publicStore.summary().miners, 0);
  });
  it('isolates access keys and never adds personal reports to public statistics', async () => {
    const env = environment();
    assert.equal((await handler.fetch(request('/api/remote/report', keyA, 'POST', report()), env)).status, 204);
    const mine = await (await handler.fetch(request('/api/remote', keyA), env)).json();
    const other = await (await handler.fetch(request('/api/remote', keyB), env)).json();
    assert.equal(mine.miners.length, 1);assert.equal(other.miners.length, 0);
    assert.equal(mine.hashrate, 1e6);assert.equal(env.publicStore.summary().miners, 0);
    const names = [...env.spaces.keys()];assert.equal(names.length, 2);
    assert.ok(names.every(x => /^[a-f0-9]{64}$/.test(x) && x !== keyA && x !== keyB));
    assert.equal(await remoteKey(request('/api/remote', keyA)), names[0]);
  });
  it('requires a bearer key for every personal route and refuses other methods', async () => {
    const env = environment();
    for (const [path, method, body] of [['/api/remote','GET'],['/api/remote','DELETE'],['/api/remote/history?miner=0123456789abcdef','GET'],['/api/remote/report','POST',report()]]) {
      for (const key of [undefined, 'short', 'AA'.repeat(32)]) {
        const response = await handler.fetch(request(path, key, method, body), env);
        assert.equal(response.status, 401);assert.equal(response.headers.get('Cache-Control'), 'no-store');
        assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
      }
    }
    assert.equal(env.spaces.size, 0);
    assert.equal((await handler.fetch(request('/api/remote?key=' + keyA),env)).status,401);
    for (const [path,method] of [['/api/remote','POST'],['/api/remote/report','GET'],['/api/remote/history','DELETE']])
      assert.equal((await handler.fetch(request(path,keyA,method),env)).status,405);
  });
  it('bounds the request body, validates history windows and enforces admission limits', async () => {
    const env = environment();
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST','x'.repeat(2049)),env)).status,413);
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST','bad'),env)).status,400);
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST',report(),{'Content-Type':'text/plain'}),env)).status,415);
    assert.equal((await handler.fetch(request('/api/remote/history?miner=0123456789abcdef&hours=100000',keyA),env)).status,400);
    env.STORE.get = () => ({ remoteAllowed: () => false });
    assert.equal((await handler.fetch(request('/api/remote',keyA),env)).status,429);
  });
  it('keeps bounded history across restarts and expires readings after seven days', () => {
    const s=new PrivateStore(sqlite()), t=1800000000000;
    assert.equal(s.add(report(),t),204);
    assert.equal(s.add(report(),t+1000),429);
    assert.equal(s.add({...report(),boot_id:'aabbccdd'},t+60000),204);
    const rebooted=new PrivateStore(s.sql);
    assert.equal(rebooted.history(report().id,24,t+60000).points[0].mixed_boots,true);
    assert.equal(rebooted.snapshot(t+800000).hashrate,0);
    assert.equal(rebooted.snapshot(t+800000).miners[0].online,false);
    assert.equal(rebooted.snapshot(t+REMOTE_KEEP+60001).miners.length,0);
    assert.deepEqual(rebooted.history(report().id,168,t+REMOTE_KEEP+60001).points,[]);
  });
  it('caps a private space at 32 miners', () => {
    const s=new PrivateStore(sqlite()),t=1800000000000;
    for(let i=0;i<32;i++)assert.equal(s.add(report(i.toString(16).padStart(16,'0')),t),204);
    assert.equal(s.add(report('ffffffffffffffff'),t),409);
    assert.equal(s.snapshot(t).miners.length,32);
  });
  it('revokes an access key durably and erases its readings without affecting another key', async () => {
    const env=environment();
    for(const key of [keyA,keyB])assert.equal((await handler.fetch(request('/api/remote/report',key,'POST',report()),env)).status,204);
    assert.equal((await handler.fetch(request('/api/remote',keyA,'DELETE'),env)).status,204);
    assert.equal((await handler.fetch(request('/api/remote',keyA),env)).status,410);
    assert.equal((await handler.fetch(request('/api/remote/report',keyA,'POST',report()),env)).status,410);
    assert.equal((await handler.fetch(request('/api/remote/history?miner=0123456789abcdef',keyA),env)).status,410);
    const s=env.spaces.get(await remoteKey(request('/api/remote',keyA)));
    assert.equal(new PrivateStore(s.sql).revoked(),true);assert.deepEqual(s.snapshot().miners,[]);
    assert.equal((await (await handler.fetch(request('/api/remote',keyB),env)).json()).miners.length,1);
  });
  it('serves an isolated viewer without inline scripts or third-party resources', async () => {
    new vm.Script(REMOTE_APP);
    const env=environment();
    for(const path of ['/remote','/remote.js','/remote.css']){
      const response=await handler.fetch(request(path),env);
      assert.equal(response.status,200);assert.match(response.headers.get('Content-Security-Policy'),/connect-src 'self'/);
      assert.equal(response.headers.get('Cache-Control'),'no-store');assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
    }
    assert.doesNotMatch(REMOTE_PAGE,/<script[^>]*>[^<]+<\/script>/);
    assert.doesNotMatch(REMOTE_APP,/localStorage|sessionStorage/);
  });
});
