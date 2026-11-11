use crate::{db::Db, n, s, Result, DAY, HOUR, SAMPLE};
use serde_json::{json, Value};
use std::collections::BTreeMap;
const GRACE: i64 = 30000;
struct Entry {
    v: Value,
    known: bool,
}
pub struct Store {
    pub db: Db,
    live: Vec<Entry>,
    pruned: i64,
}
#[derive(Default, Clone)]
struct Total {
    miners: f64,
    hashrate: f64,
}
#[derive(Default)]
struct Span {
    total: Total,
    boards: BTreeMap<String, Total>,
    versions: BTreeMap<String, Total>,
}
fn accumulate(map: &mut BTreeMap<String, Total>, key: &str, rate: f64, share: f64) {
    let e = map.entry(key.into()).or_default();
    e.miners += share;
    e.hashrate += rate * share;
}
fn end(r: &Value) -> i64 {
    n(&r["t"]) as i64 + (n(&r["every"]) * 1000.0).round() as i64
}
fn breakdown(map: BTreeMap<String, Total>) -> Vec<Value> {
    let mut out:Vec<_>=map.into_iter().map(|(name,t)|json!({"name":name,"miners":t.miners.round().max(1.0)as u64,"hashrate":t.hashrate})).collect();
    out.sort_by(|a, b| n(&b["hashrate"]).total_cmp(&n(&a["hashrate"])));
    out
}
impl Store {
    pub fn new(db: Db, now: i64) -> Result<Self> {
        db.0.execute_batch("CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS samples (t INTEGER PRIMARY KEY,hashrate REAL NOT NULL,miners REAL NOT NULL,boards TEXT NOT NULL);")?;
        let raw = db.one("SELECT value FROM state WHERE key='live'", &[])?;
        let values: Vec<Value> = if raw.is_null() {
            vec![]
        } else {
            serde_json::from_str(s(&raw["value"]))?
        };
        let mut store = Self {
            db,
            live: values
                .into_iter()
                .map(|v| Entry { v, known: false })
                .collect(),
            pruned: 0,
        };
        if !store
            .db
            .one(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='reports'",
                &[],
            )?
            .is_null()
        {
            for mut r in store.db.exec(
                "SELECT t,v,board,hashrate FROM reports WHERE t>?",
                &[json!(now - HOUR)],
            )? {
                r["every"] = json!(3600);
                store.live.push(Entry { v: r, known: false });
            }
            store.db.exec("DROP TABLE reports", &[])?;
            store.save()?;
        }
        if store.get("samples-reset")?.as_deref() != Some("3") {
            store.db.exec(
                "DELETE FROM samples WHERE t<=?",
                &[json!(1793391000000_i64)],
            )?;
            store.put("samples-reset", "3")?;
        }
        Ok(store)
    }
    pub fn get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .db
            .one("SELECT value FROM state WHERE key=?", &[json!(key)])?["value"]
            .as_str()
            .map(str::to_owned))
    }
    pub fn put(&self, key: &str, value: &str) -> Result<()> {
        self.db.exec("INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",&[json!(key),json!(value)])?;
        Ok(())
    }
    fn save(&self) -> Result<()> {
        self.put(
            "live",
            &serde_json::to_string(&self.live.iter().map(|e| &e.v).collect::<Vec<_>>())?,
        )
    }
    fn span(&self, from: i64, to: i64) -> Span {
        let mut result = Span::default();
        for entry in &self.live {
            let r = &entry.v;
            let share =
                (to.min(end(r)) - from.max(n(&r["t"]) as i64)).max(0) as f64 / (to - from) as f64;
            if share == 0.0 {
                continue;
            }
            let rate = n(&r["hashrate"]);
            result.total.hashrate += rate * share;
            result.total.miners += share;
            accumulate(&mut result.boards, s(&r["board"]), rate, share);
            accumulate(&mut result.versions, s(&r["v"]), rate, share);
        }
        result
    }
    pub fn sample(&mut self, now: i64) -> Result<()> {
        let last = self.db.one("SELECT MAX(t) AS t FROM samples", &[])?;
        let mut at = last["t"]
            .as_i64()
            .map(|v| v + SAMPLE)
            .unwrap_or(now / SAMPLE * SAMPLE);
        if now - at > DAY {
            at = (now - DAY) / SAMPLE * SAMPLE;
        }
        while at <= now {
            let span = self.span(at - SAMPLE, at);
            let boards: BTreeMap<_, _> = span
                .boards
                .iter()
                .map(|(b, t)| (b, t.miners.round()))
                .collect();
            self.db.exec(
                "INSERT OR IGNORE INTO samples VALUES (?,?,?,?)",
                &[
                    json!(at),
                    json!(span.total.hashrate),
                    json!(span.total.miners),
                    json!(serde_json::to_string(&boards)?),
                ],
            )?;
            at += SAMPLE;
        }
        if self.pruned == 0 || now - self.pruned > 6 * HOUR {
            self.pruned = now;
            self.db
                .exec("DELETE FROM samples WHERE t<?", &[json!(now - 35 * DAY)])?;
        }
        Ok(())
    }
    pub fn add(&mut self, report: &Value, now: i64) -> Result<()> {
        self.db.0.execute_batch("BEGIN IMMEDIATE")?;
        let result = self.add_inner(report, now);
        if result.is_ok() {
            self.db.0.execute_batch("COMMIT")?;
        } else {
            let _ = self.db.0.execute_batch("ROLLBACK");
        }
        result
    }
    fn add_inner(&mut self, report: &Value, now: i64) -> Result<()> {
        self.sample(now)?;
        for entry in &mut self.live {
            let r = &mut entry.v;
            if !entry.known
                && report.get("every").is_some()
                && r["every"] == 3600
                && r["board"] == report["board"]
                && r["v"] != report["v"]
                && end(r) > now
            {
                r["every"] = json!(((now - n(&r["t"]) as i64) as f64 / 1000.0).max(1.0));
            }
        }
        let mut v = report.clone();
        v["t"] = json!(now);
        if v.get("every").is_none() {
            v["every"] = json!(3600);
        }
        self.live.push(Entry { v, known: true });
        let last = self.db.one("SELECT MAX(t) AS t FROM samples", &[])?["t"]
            .as_i64()
            .unwrap_or(now / SAMPLE * SAMPLE);
        let keep = last.min(now) - SAMPLE;
        self.live.retain(|e| end(&e.v) + GRACE > keep);
        self.save()
    }
    pub fn summary(&mut self, now: i64) -> Result<Value> {
        self.sample(now)?;
        let recent = self.span(now - SAMPLE, now);
        let active: Vec<_> = self
            .live
            .iter()
            .map(|e| &e.v)
            .filter(|r| n(&r["t"]) <= now as f64 && now < end(r))
            .collect();
        let late: Vec<_> = self
            .live
            .iter()
            .map(|e| &e.v)
            .filter(|r| end(r) <= now && now < end(r) + GRACE)
            .collect();
        let count = |rows: &[&Value]| {
            let mut m = BTreeMap::<String, f64>::new();
            for r in rows {
                *m.entry(s(&r["board"]).into()).or_default() += 1.0;
            }
            m
        };
        let strict = count(&active);
        let grace = count(&late);
        let mut online = BTreeMap::<String, f64>::new();
        for b in strict.keys().chain(grace.keys()) {
            let sure = *strict.get(b).unwrap_or(&0.0);
            let total = sure.max(
                (sure + grace.get(b).unwrap_or(&0.0)).min(
                    recent
                        .boards
                        .get(b)
                        .map(|v| v.miners.round())
                        .unwrap_or(0.0),
                ),
            );
            if total > 0.0 {
                online.insert(b.clone(), total);
            }
        }
        let mut boards = BTreeMap::new();
        let mut versions = BTreeMap::new();
        let mut models = BTreeMap::new();
        let mut pools = BTreeMap::new();
        let mut coins = BTreeMap::new();
        let mut total = 0.0;
        for (r, share) in active
            .iter()
            .map(|r| (*r, 1.0))
            .chain(late.iter().filter_map(|r| {
                let b = s(&r["board"]);
                let missing = online.get(b).unwrap_or(&0.0) - strict.get(b).unwrap_or(&0.0);
                (missing > 0.0).then(|| (*r, missing / grace[b]))
            }))
        {
            let rate = n(&r["hashrate"]);
            total += rate * share;
            accumulate(&mut boards, s(&r["board"]), rate, share);
            accumulate(&mut versions, s(&r["v"]), rate, share);
            accumulate(
                &mut models,
                &format!("{}\n{}", s(&r["board"]), s(&r["model"])),
                rate,
                share,
            );
            accumulate(
                &mut pools,
                r["pool"].as_str().unwrap_or("unknown"),
                rate,
                share,
            );
            accumulate(&mut coins, r["coin"].as_str().unwrap_or("BTC"), rate, share);
        }
        let samples = self.db.exec(
            "SELECT t,hashrate,miners,boards FROM samples WHERE t>? ORDER BY t",
            &[json!(now - 7 * DAY)],
        )?;
        let mut hours: BTreeMap<i64, Vec<&Value>> = BTreeMap::new();
        for p in &samples {
            let h = (p["t"].as_i64().unwrap() - 1) / HOUR * HOUR;
            hours.entry(h).or_default().push(p);
        }
        let mut peak = online.clone();
        for group in hours.values().filter(|p| p.len() >= 12) {
            let values: Vec<Value> = group
                .iter()
                .map(|p| serde_json::from_str(s(&p["boards"])))
                .collect::<std::result::Result<_, _>>()?;
            for b in values
                .iter()
                .filter_map(Value::as_object)
                .flat_map(|p| p.keys())
            {
                let min = values
                    .iter()
                    .map(|p| n(&p[b]))
                    .fold(f64::INFINITY, f64::min);
                let e = peak.entry(b.clone()).or_default();
                *e = e.max(min);
            }
        }
        let mut fleet: Vec<_> = peak
            .into_iter()
            .map(|(board, peak)| {
                let on = *online.get(&board).unwrap_or(&0.0);
                json!({"board":board,"online":on as u64,"offline":(peak-on).max(0.0)as u64})
            })
            .filter(|v| n(&v["online"]) + n(&v["offline"]) > 0.0)
            .collect();
        fleet.sort_by(|a, b| {
            n(&b["online"])
                .total_cmp(&n(&a["online"]))
                .then(n(&b["offline"]).total_cmp(&n(&a["offline"])))
                .then(s(&a["board"]).cmp(s(&b["board"])))
        });
        let hour_point = |at: i64, points: &Vec<&Value>| {
            let count = points.len() as f64;
            let miners = points.iter().map(|p| n(&p["miners"])).sum::<f64>() / count;
            json!({"at":at,"end_at":points.last().unwrap()["t"],"first_at":points[0]["t"],"hashrate":points.iter().map(|p|n(&p["hashrate"])).sum::<f64>()/count,"miners":miners.round()as u64,"average_miners":miners,"samples":points.len(),"interval_ms":HOUR,"missing":points.len()<((now.min(at+HOUR)-at)/SAMPLE).max(1)as usize})
        };
        let this_hour = now / HOUR * HOUR;
        let mut history: Vec<_> = hours
            .iter()
            .filter(|(h, _)| **h < this_hour)
            .map(|(h, p)| hour_point(*h, p))
            .collect();
        let mut periods = serde_json::Map::new();
        for duration in [1, 6, 24, 168] {
            let from = now - duration * HOUR;
            let rows: Vec<_> = samples
                .iter()
                .filter(|p| n(&p["t"]) > from as f64 && n(&p["t"]) <= now as f64)
                .collect();
            let count = rows.len();
            let rates: Vec<_> = rows.iter().map(|p| n(&p["hashrate"])).collect();
            let miners: Vec<_> = rows.iter().map(|p| n(&p["miners"])).collect();
            let avg = |v: &[f64]| {
                if count > 0 {
                    Some(v.iter().sum::<f64>() / count as f64)
                } else {
                    None
                }
            };
            let extremum = |v: &[f64], max: bool| {
                v.iter()
                    .copied()
                    .reduce(if max { f64::max } else { f64::min })
            };
            let rate = avg(&rates);
            let variation = if count > 1 && rate.unwrap_or(0.0) > 0.0 {
                let a = rate.unwrap();
                Some(
                    (rates.iter().map(|v| (v - a).powi(2)).sum::<f64>() / count as f64).sqrt() / a
                        * 100.0,
                )
            } else {
                None
            };
            periods.insert(duration.to_string(),json!({"from":from,"to":now,"samples":count,"expected_samples":duration*HOUR/SAMPLE,"average_hashrate":rate,"minimum_hashrate":extremum(&rates,false),"maximum_hashrate":extremum(&rates,true),"variation_percent":variation,"average_miners":avg(&miners),"minimum_miners":extremum(&miners,false),"maximum_miners":extremum(&miners,true),"first_at":rows.first().map(|v|&v["t"]),"last_at":rows.last().map(|v|&v["t"])}));
        }
        let best=self.db.one(&format!("SELECT h,AVG(hashrate) AS hashrate FROM (SELECT (t-1)/{HOUR} AS h,hashrate FROM samples) GROUP BY h HAVING COUNT(*)>=6 ORDER BY 2 DESC LIMIT 1"),&[])?;
        let mut record = if n(&best["hashrate"]) > 0.0 {
            json!({"at":best["h"].as_i64().unwrap()*HOUR,"hashrate":best["hashrate"]})
        } else {
            Value::Null
        };
        if let Some(archive) = self.get("selfhost-archive")? {
            let archive: Value = serde_json::from_str(&archive)?;
            let first = self.db.one("SELECT MIN(t) AS t FROM samples", &[])?["t"].as_i64();
            let cutoff = first.map(|v| (v - 1) / HOUR * HOUR).unwrap_or(now);
            let mut old: Vec<_> = archive["history"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|p| {
                    n(&p["at"]) >= (now - 7 * DAY) as f64 && n(&p["end_at"]) <= cutoff as f64
                })
                .cloned()
                .collect();
            old.extend(history);
            history = old;
            if n(&archive["record"]["at"]) > (now - 35 * DAY) as f64
                && n(&archive["record"]["hashrate"]) > n(&record["hashrate"])
            {
                record = archive["record"].clone();
            }
        }
        let miners = online.values().sum::<f64>() as u64;
        let mut recent:Vec<_>=samples.iter().filter(|p|n(&p["t"])>(now-DAY)as f64).map(|p|json!({"at":p["t"],"hashrate":p["hashrate"],"miners":n(&p["miners"]).round()as u64,"average_miners":p["miners"],"samples":1,"interval_ms":SAMPLE})).collect();
        recent.push(json!({"at":now,"hashrate":total,"miners":miners,"live":true}));
        let models: Vec<_> = breakdown(models)
            .into_iter()
            .map(|mut v| {
                let name = s(&v["name"]).to_string();
                let (board, model) = name.split_once('\n').unwrap();
                v.as_object_mut().unwrap().remove("name");
                v["board"] = board.into();
                v["model"] = if model.is_empty() {
                    Value::Null
                } else {
                    model.into()
                };
                v
            })
            .collect();
        Ok(
            json!({"at":now,"miners":miners,"hashrate":total,"boards":breakdown(boards),"versions":breakdown(versions),"pools":breakdown(pools),"coins":breakdown(coins),"models":models,"fleet":fleet,"recent":recent,"history":history,"current_hour":hours.get(&this_hour).map(|p|hour_point(this_hour,p)),"periods":periods,"record":record}),
        )
    }
    pub fn import(&self, snapshot: &Value, now: i64) -> Result<usize> {
        let at = snapshot["at"]
            .as_i64()
            .filter(|v| *v <= now + 60000)
            .ok_or("Invalid public snapshot")?;
        let recent = snapshot["recent"]
            .as_array()
            .ok_or("Invalid public snapshot")?;
        let history = snapshot["history"]
            .as_array()
            .ok_or("Invalid public snapshot")?;
        let nonnegative = |v: &Value| v.as_f64().map(|v| v >= 0.0).unwrap_or(false);
        self.db.transaction(|| {
            let mut imported = 0;
            for p in recent {
                let miners = p.get("average_miners").unwrap_or(&p["miners"]);
                if p["live"] == true
                    || p["samples"] != 1
                    || p["interval_ms"] != SAMPLE
                    || !p["at"]
                        .as_i64()
                        .map(|t| t % SAMPLE == 0 && t <= now.min(at) && t > now - 35 * DAY)
                        .unwrap_or(false)
                    || !nonnegative(&p["hashrate"])
                    || !nonnegative(miners)
                {
                    continue;
                }
                self.db.exec(
                    "INSERT OR IGNORE INTO samples VALUES (?,?,?,?)",
                    &[
                        p["at"].clone(),
                        p["hashrate"].clone(),
                        miners.clone(),
                        json!("{}"),
                    ],
                )?;
                imported += 1;
            }
            let history: Vec<_> = history
                .iter()
                .filter(|p| {
                    p["at"]
                        .as_i64()
                        .map(|t| t % HOUR == 0 && t > now - 7 * DAY - HOUR && t < at)
                        .unwrap_or(false)
                        && p["end_at"]
                            .as_i64()
                            .map(|t| t <= now.min(at))
                            .unwrap_or(false)
                        && nonnegative(&p["hashrate"])
                        && nonnegative(&p["miners"])
                        && p["samples"]
                            .as_i64()
                            .map(|v| (1..=12).contains(&v))
                            .unwrap_or(false)
                })
                .collect();
            let r = &snapshot["record"];
            let record = if r["at"]
                .as_i64()
                .map(|t| t <= at && t > now - 35 * DAY)
                .unwrap_or(false)
                && nonnegative(&r["hashrate"])
            {
                r.clone()
            } else {
                Value::Null
            };
            self.put(
                "selfhost-archive",
                &json!({"history":history,"record":record}).to_string(),
            )?;
            self.put("selfhost-imported-at", &now.to_string())?;
            Ok(imported)
        })
    }
}
