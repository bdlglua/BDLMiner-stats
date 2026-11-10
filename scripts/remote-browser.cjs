// The actual Worker, Durable Objects and private viewer on loopback only.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{chromium}=require('playwright');
const http=require('node:http');
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const port=s.address().port;await new Promise(r=>s.close(r));return port}
async function main(){
 const port=await freePort(),inspect=await freePort(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'bdl-private-test-')),url='http://127.0.0.1:'+port;
 const {remoteFiles}=await import('../src/remote-site.js'),files=remoteFiles(url);
 const site=http.createServer((request,response)=>{
  const target=request.url.split('?')[0],name=target==='/remote/'?'index.html':target.startsWith('/remote/')?target.slice(8):'';
  if(!Object.hasOwn(files,name)){response.writeHead(404);response.end();return}
  response.writeHead(200,{'Content-Type':name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript'});response.end(files[name]);
 });
 await new Promise(r=>site.listen(0,'127.0.0.1',r));const siteURL='http://127.0.0.1:'+site.address().port;
 const native=process.env.BDL_SELF_HOSTED==='1';let collector,child,logs='';
 if(native){const {createCollector}=await import('../server/http.js');collector=createCollector({directory:dir,publicOrigin:url,viewerOrigins:siteURL});await new Promise(r=>collector.server.listen(port,'127.0.0.1',r))}
 else{child=spawn(path.resolve('node_modules/.bin/wrangler'),['dev','--local','--ip','127.0.0.1','--port',String(port),'--inspector-port',String(inspect),'--persist-to',dir,'--var','REMOTE_VIEWER_ORIGIN:'+siteURL,'--var','REMOTE_VIEWER_REDIRECT:true','--var','SELF_HOSTED_ORIGIN:'],{env:{...process.env,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logs+=chunk)}
 let browser;
 try{
  const ready=Date.now()+45000;let active=false;
  while(Date.now()<ready){try{active=(await fetch(url+'/api/remote')).status===401;if(active)break}catch{}await new Promise(r=>setTimeout(r,200))}
  assert.ok(active,'Local Worker did not start: '+logs.slice(-3000));
  const legacy=await fetch(url+'/remote',{redirect:'manual'});assert.equal(legacy.status,302);assert.equal(legacy.headers.get('Location'),siteURL+'/remote/');
  const publicSummary=await(await fetch(url+'/api/summary')).json();
  assert.equal(publicSummary.periods[1].expected_samples,12);assert.equal(publicSummary.periods[168].expected_samples,2016);
  assert.equal(publicSummary.periods[24].average_hashrate,0,'a public measurement without active reports is a real zero');
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
  await page.waitForFunction(()=>document.querySelector('#history-note').textContent.includes('Un seul relevé'));
  assert.equal(await page.locator('#login').isVisible(),false);assert.equal(await page.locator('#key').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0]);
  assert.ok(urls.some(value=>value.startsWith(url+'/api/remote')),'static viewer must query the other origin');
  assert.ok(urls.every(value=>value.startsWith(url+'/')||value.startsWith(siteURL+'/')));assert.ok(urls.every(value=>!value.includes(key)&&!value.includes(other)));
  const refused=await fetch(url+'/api/remote',{headers:{...auth,Origin:'https://untrusted.example'}});assert.equal(refused.status,403);
  // Inspect real canvas output as well as the statistics, controls and downloads.
  let chartPoints=[],chartSummary=null;
  await page.route('**/api/remote/history?**',route=>route.fulfill({json:{points:chartPoints,summary:chartSummary,interval_ms:300000,window_start:Date.now()-3600000,window_end:Date.now()}}));
  async function chart(points,summary=null){
   chartPoints=points;chartSummary=summary;
   const response=page.waitForResponse(r=>r.url().includes('/api/remote/history?'));
   await page.locator('#hours').selectOption('1');await(await response).finished();
   await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
   return page.locator('#chart').evaluate(canvas=>{
    const {data}=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height),columns=new Set();let pixels=0,gridLeft=canvas.width;
    for(let i=0;i<data.length;i+=4){
     const x=i/4%canvas.width;
     if(data[i]>180&&data[i+1]>60&&data[i+1]<190&&data[i+2]<70&&data[i+3]>100){pixels++;columns.add(x)}
     if(data[i]===48&&data[i+1]===50&&data[i+2]===60&&data[i+3]>100)gridLeft=Math.min(gridLeft,x);
    }
    return {pixels,columns:columns.size,firstColumn:columns.size?Math.min(...columns):null,gridLeft};
   });
  }
  const now=Date.now(),point=(minutes,extra={})=>({t:now-minutes*60000,rate:1e12,temp:50,samples:1,boot:'aabbccdd',mixed_boots:false,...extra});
  for(const rate of [1e12,0]){
   const single=await chart([point(30,{rate})]);assert.ok(single.pixels>10,'one reading must draw a visible point, including a stopped miner');assert.ok(single.columns<10,'one reading must not invent a line');
   assert.match(await page.locator('#history-note').textContent(),/Un seul relevé/);
  }
  for(const points of [[point(45),point(15)],[point(35),point(30,{boot:'ddeeff00'})],[point(35,{mixed_boots:true}),point(30)]]){
   const isolated=await chart(points);assert.ok(isolated.pixels>20,'readings on either side of a gap or restart must remain visible');assert.ok(isolated.columns<20,'gaps and restarts must not be connected');
  }
  assert.ok((await chart([point(35),point(30)])).columns>20,'consecutive readings must remain connected');
  const empty=await chart([],{reports:0,restarts:0});assert.equal(empty.pixels,0);assert.match(await page.locator('#history-note').textContent(),/Pas encore/);
  assert.equal(await page.locator('#export-history').isDisabled(),true);assert.equal(await page.locator('#stat-average').textContent(),'—');
  const readings=[.9,1,1.1,1.1,1,.9].map((rate,i)=>point(25-i*5,{rate:rate*1e12,temp:[48,49,50,51,50,49][i]}));
  const rendered=await chart(readings,{reports:6,average:1e12,minimum:.9e12,maximum:1.1e12,temperature_average:49.5,temperature_maximum:51,variation_percent:8.16496580927726,restarts:0,first_at:readings[0].t,last_at:readings[5].t});
  assert.ok(Math.abs(rendered.firstColumn-rendered.gridLeft)<=2,'the first reading must start at the left edge of the plot, without an empty time margin');
  assert.equal(await page.locator('#stat-average').textContent(),'1 TH/s');assert.equal(await page.locator('#stat-maximum').textContent(),'1,1 TH/s');
  assert.match(await page.locator('#stat-minimum').textContent(),/900 GH\/s/);assert.match(await page.locator('#stat-variation').textContent(),/8,2 %/);
  assert.equal(await page.locator('#stat-temperature').textContent(),'49,5 °C');assert.equal(await page.locator('#stat-reports').textContent(),'6');
  await page.locator('#chart').focus();await page.keyboard.press('End');
  assert.equal(await page.locator('#chart-tooltip').isVisible(),true);assert.match(await page.locator('#chart-tooltip strong').textContent(),/900 GH\/s/);
  await page.locator('[data-metric=temp]').click();assert.equal(await page.locator('[data-metric=temp]').getAttribute('aria-pressed'),'true');
  await page.locator('#chart').focus();await page.keyboard.press('Home');assert.equal(await page.locator('#chart-tooltip strong').textContent(),'48 °C');
  await page.locator('[data-metric=rate]').click();
  const box=await page.locator('#chart').boundingBox();await page.mouse.move(box.x+box.width/2,box.y+80);assert.equal(await page.locator('#chart-tooltip').isVisible(),true);
  const download=page.waitForEvent('download');await page.locator('#export-history').click();const csv=fs.readFileSync(await(await download).path(),'utf8');
  assert.match(csv,/hashrate_average_hs,hashrate_minimum_hs/);assert.equal(csv.trim().split('\r\n').length,7);assert.ok(!csv.includes(key)&&!csv.includes(other));
  await page.locator('.readings summary').click();assert.equal(await page.locator('#history-rows tr').count(),6);
  if(process.env.BDL_SCREENSHOT_DIR){
   fs.mkdirSync(process.env.BDL_SCREENSHOT_DIR,{recursive:true});await page.locator('#history').screenshot({path:path.join(process.env.BDL_SCREENSHOT_DIR,'statistics-desktop.png')});
   await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await page.locator('#history').screenshot({path:path.join(process.env.BDL_SCREENSHOT_DIR,'statistics-mobile.png')});await page.setViewportSize({width:1440,height:1000});
  }
  await page.unroute('**/api/remote/history?**');
  await page.locator('#hours').selectOption('24');
  await page.setViewportSize({width:375,height:812});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  if(process.env.BDL_SCREENSHOT_DIR){fs.mkdirSync(process.env.BDL_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.BDL_SCREENSHOT_DIR,'private-remote-mobile.png'),fullPage:true})}
  let release,started;const pending=new Promise(r=>started=r);
  await page.route('**/api/remote',async route=>{if(route.request().method()!=='GET')return route.continue();started();await new Promise(r=>release=r);await route.fulfill({headers:{'Access-Control-Allow-Origin':siteURL},json:{miners:[report('0123456789abcdef','LATE SECRET','m5stickc-plus2',1e6)],hashrate:1e6,recorded_at:Date.now()}})});
  await page.waitForTimeout(31000).then(()=>pending);
  await page.locator('#logout').click();assert.equal(await page.locator('.miner').count(),0);assert.equal(await page.locator('#login').isVisible(),true);
  release();await page.waitForTimeout(150);assert.doesNotMatch(await page.locator('body').textContent(),/LATE SECRET/);assert.equal(await page.locator('.miner').count(),0);
  await page.unroute('**/api/remote');
  await page.locator('#key').fill(key);await page.locator('#login-form button[type=submit]').click();await page.waitForSelector('.miner');
  await page.waitForFunction(()=>Number(document.querySelector('#stat-reports').textContent)>0);
  await page.locator('#lang').selectOption('en');assert.match(await page.locator('h1').textContent(),/Your miners, wherever/);
  assert.match(await page.locator('#stat-minimum').textContent(),/^Minimum/);assert.match(await page.locator('#stat-restarts').textContent(),/^Observed restarts/);
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
  console.log('PASS remote statistics ('+(native?'native server':'Worker')+'): SQLite CORS, period indicators, area and temperature charts, keyboard/pointer inspection, CSV, recent readings, zero/empty history, gaps/restarts, French/English, mobile, key isolation, logout races, revocation and wallet-address access.');
 }finally{
  if(browser)await browser.close();if(collector)await collector.close();if(child){child.kill('SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,2000)})}await new Promise(r=>site.close(r));fs.rmSync(dir,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1});
