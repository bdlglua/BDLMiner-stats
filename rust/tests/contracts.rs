use axum::http::HeaderMap;
use bdlminer_stats::{
    db::Db,
    http::{App, Config},
    parse_report, private,
    public::Store,
    DAY, HOUR, SAMPLE,
};
use serde_json::{json, Value};
const NOW: i64 = 1794326400000;
fn public() -> Value {
    json!({"v":"2.3.0","board":"m5stickc-plus2","hashrate":1000000,"every":300,"coin":"BTC","pool":"bdl-pool.com","private_token":"must not persist"})
}
fn remote() -> Value {
    json!({"id":"0000000000000001","name":"Miner","v":"2.3.0","board":"m5stickc-plus2","coin":"BTC","boot_id":"00000001","uptime_s":60,"hashrate":0,"total_hashes":0,"temp_c":null,"accepted":0,"rejected":0,"best":0,"power_percent":0,"pool_connected":false,"pool":"unknown","firmware_trial":false,"address":"secret"})
}
#[test]
fn strict_reports_preserve_whitelisted_fields_and_bound_per_board_rate() {
    let report = public();
    let valid = parse_report(&report).unwrap();
    assert!(valid.get("private_token").is_none());
    for change in [
        json!({"v":"01.0.0"}),
        json!({"v":"2.0.0-beta.01"}),
        json!({"v":"1000.0.0"}),
        json!({"hashrate":0}),
        json!({"hashrate":5000001}),
        json!({"every":59}),
        json!({"every":true}),
        json!({"pool":"https://private.example"}),
        json!({"coin":"XYZ"}),
        json!({"model":"<script>"}),
    ] {
        let mut bad = report.clone();
        for (k, v) in change.as_object().unwrap() {
            bad[k] = v.clone();
        }
        assert!(parse_report(&bad).is_none(), "{bad}");
    }
    let mut asic = report;
    asic["board"] = "bitaxe-gamma-601".into();
    asic["hashrate"] = json!(1.2e12);
    assert!(parse_report(&asic).is_some());
    asic["v"] = "2.3.0-beta.1+test".into();
    assert!(parse_report(&asic).is_some());
}
#[test]
fn intervals_grace_and_history_do_not_double_count_or_interpolate() {
    let mut store = Store::new(Db::memory().unwrap(), NOW).unwrap();
    let r = parse_report(&public()).unwrap();
    store.add(&r, NOW).unwrap();
    store.add(&r, NOW + SAMPLE + 5000).unwrap();
    let live = store.summary(NOW + SAMPLE + 10000).unwrap();
    assert_eq!(live["miners"], 1);
    assert_eq!(live["hashrate"], 1000000.0);
    assert_eq!(live["boards"][0]["miners"], 1);
    assert!(live["miners"].as_u64().is_some());
    let gone = store.summary(NOW + 2 * SAMPLE + 40000).unwrap();
    assert_eq!(gone["miners"], 0);
    assert_eq!(gone["hashrate"], 0.0);
    let samples = &gone["recent"];
    assert!(samples
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["samples"] == 1 && p["hashrate"] == 1000000.0));
    assert!(gone["periods"]["1"]["maximum_hashrate"].as_f64().unwrap() > 0.0);
    let after = store.summary(NOW + 3 * DAY).unwrap();
    assert!(after["recent"]
        .as_array()
        .unwrap()
        .iter()
        .all(|p| p["at"].as_i64().unwrap() >= NOW + 2 * DAY - SAMPLE));
}
#[test]
fn sqlite_schema_and_live_state_survive_a_runtime_replacement() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("public.sqlite");
    {
        let mut store = Store::new(Db::open(&path).unwrap(), NOW).unwrap();
        store.add(&parse_report(&public()).unwrap(), NOW).unwrap();
        store.sample(NOW + SAMPLE).unwrap();
        store
            .put("selfhost-imported-at", "prior migration")
            .unwrap();
    }
    let mut store = Store::new(Db::open(&path).unwrap(), NOW + SAMPLE).unwrap();
    assert_eq!(
        store.get("selfhost-imported-at").unwrap().as_deref(),
        Some("prior migration")
    );
    let live = store.summary(NOW + SAMPLE - 1000).unwrap();
    assert_eq!(live["miners"], 1);
    assert_eq!(live["hashrate"], 1000000.0);
    assert!(store
        .db
        .one("PRAGMA quick_check", &[])
        .unwrap()
        .to_string()
        .contains("ok"));
}
#[test]
fn import_uses_only_genuine_five_minute_readings() {
    let store = Store::new(Db::memory().unwrap(), NOW).unwrap();
    let summary = json!({"at":NOW,"recent":[{"at":NOW-SAMPLE,"hashrate":100,"miners":1,"samples":1,"interval_ms":SAMPLE},{"at":NOW-HOUR,"hashrate":9999,"miners":3,"samples":12,"interval_ms":HOUR},{"at":NOW,"hashrate":8888,"miners":2,"live":true,"samples":1,"interval_ms":SAMPLE}],"history":[],"record":null});
    assert_eq!(store.import(&summary, NOW).unwrap(), 1);
    let rows = store.db.exec("SELECT * FROM samples", &[]).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["hashrate"], 100.0);
    assert!(store
        .import(&json!({"at":NOW+60001,"recent":[],"history":[]}), NOW)
        .is_err());
}
#[test]
fn private_identity_is_namespaced_and_only_filtered_fields_are_written() {
    let key = "a".repeat(64);
    let (id, is_key) = private::auth(&format!("Bearer {key}")).unwrap();
    assert!(is_key);
    assert_ne!(id, key);
    let a = private::auth("Address BC1TEST.worker").unwrap();
    assert_eq!(a, private::auth("Address bc1test.other").unwrap());
    assert!(!a.1);
    assert_ne!(private::auth(&format!("Address {key}")).unwrap().0, id);
    assert!(private::auth("Bearer no").is_none());
    assert!(private::auth("Address ../path").is_none());
    let report = private::parse(&remote()).unwrap();
    assert!(report.get("address").is_none());
    for k in ["hashrate", "temp_c", "uptime_s", "pool_connected"] {
        let mut bad = remote();
        bad[k] = json!("bad");
        assert!(private::parse(&bad).is_none());
    }
}
#[test]
fn private_history_uses_every_reading_before_downsampling_and_preserves_revocation() {
    let db = Db::memory().unwrap();
    private::init(&db).unwrap();
    let mut r = private::parse(&remote()).unwrap();
    for (i, rate) in [0, 100, 400].into_iter().enumerate() {
        r["hashrate"] = json!(rate);
        r["boot_id"] = json!(if i == 2 { "second" } else { "first" });
        assert_eq!(
            db.transaction(|| private::add(&db, &r, NOW + i as i64 * 60000))
                .unwrap(),
            204
        );
    }
    assert_eq!(private::add(&db, &r, NOW + 120001).unwrap(), 429);
    let result = private::history(&db, "0000000000000001", 1, NOW + 180000)
        .unwrap()
        .unwrap();
    assert_eq!(result["summary"]["reports"], 3);
    assert_eq!(result["summary"]["average"], 500.0 / 3.0);
    assert_eq!(result["summary"]["minimum"], 0.0);
    assert_eq!(result["summary"]["maximum"], 400.0);
    assert_eq!(result["summary"]["restarts"], 1);
    assert_eq!(result["points"][0]["mixed_boots"], true);
    assert!(result["summary"]["variation_percent"].as_f64().unwrap() > 0.0);
    assert_eq!(
        private::snapshot(&db, NOW + 1000000).unwrap()["hashrate"],
        0.0
    );
    db.transaction(|| private::revoke(&db)).unwrap();
    assert!(private::revoked(&db).unwrap());
    assert_eq!(private::add(&db, &r, NOW + HOUR).unwrap(), 410);
    assert!(private::snapshot(&db, NOW + HOUR).unwrap()["miners"]
        .as_array()
        .unwrap()
        .is_empty());
}
fn call(
    app: &mut App,
    path: &str,
    method: &str,
    headers: &HeaderMap,
    body: Value,
) -> bdlminer_stats::http::Reply {
    app.route(method, path, "", headers, body.to_string().as_bytes(), NOW)
        .unwrap()
}
#[test]
fn http_auth_cors_capacity_and_address_erasure_match_existing_clients() {
    let temp = tempfile::tempdir().unwrap();
    let mut config = Config::new(temp.path().into());
    config.spaces = 1;
    let mut app = App::new(config).unwrap();
    let mut h = HeaderMap::new();
    h.insert("Origin", "https://miner.bdl-pool.com".parse().unwrap());
    let r = call(&mut app, "/api/remote", "GET", &h, Value::Null);
    assert_eq!(r.status, 401);
    assert!(r
        .headers
        .iter()
        .any(|(k, v)| k == "Access-Control-Allow-Origin" && v == "https://miner.bdl-pool.com"));
    h.insert("access-control-request-method", "GET".parse().unwrap());
    h.insert(
        "access-control-request-headers",
        "Authorization".parse().unwrap(),
    );
    assert_eq!(
        call(&mut app, "/api/remote", "OPTIONS", &h, Value::Null).status,
        204
    );
    h.insert(
        "authorization",
        format!("Bearer {}", "a".repeat(64)).parse().unwrap(),
    );
    h.insert("content-type", "application/json".parse().unwrap());
    assert_eq!(
        call(&mut app, "/api/remote/report", "POST", &h, remote()).status,
        403
    );
    h.remove("origin");
    assert_eq!(
        call(&mut app, "/api/remote/report", "POST", &h, remote()).status,
        204
    );
    assert_eq!(
        call(&mut app, "/api/remote", "DELETE", &h, Value::Null).status,
        204
    );
    drop(app);
    let mut config = Config::new(temp.path().into());
    config.spaces = 1;
    let mut app = App::new(config).unwrap();
    assert_eq!(
        call(&mut app, "/api/remote", "GET", &h, Value::Null).status,
        410
    );
    h.insert(
        "authorization",
        format!("Bearer {}", "b".repeat(64)).parse().unwrap(),
    );
    assert_eq!(
        call(&mut app, "/api/remote", "GET", &h, Value::Null).status,
        200
    );
    assert_eq!(
        call(&mut app, "/api/remote/report", "POST", &h, remote()).status,
        503
    );
    h.insert("authorization", "Address bc1test.worker".parse().unwrap());
    assert_eq!(
        call(&mut app, "/api/remote", "DELETE", &h, Value::Null).status,
        403
    );
}
#[tokio::test]
async fn actual_router_limits_bodies_and_has_no_request_secrets_in_errors() {
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use tower::ServiceExt;
    let temp = tempfile::tempdir().unwrap();
    let app = bdlminer_stats::http::router(std::sync::Arc::new(std::sync::Mutex::new(
        App::new(Config::new(temp.path().into())).unwrap(),
    )));
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/healthz")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/report?secret=never-echo")
                .body(Body::from("x".repeat(513)))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 413);
    let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("never-echo"));
}
#[test]
fn online_backup_includes_committed_wal_pages_and_only_the_public_database() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let backups = temp.path().join("backups");
    let mut app = App::new(Config::new(data.clone())).unwrap();
    app.store
        .add(&parse_report(&public()).unwrap(), NOW)
        .unwrap();
    app.store.sample(NOW + SAMPLE).unwrap();
    let status = std::process::Command::new(env!("CARGO_BIN_EXE_bdlminer-stats"))
        .arg("backup")
        .env("STATS_DATA", &data)
        .env("STATS_BACKUPS", &backups)
        .status()
        .unwrap();
    assert!(status.success());
    let files = std::fs::read_dir(backups)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(files.len(), 1);
    let backup = Db::open(&files[0]).unwrap();
    assert!(backup
        .one("PRAGMA quick_check", &[])
        .unwrap()
        .to_string()
        .contains("ok"));
    assert_eq!(
        backup
            .one("SELECT COUNT(*) AS n FROM samples", &[])
            .unwrap()["n"],
        2
    );
    assert!(backup
        .one("SELECT value FROM state WHERE key='live'", &[])
        .unwrap()["value"]
        .as_str()
        .unwrap()
        .contains("m5stickc-plus2"));
    assert!(!backup
        .one("SELECT name FROM sqlite_master WHERE name='miners'", &[])
        .unwrap()
        .is_object());
}
