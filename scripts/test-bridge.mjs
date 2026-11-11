// Guard tests run with SELF_HOSTED_ORIGIN empty, so no upstream is contacted.
import assert from 'node:assert/strict';
const base=new URL(process.env.BDL_LOCAL_URL||'http://127.0.0.1:8900');if(base.protocol!=='http:'||!['127.0.0.1','localhost'].includes(base.hostname))throw Error('Local bridge URL required');const origin='https://miner.bdl-pool.com';
const legacy=await fetch(new URL('/remote',base),{redirect:'manual'});assert.equal(legacy.status,302);assert.equal(legacy.headers.get('location'),origin+'/remote/');
const options={method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'}};let r=await fetch(new URL('/api/remote',base),options);assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);assert.equal(r.headers.get('access-control-allow-credentials'),null);
r=await fetch(new URL('/api/remote',base),{...options,headers:{...options.headers,Origin:'https://evil.example'}});assert.equal(r.status,403);
r=await fetch(new URL('/api/remote/report',base),{method:'POST',headers:{Origin:origin},body:'{}'});assert.equal(r.status,403);
r=await fetch(new URL('/api/summary',base));assert.equal(r.status,503);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('x-content-type-options'),'nosniff');assert.equal((await r.json()).error,'Collector unavailable');
console.log('PASS Rust compatibility Worker: exported bindings, legacy redirects, exact-origin preflight, browser-report rejection and safe unavailable response without upstream traffic');
