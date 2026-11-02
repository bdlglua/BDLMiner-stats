// The report contains a group from this finite list, never an endpoint.
export const PUBLIC_POOLS = Object.freeze({
  "public-pool.io": "Public Pool", "nerdminers.org": "Nerdminers.org",
  "nerdminer.io": "NerdMiner.io", "ckpool.org": "CKPool", "ocean.xyz": "OCEAN",
  "braiins.com": "Braiins Pool", "viabtc.com": "ViaBTC", "f2pool.com": "F2Pool",
  "antpool.com": "AntPool",
});
export const POOL_LINKS = Object.freeze({
  "public-pool.io": "https://web.public-pool.io/", "nerdminers.org": "https://pool.nerdminers.org/",
  "nerdminer.io": "https://nerdminer.io/", "ckpool.org": "https://solo.ckpool.org/",
  "ocean.xyz": "https://ocean.xyz/", "braiins.com": "https://braiins.com/pool",
  "viabtc.com": "https://www.viabtc.com/", "f2pool.com": "https://www.f2pool.com/",
  "antpool.com": "https://www.antpool.com/",
});
export const validPool = (value) => typeof value === "string" &&
  (value === "other" || Object.hasOwn(PUBLIC_POOLS, value));
export const poolGroup = (value) => value === undefined ? "unknown" : validPool(value) ? value : "other";
export const POOL_LABELS = { ...PUBLIC_POOLS, other: "Autre / pool privée", unknown: "Pool non renseignée" };
