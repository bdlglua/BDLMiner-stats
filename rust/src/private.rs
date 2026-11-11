use crate::{coin, db::Db, n, parse_report, pool, regex, s, Result, DAY, HOUR};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
pub fn auth(header: &str) -> Option<(String, bool)> {
    let (secret, key) = if regex(r"^Bearer [a-f0-9]{64}$", header) {
        (header[7..].to_string(), true)
    } else {
        let value = header.strip_prefix("Address ")?;
        let address = value.trim().split('.').next()?.to_lowercase();
        if !regex(r"^[a-z0-9:_-]{4,100}$", &address) {
            return None;
        }
        (format!("address:{address}"), false)
    };
    Some((format!("{:x}", Sha256::digest(secret.as_bytes())), key))
}
pub fn parse(v: &Value) -> Option<Value> {
    let check = json!({"board":v["board"],"v":v["v"],"coin":v["coin"],"hashrate":n(&v["hashrate"]).max(1.0)});
    let text = s(&v["name"]);
    if !regex(r"^[a-f0-9]{16}$", s(&v["id"]))
        || text.is_empty()
        || text.encode_utf16().count() > 48
        || text.chars().any(|c| c < ' ' || c == '\u{7f}')
        || !regex(r"^[a-f0-9]{1,16}$", s(&v["boot_id"]))
        || !coin(&v["coin"])
        || parse_report(&check).is_none()
    {
        return None;
    }
    for key in ["hashrate", "total_hashes", "best"] {
        let val = v[key].as_f64()?;
        if !(0.0..=1e30).contains(&val) {
            return None;
        }
    }
    for key in ["uptime_s", "accepted", "rejected", "power_percent"] {
        if v[key].as_u64()?
            > if key == "power_percent" {
                100
            } else {
                u64::from(u32::MAX)
            }
        {
            return None;
        }
    }
    if v["pool_connected"].as_bool().is_none()
        || v["firmware_trial"].as_bool().is_none()
        || (!pool(&v["pool"]) && v["pool"] != "unknown")
    {
        return None;
    }
    if !v["temp_c"].is_null()
        && !v["temp_c"]
            .as_f64()
            .map(|v| (-50.0..=150.0).contains(&v))
            .unwrap_or(false)
    {
        return None;
    }
    v.get("temp_c")?;
    let mut out = serde_json::Map::new();
    for key in [
        "id",
        "name",
        "board",
        "v",
        "coin",
        "boot_id",
        "uptime_s",
        "hashrate",
        "total_hashes",
        "temp_c",
        "accepted",
        "rejected",
        "best",
        "power_percent",
        "pool_connected",
        "pool",
        "firmware_trial",
    ] {
        out.insert(key.into(), v[key].clone());
    }
    Some(Value::Object(out))
}
pub fn init(db: &Db) -> Result<()> {
    db.0.execute_batch("CREATE TABLE IF NOT EXISTS remote_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS miners (id TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS readings (miner TEXT NOT NULL,t INTEGER NOT NULL,boot TEXT NOT NULL,rate REAL NOT NULL,temp REAL,PRIMARY KEY(miner,t));")?;
    Ok(())
}
pub fn revoked(db: &Db) -> Result<bool> {
    Ok(n(&db.one("SELECT value FROM remote_meta WHERE key='revoked'", &[])?["value"]) != 0.0)
}
pub fn prune(db: &Db, now: i64) -> Result<()> {
    db.exec("DELETE FROM readings WHERE t < ?", &[json!(now - 7 * DAY)])?;
    db.exec("DELETE FROM miners WHERE at < ?", &[json!(now - 7 * DAY)])?;
    Ok(())
}
pub fn add(db: &Db, report: &Value, now: i64) -> Result<u16> {
    if revoked(db)? {
        return Ok(410);
    }
    prune(db, now)?;
    let old = db.one("SELECT at FROM miners WHERE id=?", &[report["id"].clone()])?;
    if !old.is_null() && now - (n(&old["at"]) as i64) < 60000 {
        return Ok(429);
    }
    if old.is_null() && n(&db.one("SELECT COUNT(*) AS n FROM miners", &[])?["n"]) >= 32.0 {
        return Ok(409);
    }
    db.exec("INSERT INTO miners VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at,body=excluded.body",&[report["id"].clone(),json!(now),json!(report.to_string())])?;
    db.exec(
        "INSERT OR REPLACE INTO readings VALUES (?,?,?,?,?)",
        &[
            report["id"].clone(),
            json!(now),
            report["boot_id"].clone(),
            report["hashrate"].clone(),
            report["temp_c"].clone(),
        ],
    )?;
    Ok(204)
}
pub fn snapshot(db: &Db, now: i64) -> Result<Value> {
    prune(db, now)?;
    let mut miners = Vec::new();
    let mut total = 0.0;
    for row in db.exec("SELECT at,body FROM miners ORDER BY at DESC", &[])? {
        let mut v: Value = serde_json::from_str(s(&row["body"]))?;
        let age = (now - n(&row["at"]) as i64).max(0);
        v["at"] = row["at"].clone();
        v["age_s"] = json!(age as f64 / 1000.0);
        v["online"] = json!(age <= 660000);
        if v["online"] == true {
            total += n(&v["hashrate"]);
        }
        miners.push(v);
    }
    Ok(
        json!({"miners":miners,"hashrate":total,"recorded_at":now,"report_interval_s":300,"retention_days":7}),
    )
}
pub fn history(db: &Db, miner: &str, hours: i64, now: i64) -> Result<Option<Value>> {
    if !regex(r"^[a-f0-9]{16}$", miner) || ![1, 6, 24, 168].contains(&hours) {
        return Ok(None);
    }
    prune(db, now)?;
    let bucket = SAMPLE_MAX.max(hours * HOUR / 480);
    let start = now - hours * HOUR;
    let mut points=db.exec("SELECT CAST(t/? AS INTEGER)*? AS t,AVG(rate) AS rate,MIN(rate) AS min_rate,MAX(rate) AS max_rate,AVG(temp) AS temp,MAX(temp) AS max_temp,COUNT(*) AS samples,MIN(boot) AS boot,COUNT(DISTINCT boot) AS boots FROM readings WHERE miner=? AND t>=? AND t<=? GROUP BY CAST(t/? AS INTEGER) ORDER BY t",&[json!(bucket),json!(bucket),json!(miner),json!(start),json!(now),json!(bucket)])?;
    for p in &mut points {
        p["mixed_boots"] = json!(n(&p["boots"]) > 1.0);
    }
    let args = [json!(miner), json!(start), json!(now)];
    let mut summary=db.one("SELECT COUNT(*) AS reports,AVG(rate) AS average,MIN(rate) AS minimum,MAX(rate) AS maximum,AVG(rate*rate) AS mean_square,AVG(temp) AS temperature_average,MAX(temp) AS temperature_maximum,MIN(t) AS first_at,MAX(t) AS last_at FROM readings WHERE miner=? AND t>=? AND t<=?",&args)?;
    let restarts=db.one("SELECT COUNT(*) AS n FROM (SELECT boot,LAG(boot) OVER (ORDER BY t) AS previous FROM readings WHERE miner=? AND t>=? AND t<=?) WHERE previous IS NOT NULL AND boot!=previous",&args)?;
    let avg = n(&summary["average"]);
    summary["variation_percent"] = if n(&summary["reports"]) > 1.0 && avg > 0.0 {
        json!((n(&summary["mean_square"]) - avg * avg).max(0.0).sqrt() / avg * 100.0)
    } else {
        Value::Null
    };
    summary.as_object_mut().unwrap().remove("mean_square");
    summary["restarts"] = restarts["n"].clone();
    Ok(Some(
        json!({"points":points,"interval_ms":bucket,"window_start":start,"window_end":now,"summary":summary}),
    ))
}
const SAMPLE_MAX: i64 = 300000;
pub fn revoke(db: &Db) -> Result<()> {
    db.0.execute_batch("DELETE FROM miners;DELETE FROM readings;INSERT OR REPLACE INTO remote_meta VALUES ('revoked',1);")?;
    Ok(())
}
