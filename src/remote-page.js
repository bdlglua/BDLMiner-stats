// Standalone remote viewer: no analytics, third-party scripts or access value in URLs.
const LOGO = '<svg class="logo" viewBox="0 0 100 100" aria-hidden="true"><g fill="#f7931a"><rect x="24" y="24" width="52" height="52" rx="10"/><rect x="31" y="8" width="6" height="12" rx="2"/><rect x="47" y="8" width="6" height="12" rx="2"/><rect x="63" y="8" width="6" height="12" rx="2"/><rect x="31" y="80" width="6" height="12" rx="2"/><rect x="47" y="80" width="6" height="12" rx="2"/><rect x="63" y="80" width="6" height="12" rx="2"/><rect x="8" y="31" width="12" height="6" rx="2"/><rect x="8" y="47" width="12" height="6" rx="2"/><rect x="8" y="63" width="12" height="6" rx="2"/><rect x="80" y="31" width="12" height="6" rx="2"/><rect x="80" y="47" width="12" height="6" rx="2"/><rect x="80" y="63" width="12" height="6" rx="2"/></g><text x="50" y="64" text-anchor="middle" font-size="42" font-weight="900" font-family="system-ui,sans-serif" fill="#15100a">B</text></svg>';
const GUIDE = 'https://github.com/bdlglua/BDLMinerV2/blob/main/docs/remote-access.md';

export const REMOTE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>BDLMiner V2 · My miners</title><link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><link rel="stylesheet" href="/remote.css"><script src="/remote.js" defer></script></head>
<body><header class="bar"><a class="brand" href="https://bdlglua.github.io/">${LOGO}<span><strong>BDLMiner</strong> <em>V2</em></span></a><nav aria-label="Site"><a href="https://bdlglua.github.io/" data-i="Home">Home</a><a href="https://bdlglua.github.io/stats.html" data-i="Statistics">Statistics</a><a href="./" aria-current="page" data-i="My miners">My miners</a></nav><select id="lang" aria-label="Language"><option value="en">English</option><option value="fr">Français</option></select><button id="logout" hidden data-i="Sign out">Sign out</button></header>
<main><section class="intro"><div><p class="pill" data-i="Remote monitoring">Remote monitoring</p><h1 data-i="Your miners, wherever you are.">Your miners, wherever you are.</h1><p data-i="Each board sends its readings directly, every five minutes. No computer needs to stay on at home.">Each board sends its readings directly, every five minutes. No computer needs to stay on at home.</p></div><div class="total"><span data-i="Online hashrate">Online hashrate</span><strong id="total">—</strong><small id="updated"></small></div></section>
<section id="login" class="panel"><h2 data-i="See your miners">See your miners</h2><p class="muted" data-i="Enter the payout address your miners use. It is the one in Settings → Pool on each board.">Enter the payout address your miners use. It is the one in Settings → Pool on each board.</p><form id="login-form"><label for="key" data-i="Wallet address">Wallet address</label><div class="row"><input id="key" type="text" required maxlength="160" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="bc1q…"><button type="submit" class="primary" data-i="View my miners">View my miners</button></div><label class="check"><input id="remember" type="checkbox" checked><span data-i="Remember this address on this device">Remember this address on this device</span></label></form><p class="note" data-i="Anyone who knows this address can see these readings, as on your pool's page. Nothing here can change a miner. A private access key created before BDLMiner 2.5.4 also works in this field.">Anyone who knows this address can see these readings, as on your pool's page. Nothing here can change a miner. A private access key created before BDLMiner 2.5.4 also works in this field.</p></section>
<p id="notice" role="status" aria-live="polite"></p><section id="miners" aria-live="polite"></section>
<section id="empty" class="panel" hidden><h2 data-i="Waiting for your first miner">Waiting for your first miner</h2><p data-i="On each miner (BDLMiner 2.5.4 or newer), open Settings → Network → Private remote monitoring, enable it, then save and restart. The miner uses its payout address: nothing to copy. The first report arrives after about one minute.">On each miner (BDLMiner 2.5.4 or newer), open Settings → Network → Private remote monitoring, enable it, then save and restart. The miner uses its payout address: nothing to copy. The first report arrives after about one minute.</p><a href="${GUIDE}" data-i="Setup guide">Setup guide</a></section>
<section id="history" class="panel performance" hidden>
 <div class="heading"><div><p class="eyebrow" data-i="Performance">Performance</p><h2 data-i="Mining statistics">Mining statistics</h2><p id="history-range" class="muted"></p></div><div class="actions"><select id="history-miner" aria-label="Miner"></select><select id="hours" aria-label="History window"><option value="1">1 h</option><option value="6">6 h</option><option value="24" selected>24 h</option><option value="168">7 d</option></select><button id="export-history" type="button" disabled data-i="Export CSV">Export CSV</button></div></div>
 <div class="statistics" aria-live="polite">
  <div class="stat"><span data-i="Average hashrate">Average hashrate</span><strong id="stat-average">—</strong><small id="stat-variation">—</small></div>
  <div class="stat"><span data-i="Peak hashrate">Peak hashrate</span><strong id="stat-maximum">—</strong><small id="stat-minimum">—</small></div>
  <div class="stat"><span data-i="Average temperature">Average temperature</span><strong id="stat-temperature">—</strong><small id="stat-temperature-max">—</small></div>
  <div class="stat"><span data-i="Reports received">Reports received</span><strong id="stat-reports">—</strong><small id="stat-restarts">—</small></div>
 </div>
 <div class="chart-toolbar"><div class="metric-switch" role="group" aria-label="Chart metric"><button type="button" data-metric="rate" aria-pressed="true" data-i="Hashrate">Hashrate</button><button type="button" data-metric="temp" aria-pressed="false" data-i="Temperature">Temperature</button></div><span class="average-legend" data-i="Period average">Period average</span></div>
 <div class="chart-wrap"><canvas id="chart" role="img" tabindex="0" aria-label="Mining history. Use left and right arrows to inspect readings." aria-describedby="history-note"></canvas><div id="chart-tooltip" class="chart-tooltip" role="status" hidden><time></time><strong></strong><small></small></div><p id="chart-empty" class="chart-empty" hidden></p></div>
 <p id="history-note" class="muted"></p>
 <details class="readings"><summary data-i="Recent readings">Recent readings</summary><div class="table-scroll"><table><thead><tr><th data-i="Time">Time</th><th data-i="Average hashrate">Average hashrate</th><th data-i="Temperature">Temperature</th><th data-i="Reports received">Reports received</th></tr></thead><tbody id="history-rows"></tbody></table></div></details>
</section>
<details id="manage" class="panel" hidden><summary data-i="Manage my private data">Manage my private data</summary><p data-i="Revoke this key and permanently erase its readings and history. All paired miners must then use a new key.">Revoke this key and permanently erase its readings and history. All paired miners must then use a new key.</p><button id="revoke" class="danger" data-i="Erase data and revoke key">Erase data and revoke key</button></details>
<footer><p data-i="Reports every five minutes; history kept for seven days.">Reports every five minutes; history kept for seven days.</p><p data-i="Readings only: this page cannot change settings, restart a miner or install firmware.">Readings only: this page cannot change settings, restart a miner or install firmware.</p><a href="${GUIDE}" data-i="Setup and privacy">Setup and privacy</a></footer></main></body></html>`;

export const REMOTE_STYLE = `:root{color-scheme:dark;--bg:#141416;--panel:#1c1d22;--raised:#23262f;--line:#2a2d36;--strong:#353945;--muted:#777e90;--text:#b1b5c3;--fg:#fcfcfd;--accent:#f7931a;--primary:#3772ff;--ok:#58bd7d;--bad:#ef466f;font:15px/1.6 "Inter","DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.bar{height:70px;display:flex;align-items:center;gap:16px;padding:0 max(24px,calc((100% - 1280px)/2));border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;color:var(--fg);font-size:17px;white-space:nowrap}.brand:hover{text-decoration:none}.brand strong{font-weight:800}.brand em{color:var(--accent);font-style:normal;font-weight:700}.logo{width:30px;height:30px;flex:none}
nav{display:flex;gap:22px;margin-left:24px}nav a{color:var(--muted);font-size:14px;font-weight:600}nav a:hover{color:var(--fg);text-decoration:none}nav a[aria-current]{color:var(--fg)}
.bar>select{margin-left:auto}
main{max-width:1328px;margin:auto;padding:40px 24px}
.intro{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:28px;padding-bottom:28px;border-bottom:1px solid var(--line)}.intro p{max-width:640px;color:var(--muted);margin:6px 0}
.pill{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:var(--text)!important;padding:4px 12px;border-radius:999px;background:var(--raised)}.pill:before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ok)}
h1,h2{color:var(--fg)}h1{font-size:clamp(30px,3.6vw,46px);line-height:1.1;letter-spacing:-.02em;margin:12px 0;font-weight:700}h2{font-size:18px;margin:0 0 8px;font-weight:650;letter-spacing:-.01em}
.total{display:grid;gap:2px;text-align:right;min-width:220px}body:not(.on) .total{visibility:hidden}.total>span{color:var(--muted);font-size:13px}.total strong{font-size:40px;font-weight:700;color:var(--fg);letter-spacing:-.03em;white-space:nowrap;font-variant-numeric:tabular-nums}.total small{color:var(--muted)}
.panel,.miner{border:1px solid var(--line);border-radius:20px;background:var(--panel);padding:24px;min-width:0}.panel{margin-bottom:16px}.panel>p{max-width:820px}
.muted,small,footer{color:var(--muted)}
button,input,select{font:inherit;font-size:14px;color:var(--fg);border:1px solid var(--strong);border-radius:10px;background:transparent;padding:8px 12px;min-height:40px;min-width:0}
input[type=text]{background:var(--raised);border-color:var(--raised);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}input[type=text]:focus{border-color:var(--primary)}
select{background:var(--panel)}
button{cursor:pointer;font-weight:600;border-width:2px;border-radius:90px;padding:8px 18px}button:hover{border-color:var(--fg)}button:disabled{opacity:.45;cursor:wait}
button.primary{background:var(--primary);border-color:var(--primary);color:#fff}button.primary:hover{background:#2b62e6;border-color:#2b62e6}
button.danger{border-color:#5a3333;color:var(--bad)}button.danger:hover{border-color:var(--bad)}
button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
label{display:block;margin:18px 0 8px;font-size:13px;font-weight:600;color:var(--text)}
.row{display:flex;gap:10px;flex-wrap:wrap}.row input{flex:1;min-width:200px}
.check{display:flex;align-items:center;gap:8px;margin:14px 0 0;font-weight:500;color:var(--muted)}.check input{min-height:auto;width:16px;height:16px;accent-color:var(--primary)}
.note{font-size:13px;color:var(--muted);margin:18px 0 0;padding-top:16px;border-top:1px solid var(--line)}
.actions{display:flex;gap:8px;flex-wrap:wrap}
#notice{min-height:24px;overflow-wrap:anywhere;color:var(--bad);margin:0 0 8px}
#miners{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,330px),1fr));gap:16px;margin-bottom:16px}
.miner.offline{border-color:#5a3333}
.heading{display:flex;justify-content:space-between;align-items:center;gap:12px}.miner h2{overflow-wrap:anywhere;margin:0}
.state{font-size:12px;font-weight:600;white-space:nowrap;padding:2px 10px;border-radius:999px;color:var(--ok);background:#58bd7d1f}.offline .state{color:var(--bad);background:#ef466f1f}
.rate{font-size:34px;font-weight:800;color:var(--fg);letter-spacing:-.03em;margin:20px 0 0;font-variant-numeric:tabular-nums}
.metrics{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:20px;padding-top:16px;border-top:1px solid var(--line)}.metric{display:grid;gap:2px;min-width:0}.metric span{color:var(--muted);font-size:12px}.metric strong{font-size:16px;font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.heading select{max-width:180px}canvas{display:block;width:100%;height:260px;margin-top:24px}
summary{cursor:pointer;font-weight:650;color:var(--fg)}
footer{font-size:13px;margin-top:24px;padding-top:16px;border-top:1px solid var(--line)}footer p{margin:6px 0}
@media(max-width:820px){nav{display:none}}
@media(max-width:640px){.bar{padding:0 16px;gap:10px}.bar button{padding:6px 12px}main{padding:24px 16px}.intro{display:block}.total{text-align:left;margin-top:20px}.total strong{font-size:32px}.panel,.miner{padding:18px}.heading{align-items:flex-start;flex-wrap:wrap}.heading select{max-width:100%}.row input,.row button{flex-basis:100%}canvas{height:210px}.brand{font-size:15px;gap:8px}.logo{width:26px;height:26px}.bar select{padding:6px 8px}}
.performance{padding:28px}.performance h2{font-size:24px;margin:0}.eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin:0 0 4px}#history-range{font-size:12px;margin:5px 0 0}.performance>.heading{align-items:flex-start}.performance .actions{justify-content:flex-end}.performance .actions button{border-radius:10px;border-width:1px;font-size:12px}
.statistics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;border:1px solid var(--line);border-radius:14px;overflow:hidden;background:var(--line);margin:24px 0}.stat{padding:18px 20px;background:var(--panel);display:grid;gap:5px;min-width:0}.stat>span{font-size:12px;color:var(--text)}.stat>strong{color:var(--fg);font-size:27px;line-height:1.3;letter-spacing:-.03em;font-variant-numeric:tabular-nums}.stat:first-child>strong{color:var(--accent)}.stat>small{font-size:11px;min-height:18px}
.chart-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px}.metric-switch{display:flex;gap:4px;padding:4px;background:var(--bg);border:1px solid var(--line);border-radius:10px}.metric-switch button{border:0;border-radius:6px;padding:5px 14px;min-height:32px;font-size:12px;color:var(--muted)}.metric-switch button[aria-pressed=true]{background:var(--raised);color:var(--fg)}.average-legend{font-size:11px;display:flex;align-items:center;gap:8px;color:var(--muted)}.average-legend:before{content:"";width:20px;border-top:2px dashed var(--muted)}
.chart-wrap{position:relative;margin-top:20px}canvas{display:block;width:100%;height:300px;margin:0;touch-action:pan-y}.chart-tooltip{position:absolute;pointer-events:none;width:205px;padding:12px 14px;background:#111216f5;border:1px solid var(--strong);border-radius:10px;box-shadow:0 8px 24px #0006;z-index:1}.chart-tooltip time,.chart-tooltip small{display:block;font-size:11px;color:var(--text)}.chart-tooltip strong{display:block;color:var(--fg);font-size:20px;font-variant-numeric:tabular-nums}.chart-empty{position:absolute;inset:0;display:grid;place-items:center;margin:0;font-size:13px;color:var(--muted)}#history-note{font-size:12px;margin:12px 0 0}.readings{border-top:1px solid var(--line);margin-top:20px;padding-top:16px}.readings summary{font-size:12px;color:var(--text)}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums;margin-top:12px}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}th{color:var(--muted);font-weight:500}th:first-child,td:first-child{text-align:left}td{color:var(--text)}
@media(max-width:900px){.stat{padding:14px}.stat>strong{font-size:22px}.performance>.heading{flex-wrap:wrap}.performance .actions{justify-content:flex-start}}
@media(max-width:640px){.performance{padding:18px}.statistics{grid-template-columns:repeat(2,minmax(0,1fr));margin:18px 0}.stat{padding:14px 12px}.stat>strong{font-size:22px}.performance .actions{width:100%}.performance .actions select{flex:1;max-width:100%}.performance .actions button{flex:none}.performance h2{font-size:21px}canvas{height:260px}.chart-tooltip{width:175px}.average-legend{font-size:10px}.metric-switch button{padding:5px 10px}}
`;

export const REMOTE_APP = String.raw`'use strict';
(()=>{
const apiOrigin=document.querySelector('meta[name="bdl-remote-api"]')?.content||location.origin;
const SAVED='bdl-remote-address',KEY=/^[a-f0-9]{64}$/;
const $=id=>document.getElementById(id),FR={
"Performance":"Performances","Mining statistics":"Statistiques de minage","Export CSV":"Exporter CSV","Average hashrate":"Hashrate moyen","Peak hashrate":"Hashrate maximal","Average temperature":"Température moyenne","Reports received":"Relevés reçus","Hashrate":"Hashrate","Period average":"Moyenne de la période","Recent readings":"Derniers relevés","Time":"Heure","Minimum":"Minimum","Peak":"Maximum","Observed restarts":"Redémarrages observés","Variation":"Variation","Loading readings…":"Chargement des relevés…","History unavailable":"Historique indisponible","Statistics use received reports. Missing periods are left empty.":"Statistiques calculées sur les relevés reçus. Les périodes sans données restent vides.","No temperature readings.":"Aucun relevé de température.","reports":"relevés","readings":"relevés","Use left and right arrows to inspect readings.":"Utilisez les flèches gauche et droite pour consulter les relevés.",
'Home':'Accueil','Statistics':'Statistiques','My miners':'Mes mineurs','Sign out':'Déconnexion','Remote monitoring':'Suivi à distance','Your miners, wherever you are.':'Vos mineurs, où que vous soyez.','Each board sends its readings directly, every five minutes. No computer needs to stay on at home.':'Chaque carte envoie directement ses mesures toutes les cinq minutes. Aucun ordinateur ne doit rester allumé chez vous.','Online hashrate':'Hashrate en ligne','See your miners':'Voir vos mineurs','Enter the payout address your miners use. It is the one in Settings → Pool on each board.':'Saisissez l’adresse de paiement utilisée par vos mineurs. C’est celle de Réglages → Pool sur chaque carte.','Wallet address':'Adresse de portefeuille','View my miners':'Voir mes mineurs','Remember this address on this device':'Retenir cette adresse sur cet appareil',"Anyone who knows this address can see these readings, as on your pool's page. Nothing here can change a miner. A private access key created before BDLMiner 2.5.4 also works in this field.":'Toute personne qui connaît cette adresse peut voir ces mesures, comme sur la page de votre pool. Rien ici ne peut modifier un mineur. Une clé d’accès privée créée avant BDLMiner 2.5.4 fonctionne aussi dans ce champ.','Waiting for your first miner':'En attente de votre premier mineur','On each miner (BDLMiner 2.5.4 or newer), open Settings → Network → Private remote monitoring, enable it, then save and restart. The miner uses its payout address: nothing to copy. The first report arrives after about one minute.':'Sur chaque mineur (BDLMiner 2.5.4 ou ultérieur), ouvrez Réglages → Réseau → Suivi privé à distance, activez-le, puis enregistrez et redémarrez. Le mineur utilise son adresse de paiement : rien à copier. Le premier envoi arrive après environ une minute.','Setup guide':'Guide de configuration','Hashrate history':'Historique du hashrate','Manage my private data':'Gérer mes données privées','Revoke this key and permanently erase its readings and history. All paired miners must then use a new key.':'Révoquez cette clé et effacez définitivement ses mesures et son historique. Tous les mineurs associés devront ensuite utiliser une nouvelle clé.','Erase data and revoke key':'Effacer les données et révoquer la clé','Reports every five minutes; history kept for seven days.':'Envoi toutes les cinq minutes ; historique conservé sept jours.','Readings only: this page cannot change settings, restart a miner or install firmware.':'Consultation uniquement : cette page ne peut pas changer les réglages, redémarrer un mineur ou installer un firmware.','Setup and privacy':'Configuration et confidentialité','Online':'En ligne','Offline':'Hors ligne','Temperature':'Température','Accepted / rejected':'Acceptées / rejetées','Uptime':'Durée de marche','Power':'Puissance','Best difficulty':'Meilleure difficulté','Pool':'Pool','Connected':'Connectée','Disconnected':'Déconnectée','Last report':'Dernier envoi','Updated':'Actualisé','Enter the payout address set on your miners.':'Saisissez l’adresse de paiement réglée sur vos mineurs.','Connection failed. Last readings may be out of date.':'Connexion impossible. Les dernières mesures peuvent être anciennes.','This access key has been revoked':'Cette clé d’accès a été révoquée','Wallet address or private access key required':'Adresse de portefeuille ou clé d’accès privée requise','Only a private access key can erase readings':'Seule une clé d’accès privée peut effacer les mesures','Please wait before trying again':'Patientez avant de réessayer','Data erased and key revoked.':'Données effacées et clé révoquée.','Erase all private history and permanently revoke this key?':'Effacer tout l’historique privé et révoquer définitivement cette clé ?','Gaps indicate missing reports or restarts.':'Les interruptions indiquent des envois manquants ou des redémarrages.','Only one reading in this period. Reports arrive every five minutes.':'Un seul relevé sur cette période. Les envois arrivent toutes les cinq minutes.','No history yet.':'Pas encore d’historique.','Connection closed':'Connexion fermée'};
let lang=navigator.language.startsWith('fr')?'fr':'en',access=null,version=0,timer=null,fleet=null,series=null,historyVersion=0;
const t=s=>lang==='fr'?(FR[s]||s):s;
function stored(value){try{if(value===undefined)return localStorage.getItem(SAVED)||'';if(value)localStorage.setItem(SAVED,value);else localStorage.removeItem(SAVED)}catch{}return''}
function address(value){const a=String(value).trim().split('.')[0];return /^[A-Za-z0-9:_-]{4,100}$/.test(a)?a:''}
function translate(){document.documentElement.lang=lang;$('lang').value=lang;for(const e of document.querySelectorAll('[data-i]'))e.textContent=t(e.dataset.i)}
function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el}
function si(n){if(!Number.isFinite(n)||n<0)return'—';const units=['H/s','kH/s','MH/s','GH/s','TH/s','PH/s'];let i=0;while(n>=1000&&i<units.length-1){n/=1000;i++}return new Intl.NumberFormat(lang,{maximumFractionDigits:2}).format(n)+' '+units[i]}
function duration(n){if(n<60)return Math.round(n)+' s';if(n<3600)return Math.round(n/60)+' min';if(n<86400)return(n/3600).toFixed(1)+' h';return(n/86400).toFixed(1)+' d'}
function metric(box,label,value){const el=node('div',undefined,'metric');el.append(node('span',t(label)),node('strong',value));box.append(el)}
function lock(){document.body.classList.remove('on');version++;historyVersion++;access=null;fleet=null;clearHistory();clearTimeout(timer);$('key').value='';$('login').hidden=false;for(const id of ['logout','history','manage','empty'])$(id).hidden=true;$('miners').replaceChildren();$('history-miner').replaceChildren();$('total').textContent='—';$('updated').textContent='';const c=$('chart');c.getContext('2d').clearRect(0,0,c.width,c.height);$('notice').textContent='';translate()}
async function api(path,method='GET'){
 const epoch=version,current=access;if(!current)throw Error(t('Connection closed'));
 const response=await fetch(apiOrigin+path,{method,headers:{Authorization:(current.key?'Bearer ':'Address ')+current.value},credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(15000)});
 const data=response.status===204?null:await response.json();if(epoch!==version)throw Error(t('Connection closed'));
 if(!response.ok){if(response.status===401||response.status===410)lock();throw Error(t(data?.error||'HTTP '+response.status))}return data;
}
function render(data){document.body.classList.add('on');fleet=data;$('total').textContent=si(data.hashrate);$('updated').textContent=t('Updated')+' '+new Date(data.recorded_at).toLocaleTimeString(lang);$('login').hidden=true;$('logout').hidden=false;$('manage').hidden=!access?.key;$('empty').hidden=!!data.miners.length;$('history').hidden=!data.miners.length;const fragment=document.createDocumentFragment();
 for(const m of data.miners){const card=node('article',undefined,'miner'+(m.online?'':' offline'));card.dataset.id=m.id;const heading=node('div',undefined,'heading');heading.append(node('h2',m.name),node('span',t(m.online?'Online':'Offline'),'state'));card.append(heading,node('small',m.board+' · '+m.v+' · '+m.coin),node('div',si(m.hashrate),'rate'),node('small',t('Last report')+' · '+duration(m.age_s)));const metrics=node('div',undefined,'metrics');metric(metrics,'Temperature',Number.isFinite(m.temp_c)?m.temp_c.toFixed(1)+' °C':'—');metric(metrics,'Accepted / rejected',m.accepted+' / '+m.rejected);metric(metrics,'Uptime',duration(m.uptime_s));metric(metrics,'Power',m.power_percent+' %');metric(metrics,'Best difficulty',new Intl.NumberFormat(lang,{maximumFractionDigits:0}).format(m.best));metric(metrics,'Pool',t(m.pool_connected?'Connected':'Disconnected')+' · '+m.pool);card.append(metrics);fragment.append(card)}
 $('miners').replaceChildren(fragment);const chosen=$('history-miner').value;$('history-miner').replaceChildren(...data.miners.map(m=>{const el=node('option',m.name);el.value=m.id;return el}));if(data.miners.some(m=>m.id===chosen))$('history-miner').value=chosen;
}
const number=n=>new Intl.NumberFormat(lang,{maximumFractionDigits:1}).format(n);
const temperature=n=>Number.isFinite(n)?number(n)+' °C':'—';
const stamp=n=>new Date(n).toLocaleString(lang,{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
let chartMetric='rate',hover=null,plot=null;
function clearHistory(){
 series=null;hover=null;plot=null;$('chart-tooltip').hidden=true;
 for(const id of ['stat-average','stat-maximum','stat-minimum','stat-temperature','stat-temperature-max','stat-reports','stat-restarts','stat-variation'])$(id).textContent='—';
 $('history-range').textContent='';$('history-rows').replaceChildren();$('export-history').disabled=true;
 const c=$('chart');c.getContext('2d').clearRect(0,0,c.width,c.height);
}
function historyStats(){
 const s=series?.summary;
 $('stat-average').textContent=si(s?.average);$('stat-maximum').textContent=si(s?.maximum);
 $('stat-minimum').textContent=t('Minimum')+' · '+si(s?.minimum);
 $('stat-temperature').textContent=temperature(s?.temperature_average);
 $('stat-temperature-max').textContent=t('Peak')+' · '+temperature(s?.temperature_maximum);
 $('stat-reports').textContent=s?number(s.reports):'—';
 $('stat-restarts').textContent=t('Observed restarts')+' · '+(s?number(s.restarts):'—');
 $('stat-variation').textContent=t('Variation')+' · '+(Number.isFinite(s?.variation_percent)?number(s.variation_percent)+' %':'—');
 $('history-range').textContent=s?.reports?stamp(s.first_at)+' → '+stamp(s.last_at):t('No history yet.');
 $('export-history').disabled=!series?.points.length;
 const rows=(series?.points||[]).slice(-8).reverse().map(p=>{
  const row=node('tr');for(const value of [stamp(p.t),si(p.rate),temperature(p.temp),number(p.samples??1)])row.append(node('td',value));return row;
 });$('history-rows').replaceChildren(...rows);
 document.querySelector('[data-metric="temp"]').disabled=!series?.points.some(p=>Number.isFinite(p.temp));
}
async function history(){
 const id=$('history-miner').value,hours=Number($('hours').value),epoch=version,seq=++historyVersion;if(!id)return;
 if(series?.miner!==id||series?.hours!==hours){clearHistory();$('history-note').textContent=t('Loading readings…');$('chart-empty').hidden=false;$('chart-empty').textContent=t('Loading readings…')}
 try{
  const data=await api('/api/remote/history?miner='+encodeURIComponent(id)+'&hours='+hours);
  if(epoch!==version||seq!==historyVersion)return;
  series={...data,miner:id,hours};hover=null;historyStats();draw();
 }catch(e){if(epoch===version&&seq===historyVersion){clearHistory();$('chart-empty').hidden=false;$('chart-empty').textContent=t('History unavailable');$('history-note').textContent=e.message}}
}
function draw(){
 const c=$('chart'),ratio=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;if(!w||!series)return;
 c.width=w*ratio;c.height=h*ratio;
 const ctx=c.getContext('2d');ctx.scale(ratio,ratio);
 const pts=series.points,values=pts.map((p,i)=>({...p,index:i,value:chartMetric==='rate'?p.rate:p.temp})).filter(p=>Number.isFinite(p.value));
 $('history-note').textContent=t(!pts.length?'No history yet.':pts.length===1?'Only one reading in this period. Reports arrive every five minutes.':'Statistics use received reports. Missing periods are left empty.');
 $('chart-empty').hidden=!!values.length;
 if(!values.length){$('chart-empty').textContent=t(pts.length?'No temperature readings.':'No history yet.');$('chart-tooltip').hidden=true;plot=null;return}
 const interval=series.interval_ms,end=series.window_end||Date.now(),windowStart=series.window_start||end-series.hours*3600000;
 // Show the available history rather than compressing a new miner into the
 // final few pixels of a day. The selected period remains the maximum window.
 const start=Math.max(windowStart,Math.min(pts[0].t-interval*.5,end-interval*2));
 const raw=values.flatMap(p=>chartMetric==='rate'?[p.min_rate??p.rate,p.max_rate??p.rate]:[p.temp,p.max_temp??p.temp]);
 const low=Math.min(...raw),high=Math.max(...raw),padding=Math.max((high-low)*.15,Math.abs(high)*.035,.01);
 const min=chartMetric==='rate'?Math.max(0,low-padding):low-padding,max=high+padding;
 const left=w<500?68:86,right=w-12,top=16,bottom=h-34;
 const x=p=>left+(right-left)*(p.t-start)/(end-start),y=value=>bottom-(bottom-top)*(value-min)/(max-min);
 let unit=0;const units=['H/s','kH/s','MH/s','GH/s','TH/s','PH/s'];while(high/1000**unit>=1000&&unit<units.length-1)unit++;
 const axisUnit=chartMetric==='rate'?1000**unit:1;
 const precision=Math.min(6,Math.max(0,Math.ceil(-Math.log10((max-min)/4/axisUnit))));
 const axisNumber=new Intl.NumberFormat(lang,{maximumFractionDigits:precision});
 const format=value=>axisNumber.format(value/axisUnit)+' '+(chartMetric==='rate'?units[unit]:'°C');
 ctx.font='11px system-ui';ctx.fillStyle='#9299aa';ctx.strokeStyle='#30323c';ctx.lineWidth=1;
 for(let i=0;i<5;i++){
  const value=min+(max-min)*i/4,py=y(value);ctx.beginPath();ctx.moveTo(left,py);ctx.lineTo(right,py);ctx.stroke();ctx.fillText(format(value),0,py+4);
 }
 const ticks=w<500?3:6;
 for(let i=0;i<ticks;i++){
  const at=start+(end-start)*i/(ticks-1),px=left+(right-left)*i/(ticks-1);
  const label=new Date(at).toLocaleString(lang,end-start>86400000?{day:'2-digit',month:'short',hour:'2-digit'}:{hour:'2-digit',minute:'2-digit'});
  ctx.textAlign=i===0?'left':i===ticks-1?'right':'center';ctx.fillText(label,px,h-9);
 }ctx.textAlign='left';
 const color=chartMetric==='rate'?'#f7931a':'#5d9eff',rgb=chartMetric==='rate'?'247,147,26':'93,158,255';
 ctx.save();ctx.beginPath();ctx.rect(left,top-4,right-left,bottom-top+8);ctx.clip();
 const gradient=ctx.createLinearGradient(0,top,0,bottom);gradient.addColorStop(0,'rgba('+rgb+',.35)');gradient.addColorStop(1,'rgba('+rgb+',.025)');
 const runs=[];let run=[];
 for(const p of values){
  const previous=run[run.length-1];
  if(previous&&(p.index!==previous.index+1||p.mixed_boots||previous.mixed_boots||p.boot!==previous.boot||p.t-previous.t>interval*2.5)){runs.push(run);run=[]}
  run.push(p);
 }if(run.length)runs.push(run);
 for(const group of runs){
  if(group.length===1){
   const p=group[0],py=y(p.value);ctx.fillStyle=color;ctx.fillRect(x(p)-4,Math.min(py,bottom-3),8,Math.max(3,bottom-py));continue;
  }
  ctx.beginPath();ctx.moveTo(x(group[0]),bottom);for(const p of group)ctx.lineTo(x(p),y(p.value));ctx.lineTo(x(group[group.length-1]),bottom);ctx.closePath();ctx.fillStyle=gradient;ctx.fill();
  ctx.beginPath();group.forEach((p,i)=>i?ctx.lineTo(x(p),y(p.value)):ctx.moveTo(x(p),y(p.value)));ctx.strokeStyle=color;ctx.lineWidth=2;ctx.stroke();
 }
 const average=chartMetric==='rate'?series.summary?.average:series.summary?.temperature_average;
 if(Number.isFinite(average)){ctx.beginPath();ctx.setLineDash([5,5]);ctx.moveTo(left,y(average));ctx.lineTo(right,y(average));ctx.strokeStyle='#9299aa';ctx.lineWidth=1;ctx.stroke();ctx.setLineDash([])}
 plot={values,x,y,left,right};
 const chosen=values.find(p=>p.index===hover);$('chart-tooltip').hidden=!chosen;
 if(chosen){
  const px=x(chosen),py=y(chosen.value);ctx.beginPath();ctx.setLineDash([3,4]);ctx.moveTo(px,top);ctx.lineTo(px,bottom);ctx.strokeStyle='#b1b5c3';ctx.stroke();ctx.setLineDash([]);ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fillStyle=color;ctx.fill();
  const tip=$('chart-tooltip');tip.querySelector('time').textContent=stamp(chosen.t);tip.querySelector('strong').textContent=chartMetric==='rate'?si(chosen.rate):temperature(chosen.temp);
  tip.querySelector('small').textContent=number(chosen.samples??1)+' '+t('reports')+' · '+(chartMetric==='rate'?temperature(chosen.temp):si(chosen.rate));
  tip.style.left=Math.max(0,Math.min(w-tip.offsetWidth,px+12))+'px';tip.style.top=Math.max(0,py-tip.offsetHeight-12)+'px';
 }
 ctx.restore();
 c.setAttribute('aria-label',t(chartMetric==='rate'?'Hashrate':'Temperature')+' · '+values.length+' '+t('readings')+'. '+t('Use left and right arrows to inspect readings.'));
}
function inspectChart(event){
 if(!plot)return;const x=event.clientX-$('chart').getBoundingClientRect().left;
 if(x<plot.left||x>plot.right){hover=null;draw();return}
 hover=plot.values.reduce((best,p)=>Math.abs(plot.x(p)-x)<Math.abs(plot.x(best)-x)?p:best).index;draw();
}
$('chart').addEventListener('pointermove',inspectChart);$('chart').addEventListener('pointerdown',inspectChart);
$('chart').addEventListener('pointerleave',()=>{hover=null;draw()});$('chart').addEventListener('blur',()=>{hover=null;draw()});
$('chart').addEventListener('keydown',e=>{
 if(!plot||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();
 const items=plot.values,index=items.findIndex(p=>p.index===hover);
 const next=e.key==='Home'?0:e.key==='End'?items.length-1:index<0?items.length-1:Math.max(0,Math.min(items.length-1,index+(e.key==='ArrowRight'?1:-1)));
 hover=items[next].index;draw();
});
for(const button of document.querySelectorAll('[data-metric]'))button.onclick=()=>{
 chartMetric=button.dataset.metric;hover=null;for(const other of document.querySelectorAll('[data-metric]'))other.setAttribute('aria-pressed',String(other===button));draw();
};
$('export-history').onclick=()=>{
 if(!series?.points.length)return;
 const rows=[['time_utc','hashrate_average_hs','hashrate_minimum_hs','hashrate_maximum_hs','temperature_average_c','temperature_maximum_c','reports','mixed_boots'],...series.points.map(p=>[new Date(p.t).toISOString(),p.rate,p.min_rate??p.rate,p.max_rate??p.rate,p.temp??'',p.max_temp??'',p.samples??1,!!p.mixed_boots])];
 const blob=new Blob([rows.map(row=>row.join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download='bdlminer-history-'+series.hours+'h.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
async function refresh(){const epoch=version;try{const data=await api('/api/remote');if(epoch!==version)return;$('notice').textContent='';render(data);await history()}catch(e){if(epoch===version||!access)$('notice').textContent=e.message;if(fleet&&epoch===version){$('updated').textContent=t('Connection failed. Last readings may be out of date.');$('total').textContent='—';for(const card of $('miners').children){card.classList.add('offline');card.querySelector('.state').textContent=t('Offline')}}}finally{if(access&&epoch===version){clearTimeout(timer);timer=setTimeout(refresh,30000)}}}
function open(next){version++;access=next;$('key').value='';void refresh()}
$('login-form').onsubmit=e=>{e.preventDefault();const value=$('key').value.trim();
 if(KEY.test(value)){stored(null);open({key:true,value});return}
 const a=address(value);if(!a){$('notice').textContent=t('Enter the payout address set on your miners.');return}
 stored($('remember').checked?a:null);open({key:false,value:a})};
$('logout').onclick=()=>{stored(null);lock()};$('lang').onchange=()=>{lang=$('lang').value;translate();if(fleet)render(fleet);if(series)historyStats();draw()};$('history-miner').onchange=history;$('hours').onchange=history;
$('revoke').onclick=async()=>{if(!access?.key||!confirm(t('Erase all private history and permanently revoke this key?')))return;try{await api('/api/remote','DELETE');lock();$('notice').textContent=t('Data erased and key revoked.')}catch(e){$('notice').textContent=e.message}};
new ResizeObserver(draw).observe($('chart'));translate();
const saved=address(stored());if(saved)open({key:false,value:saved});
})();`;
