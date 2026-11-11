// The report contains a group from this finite list, never an endpoint.
export const PUBLIC_POOLS = Object.freeze({
  "public-pool.io": "Public Pool", "nerdminers.org": "Nerdminers.org",
  "nerdminer.io": "NerdMiner.io", "ckpool.org": "CKPool", "ocean.xyz": "OCEAN",
  "braiins.com": "Braiins Pool", "viabtc.com": "ViaBTC", "f2pool.com": "F2Pool",
  "antpool.com": "AntPool",
  // Appended with the firmware's list (BDLMinerV2, src/core/public_pool.h) and
  // the site's (installer/content.json). This service goes first: a report
  // naming a group it does not know is refused.
  "bdl-pool.com": "BDL Pool", "solopool.org": "SoloPool.org",
  "kano.is": "KanoPool", "atlaspool.io": "AtlasPool",
  "solomining.de": "Solomining.de", "satoshiradio.nl": "Satoshi Radio",
  "noderunners.network": "Noderunners", "d-central.tech": "D-Central",
  "mining-dutch.nl": "Mining-Dutch", "luxor.tech": "Luxor",
  "nicehash.com": "NiceHash", "secpool.com": "SECPOOL",
  "spiderpool.com": "SpiderPool", "hmpool.io": "HMPool",
  "molepool.com": "Molepool", "peermining.org": "Peermining",
});
export const POOL_LINKS = Object.freeze({
  "public-pool.io": "https://web.public-pool.io/", "nerdminers.org": "https://pool.nerdminers.org/",
  "nerdminer.io": "https://nerdminer.io/", "ckpool.org": "https://solo.ckpool.org/",
  "ocean.xyz": "https://ocean.xyz/", "braiins.com": "https://braiins.com/pool",
  "viabtc.com": "https://www.viabtc.com/", "f2pool.com": "https://www.f2pool.com/",
  "antpool.com": "https://www.antpool.com/",
  "bdl-pool.com": "https://bdl-pool.com/", "solopool.org": "https://solopool.org/",
  "kano.is": "https://kano.is/", "atlaspool.io": "https://atlaspool.io/",
  "solomining.de": "https://pool.solomining.de/", "satoshiradio.nl": "https://pool.satoshiradio.nl/",
  "noderunners.network": "https://noderunners.network/", "d-central.tech": "https://d-central.tech/",
  "mining-dutch.nl": "https://www.mining-dutch.nl/", "luxor.tech": "https://luxor.tech/",
  "nicehash.com": "https://www.nicehash.com/", "secpool.com": "https://www.secpool.com/",
  "spiderpool.com": "https://www.spiderpool.com/", "hmpool.io": "https://hmpool.io/",
  "molepool.com": "https://molepool.com/", "peermining.org": "https://peermining.org/",
});
export const validPool = (value) => typeof value === "string" &&
  (value === "other" || Object.hasOwn(PUBLIC_POOLS, value));
export const poolGroup = (value) => value === undefined ? "unknown" : validPool(value) ? value : "other";
export const POOL_LABELS = { ...PUBLIC_POOLS, other: "Autre / pool privée", unknown: "Pool non renseignée" };
