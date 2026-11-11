pub mod db;
pub mod http;
pub mod private;
pub mod public;
use serde_json::Value;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
pub fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}
pub fn regex(pattern: &str, value: &str) -> bool {
    use std::{
        collections::HashMap,
        sync::{Mutex, OnceLock},
    };
    static CACHE: OnceLock<Mutex<HashMap<String, regex::Regex>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().unwrap();
    cache
        .entry(pattern.into())
        .or_insert_with(|| regex::Regex::new(pattern).unwrap())
        .is_match(value)
}
pub const HOUR: i64 = 3600000;
pub const DAY: i64 = 24 * HOUR;
pub const SAMPLE: i64 = 300000;
pub const POOLS: &[&str] = &[
    "public-pool.io",
    "nerdminers.org",
    "nerdminer.io",
    "ckpool.org",
    "ocean.xyz",
    "braiins.com",
    "viabtc.com",
    "f2pool.com",
    "antpool.com",
    "bdl-pool.com",
    "solopool.org",
    "kano.is",
    "atlaspool.io",
    "solomining.de",
    "satoshiradio.nl",
    "noderunners.network",
    "d-central.tech",
    "mining-dutch.nl",
    "luxor.tech",
    "nicehash.com",
    "secpool.com",
    "spiderpool.com",
    "hmpool.io",
    "molepool.com",
    "peermining.org",
    "other",
];
pub fn coin(v: &Value) -> bool {
    ["BTC", "BCH", "BSV", "XEC", "DGB", "PPC"].contains(&s(v))
}
pub fn pool(v: &Value) -> bool {
    POOLS.contains(&s(v))
}
pub fn parse_report(v: &Value) -> Option<Value> {
    let version = s(&v["v"]);
    let parsed = semver::Version::parse(version).ok()?;
    if version.len() > 23
        || [parsed.major, parsed.minor, parsed.patch]
            .iter()
            .any(|n| *n > 999)
        || !regex(r"^[a-z0-9-]{1,32}$", s(&v["board"]))
    {
        return None;
    }
    let max = match s(&v["board"]) {
        "nerdnos" => 2e12,
        "bitaxe-gamma-601" => 5e12,
        _ => 5e6,
    };
    if !(v["hashrate"].as_f64()? > 0.0 && n(&v["hashrate"]) <= max) {
        return None;
    }
    if v.get("every").is_some()
        && !v["every"]
            .as_u64()
            .map(|n| (60..=86400).contains(&n))
            .unwrap_or(false)
    {
        return None;
    }
    if v.get("model").is_some() && !regex(r"^[A-Za-z0-9 .+()-]{1,39}$", s(&v["model"])) {
        return None;
    }
    if v.get("pool").is_some() && !pool(&v["pool"]) || v.get("coin").is_some() && !coin(&v["coin"])
    {
        return None;
    }
    let mut out = serde_json::Map::new();
    for k in ["v", "board", "hashrate", "every", "pool", "coin"] {
        if let Some(v) = v.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    let plain = |v: &Value| {
        s(v).chars()
            .filter(char::is_ascii_alphanumeric)
            .collect::<String>()
            .to_ascii_lowercase()
    };
    if v.get("model").is_some() && plain(&v["model"]) != plain(&v["board"]) {
        out.insert("model".into(), v["model"].clone());
    }
    Some(Value::Object(out))
}
