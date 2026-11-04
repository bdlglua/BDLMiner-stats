// The actual Worker, Durable Objects and private viewer on loopback only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
async function main(){
 const port=await freePort(),inspect=await freePort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bdl-private-test-')),url='http://127.0.0.1:'+port;
 const child=spawn(path.resolve('node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspect),'--persist-to',dir],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs+=chunk);
 let browser;
 try{
  const ready=Date.now()+45000;let active=false;
  while(Date.now()<ready){try{active=(await fetch(url+'/remote')).ok;if(active)break}catch{}await new Promise(r=>setTimeout(r,200))}
  assert.ok(active,'Local Worker did not start: '+logs.slice(-3000));
  const key='13'.repeat(32),other='24'.repeat(32);
  const report=(id,name,board,rate)=>({id,name,board,v:'2.3.0',coin:'BTC',boot_id:'aabbccdd',uptime_s:600,total_hashes:rate*600,hashrate:rate,temp_c:48,accepted:3,rejected:0,best:125,power_percent:100,pool_connected:true,pool:'public-pool.io',firmware_trial:false});
  const auth={Authorization:'Bearer '+key};
  for(const data of [report('0123456789abcdef','M5 bureau','m5stickc-plus2',1e6),report('fedcba9876543210','<img src=x onerror=window.bad=1>','bitaxe-gamma-601',1e12)]){
   const response=await fetch(url+'/api/remote/report',{method:'POST',headers:{...auth,'Content-Type':'application/json'},body:JSON.stringify(data)});assert.equal(response.status,204);
  }
  assert.equal((await fetch(url+'/api/remote')).status,401);
  const second=await(await fetch(url+'/api/remote',{headers:{Authorization:'Bearer '+other}})).json();assert.deepEqual(second.miners,[]);
  const executablePath=process.env.BDL_CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  browser=await chromium.launch({headless:true,executablePath,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},locale:'fr-FR'}),failures=[],urls=[];
  page.on('pageerror',e=>failures.push(e.message));page.on('request',r=>urls.push(r.url()));
  await page.goto(url+'/remote');await page.waitForSelector('#login-form');
  await page.locator('#key').fill(key);await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  assert.equal(await page.locator('.miner').count(),2);assert.equal(await page.locator('.miner img').count(),0);assert.equal(await page.evaluate(()=>window.bad),undefined);
  assert.match(await page.locator('#total').textContent(),/1 T/);assert.match(await page.locator('.miner').first().textContent(),/Température/);
  assert.equal(await page.locator('.miner button,.miner input,.miner select').count(),0);
  await page.waitForFunction(()=>document.querySelector('#history-note').textContent.includes('interruptions'));
  assert.equal(await page.locator('#login').isVisible(),false);assert.equal(await page.locator('#key').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
  assert.ok(urls.every(value=>value.startsWith(url+'/')));assert.ok(urls.every(value=>!value.includes(key)&&!value.includes(other)));
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.BDL_SCREENSHOT_DIR){fs.mkdirSync(process.env.BDL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BDL_SCREENSHOT_DIR,'private-remote-mobile.png'),fullPage:true})}
  let release,started;const pending=new Promise(r=>started=r);
  await page.route('**/api/remote',async route=>{if(route.request().method()!=='GET')return route.continue();started();await new Promise(r=>release=r);await route.fulfill({json:{miners:[report('0123456789abcdef','LATE SECRET','m5stickc-plus2',1e6)],hashrate:1e6,recorded_at:Date.now()}})});
  await page.waitForTimeout(31000).then(()=>pending);
  await page.locator('#logout').click();assert.equal(await page.locator('.miner').count(),0);assert.equal(await page.locator('#login').isVisible(),true);
  release();await page.waitForTimeout(150);assert.doesNotMatch(await page.locator('body').textContent(),/LATE SECRET/);assert.equal(await page.locator('.miner').count(),0);
  await page.unroute('**/api/remote');
  await page.locator('#key').fill(key);await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  await page.locator('#lang').selectOption('en');assert.match(await page.locator('h1').textContent(),/Keep an eye/);
  await page.locator('#manage summary').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#revoke').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Data erased'));
  assert.equal(await page.locator('.miner').count(),0);assert.equal((await fetch(url+'/api/remote',{headers:auth})).status,410);
  await page.locator('#generate').click();const generated=await page.locator('#key').inputValue();assert.match(generated,/^[a-f0-9]{64}$/);assert.notEqual(generated,key);
  await page.reload();assert.equal(await page.locator('#key').inputValue(),'');assert.equal(await page.locator('.miner').count(),0);
  assert.deepEqual(failures,[]);
  console.log('PASS private remote browser: real Worker/SQLite, account isolation, French/English, mobile, safe text, history, no browser key storage, logout races and irreversible revocation.');
 }finally{
  if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,2000)});fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
