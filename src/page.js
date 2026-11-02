// The statistics page: one HTML document that reads /api/summary every 20
// seconds and draws the totals, the 24-hour chart and the breakdowns.

import { POOL_LABELS, POOL_LINKS } from "./pools.js";

export const PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Hashrate total des miners Bitcoin BDLMiner qui le partagent, en direct.">
<title>BDLMiner · Statistiques</title>
<style>
  :root { --bg: #0a0d12; --panel: #12171f; --line: #1f2733; --text: #eef1f5; --muted: #8b95a3; --accent: #f7931a; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1000px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  h1 span { color: var(--accent); }
  h2 { font-size: 14px; font-weight: 600; color: var(--muted); margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; }
  .status { color: var(--muted); font-size: 13px; }
  .status.error { color: #ff7a6b; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 12px; }
  .tile, section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .tile .label { color: var(--muted); font-size: 13px; }
  .tile .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; margin-top: 4px; }
  .tile .value.accent { color: var(--accent); }
  .tile .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  section { margin-bottom: 12px; }
  .chart { width: 100%; height: 220px; display: block; }
  .chart text { fill: var(--muted); font-size: 11px; }
  .split { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 6px 4px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 500; font-size: 13px; }
  td.num, th.num { text-align: right; }
  .empty { color: var(--muted); }
  #pools td:first-child { width: 60%; overflow-wrap: anywhere; }
  #pools a { color: var(--text); text-decoration: none; }
  #pools a:hover { color: var(--accent); text-decoration: underline; }
  .pool-site { display: block; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
  #pools td.num { white-space: nowrap; }
  footer { color: var(--muted); font-size: 12px; margin-top: 16px; }
  footer a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <header>
    <h1>BDLMiner <span>·</span> statistiques</h1>
    <div class="status" id="status" role="status">Chargement…</div>
  </header>
  <div class="tiles">
    <div class="tile"><div class="label">Hashrate total</div><div class="value accent" id="hashrate">–</div><div class="sub">5 dernières minutes</div></div>
    <div class="tile"><div class="label">Miners actifs</div><div class="value" id="miners">–</div><div class="sub">qui partagent leur hashrate</div></div>
    <div class="tile"><div class="label">Moyenne par miner</div><div class="value" id="average">–</div></div>
    <div class="tile"><div class="label">Record horaire</div><div class="value" id="record">–</div><div class="sub" id="record-at"></div></div>
  </div>
  <section>
    <h2>Hashrate total, 24 dernières heures</h2>
    <svg class="chart" id="chart" viewBox="0 0 960 220" preserveAspectRatio="none" role="img" aria-label="Hashrate total toutes les 5 minutes, 24 dernières heures"></svg>
  </section>
  <div class="split">
    <section><h2>Par carte</h2><table id="boards"></table></section>
    <section><h2>Par version</h2><table id="versions"></table></section>
  </div>
  <section><h2>Par pool</h2><table id="pools"></table><p class="status">À partir de BDLMiner 2.0.3, le partage de la pool est activé par défaut et désactivable dans les réglages Réseau. Un choix désactivé déjà enregistré est conservé. Le partage du hashrate doit aussi être activé. Les noms des pools mènent à leur site officiel. Seul le groupe public est partagé ; les autres pools sont masquées. « Pool non renseignée » inclut les anciennes versions, le partage désactivé et les connexions au pool interrompues.</p></section>
  <footer>Seuls les miners qui partagent leur hashrate (réglage « Partager mon hashrate anonymement ») sont comptés : un rapport toutes les 5 minutes (toutes les heures avant la version 1.9.2), avec la version, la carte, le hashrate et, sur certains M5Stack, le modèle. La pool publique peut être partagée séparément. Ni adresse Bitcoin, ni worker, ni nom d’hôte privé, ni identifiant. Mise à jour toutes les 20 secondes. <a href="https://github.com/bdlglua/BDLMinerV2">BDLMiner V2</a> · <a href="https://github.com/bdlglua/BDLMiner-stats">code de cette page</a> · <a href="/api/summary">données JSON</a></footer>
</main>
<script>
const UNITS = ["H/s", "kH/s", "MH/s", "GH/s", "TH/s", "PH/s", "EH/s"];
const POOL_LABELS = ${JSON.stringify(POOL_LABELS)};
const POOL_LINKS = ${JSON.stringify(POOL_LINKS)};
function rate(h) {
  if (!(h > 0)) return "0 H/s";
  let i = 0;
  while (h >= 1000 && i < UNITS.length - 1) { h /= 1000; i++; }
  return h.toLocaleString("fr-FR", { maximumFractionDigits: h >= 100 ? 0 : h >= 10 ? 1 : 2 }) + " " + UNITS[i];
}
const when = (t) => new Date(t).toLocaleString("fr-FR", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function table(el, rows, label, cell = (row) => esc(row.name)) {
  if (!rows.length) { el.innerHTML = '<tr><td class="empty">Aucun miner en ce moment.</td></tr>'; return; }
  el.innerHTML = "<tr><th>" + label + '</th><th class="num">Miners</th><th class="num">Hashrate</th></tr>' +
    rows.map((r) => "<tr><td>" + cell(r) + '</td><td class="num">' + r.miners + '</td><td class="num">' + rate(r.hashrate) + "</td></tr>").join("");
}
function poolCell(row) {
  const label = esc(Object.hasOwn(POOL_LABELS, row.name) ? POOL_LABELS[row.name] : POOL_LABELS.other);
  const url = Object.hasOwn(POOL_LINKS, row.name) ? POOL_LINKS[row.name] : null;
  return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + label + '<small class="pool-site">' + esc(url) + '</small></a>' : label;
}

function chart(points) {
  const svg = $("chart"), W = 960, H = 220, top = 12, bottom = 24, left = 0;
  if (points.length < 2) { svg.innerHTML = '<text x="12" y="110">La courbe se remplit au fil des rapports.</text>'; return; }
  const max = Math.max(...points.map((p) => p.hashrate)) * 1.1 || 1;
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const x = (t) => left + (W - left) * (t - t0) / (t1 - t0 || 1);
  const y = (v) => top + (H - top - bottom) * (1 - v / max);
  const line = points.map((p, i) => (i ? "L" : "M") + x(p.at).toFixed(1) + " " + y(p.hashrate).toFixed(1)).join(" ");
  const area = line + " L" + x(t1).toFixed(1) + " " + (H - bottom) + " L" + x(t0).toFixed(1) + " " + (H - bottom) + " Z";
  let grid = "";
  for (let i = 1; i <= 3; i++) {
    const v = max * i / 4;
    grid += '<line x1="0" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#1f2733"/><text x="4" y="' + (y(v) - 4) + '">' + rate(v) + "</text>";
  }
  const days = [];
  for (let d = new Date(t0); d <= t1; d.setHours(24, 0, 0, 0)) if (d.getTime() > t0) days.push(d.getTime());
  for (const d of days) grid += '<text x="' + Math.min(x(d) + 4, W - 40) + '" y="' + (H - 6) + '">' + new Date(d).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" }) + "</text>";
  svg.innerHTML = grid + '<path d="' + area + '" fill="#f7931a" fill-opacity=".15"/><path d="' + line + '" fill="none" stroke="#f7931a" stroke-width="2" vector-effect="non-scaling-stroke"/>';
}

async function refresh() {
  try {
    const res = await fetch("/api/summary", { cache: "no-store", credentials: "same-origin" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const s = await res.json();
    $("hashrate").textContent = rate(s.hashrate);
    $("miners").textContent = s.miners.toLocaleString("fr-FR");
    $("average").textContent = s.miners ? rate(s.hashrate / s.miners) : "–";
    $("record").textContent = s.record ? rate(s.record.hashrate) : "–";
    $("record-at").textContent = s.record ? when(s.record.at) : "";
    chart(s.recent);
    table($("boards"), s.boards, "Carte");
    table($("versions"), s.versions, "Version");
    const pools = s.pools ?? (s.miners ? [{ name: "unknown", miners: s.miners, hashrate: s.hashrate }] : []);
    table($("pools"), pools, "Pool", poolCell);
    $("status").className = "status";
    $("status").textContent = "Mis à jour " + new Date(s.at).toLocaleTimeString("fr-FR");
  } catch (e) {
    $("status").className = "status error";
    $("status").textContent = "Échec de la mise à jour (" + e.message + "), nouvel essai dans 20 secondes";
  }
}
refresh();
setInterval(refresh, 20000);
</script>
</body>
</html>
`;
