// The report contains a group from this finite list, never an endpoint.
export const PUBLIC_POOLS = Object.freeze({
  "public-pool.io": "Public Pool", "nerdminers.org": "Nerdminers.org",
  "nerdminer.io": "NerdMiner.io", "ckpool.org": "CKPool", "ocean.xyz": "OCEAN",
  "braiins.com": "Braiins Pool", "viabtc.com": "ViaBTC", "f2pool.com": "F2Pool",
  "antpool.com": "AntPool",
});
export const validPool = (value) => typeof value === "string" &&
  (value === "other" || Object.hasOwn(PUBLIC_POOLS, value));
export const poolGroup = (value) => value === undefined ? "unknown" : validPool(value) ? value : "other";
export const POOL_LABELS = { ...PUBLIC_POOLS, other: "Autre / pool privée", unknown: "Pool non renseignée" };
