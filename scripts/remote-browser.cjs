// The actual Worker, Durable Objects and private viewer on loopback only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const http=require('node:http');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
async function main(){
 const port=await freePort(),inspect=await freePort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bdl-private-test-')),url='http://127.0.0.1:'+port;
 const {remoteFiles}=await import('../src/remote-site.js'),files=remoteFiles(url);
 const site=http.createServer((request,response)=>{
  const name=request.url==='/remote/'?'index.html':request.url.startsWith('/remote/')?request.url.slice(8):'';
  if(!Object.hasOwn(files,name)){response.writeHead(404);response.end();return}
  response.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'});response.end(files[name]);
 });
 await new Promise(r=>site.listen(0,'127.0.0.1',r));const siteURL='http://127.0.0.1:'+site.address().port;
 const child=spawn(path.resolve('node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspect),'--persist-to',dir,'--var','REMOTE_VIEWER_ORIGIN:'+siteURL,'--var','REMOTE_VIEWER_REDIRECT:true'],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let logs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs+=chunk);
 let browser;
 try{
  const ready=Date.now()+45000;let active=false;
  while(Date.now()<ready){try{active=(await fetch(url+'/api/remote')).status===401;if(active)break}catch{}await new Promise(r=>setTimeout(r,200))}
  assert.ok(active,'Local Worker did not start: '+logs.slice(-3000));
  const legacy=await fetch(url+'/remote',{redirect:'manual'});assert.equal(legacy.status,302);assert.equal(legacy.headers.get('Location'),'https://bdlglua.github.io/remote/');
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
  await page.goto(siteURL+'/remote/');await page.waitForSelector('#login-form');
  await page.locator('#key').fill(key);await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  assert.equal(await page.locator('.miner').count(),2);assert.equal(await page.locator('.miner img').count(),0);assert.equal(await page.evaluate(()=>window.bad),undefined);
  assert.match(await page.locator('#total').textContent(),/1 T/);assert.match(await page.locator('.miner').first().textContent(),/Température/);
  assert.equal(await page.locator('.miner button,.miner input,.miner select').count(),0);
  await page.waitForFunction(()=>document.querySelector('#history-note').textContent.includes('interruptions'));
  assert.equal(await page.locator('#login').isVisible(),false);assert.equal(await page.locator('#key').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
  assert.ok(urls.some(value=>value.startsWith(url+'/api/remote')),'static viewer must query the other origin');
  assert.ok(urls.every(value=>value.startsWith(url+'/')||value.startsWith(siteURL+'/')));assert.ok(urls.every(value=>!value.includes(key)&&!value.includes(other)));
  const refused=await fetch(url+'/api/remote',{headers:{...auth,Origin:'https://untrusted.example'}});assert.equal(refused.status,403);
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.BDL_SCREENSHOT_DIR){fs.mkdirSync(process.env.BDL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BDL_SCREENSHOT_DIR,'private-remote-mobile.png'),fullPage:true})}
  let release,started;const pending=new Promise(r=>started=r);
  await page.route('**/api/remote',async route=>{if(route.request().method()!=='GET')return route.continue();started();await new Promise(r=>release=r);await route.fulfill({headers:{'Access-Control-Allow-Origin':siteURL},json:{miners:[report('0123456789abcdef','LATE SECRET','m5stickc-plus2',1e6)],hashrate:1e6,recorded_at:Date.now()}})});
  await page.waitForTimeout(31000).then(()=>pending);
  await page.locator('#logout').click();assert.equal(await page.locator('.miner').count(),0);assert.equal(await page.locator('#login').isVisible(),true);
  release();await page.waitForTimeout(150);assert.doesNotMatch(await page.locator('body').textContent(),/LATE SECRET/);assert.equal(await page.locator('.miner').count(),0);
  await page.unroute('**/api/remote');
  await page.locator('#key').fill(key);await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  await page.locator('#lang').selectOption('en');assert.match(await page.locator('h1').textContent(),/Your miners, wherever/);
  await page.locator('#manage summary').click();page.once('dialog',dialog=>dialog.accept());await page.locator('#revoke').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('Data erased'));
  assert.equal(await page.locator('.miner').count(),0);assert.equal((await fetch(url+'/api/remote',{headers:auth})).status,410);
  await page.reload();assert.equal(await page.locator('#key').inputValue(),'');assert.equal(await page.locator('.miner').count(),0);
  // Wallet address mode: the miner reports by its payout address, the owner types the same address.
  const wallet='bc1qexampleaddress0000000000000000000000';
  const byAddress=await fetch(url+'/api/remote/report',{method:'POST',headers:{Authorization:'Address '+wallet,'Content-Type':'application/json'},body:JSON.stringify(report('00112233aabbccdd','Gamma salon','bitaxe-gamma-601',1.2e12))});assert.equal(byAddress.status,204);
  assert.equal((await fetch(url+'/api/remote',{method:'DELETE',headers:{Authorization:'Address '+wallet}})).status,403);
  await page.locator('#key').fill(' '+wallet.toUpperCase()+'.rig1 ');await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  assert.equal(await page.locator('.miner').count(),1);assert.match(await page.locator('.miner').textContent(),/Gamma salon/);assert.equal(await page.locator('#manage').isVisible(),false);
  assert.equal(await page.evaluate(()=>localStorage.getItem('bdl-remote-address')),wallet.toUpperCase());
  await page.reload();await page.waitForSelector('.miner');assert.equal(await page.locator('#login').isVisible(),false);
  await page.locator('#logout').click();assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
  await page.reload();await page.waitForTimeout(300);assert.equal(await page.locator('.miner').count(),0);assert.equal(await page.locator('#login').isVisible(),true);
  await page.locator('#key').fill('x');await page.locator('#login-form button[type=submit]').click();assert.match(await page.locator('#notice').textContent(),/payout address|adresse de paiement/);
  assert.deepEqual(failures,[]);
  console.log('PASS private remote browser: static /remote/ on a separate origin, real Worker/SQLite CORS, key isolation, French/English, mobile, safe text, history, no browser key storage, logout races, revocation and wallet-address access.');
 }finally{
  if(browser)await browser.close();child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,2000)});await new Promise(r=>site.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
