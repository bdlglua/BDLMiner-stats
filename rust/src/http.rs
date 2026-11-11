use crate::{db::Db, now, private, public::Store, regex, Result};
use axum::{
    body::{to_bytes, Body},
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::Response,
    Router,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
#[derive(Clone)]
pub struct Config {
    pub directory: PathBuf,
    pub origin: String,
    pub viewers: Vec<String>,
    pub requests: usize,
    pub reports: usize,
    pub spaces: usize,
    pub password: Option<String>,
}
impl Config {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            origin: "https://api.bdl-pool.com:36018".into(),
            viewers: vec![
                "https://miner.bdl-pool.com".into(),
                "https://bdlglua.github.io".into(),
            ],
            requests: 1200,
            reports: 300,
            spaces: 2048,
            password: None,
        }
    }
    pub fn validate(&self) -> Result<()> {
        for v in self.viewers.iter().chain(std::iter::once(&self.origin)) {
            let url = url::Url::parse(v)?;
            if url.origin().ascii_serialization() != *v
                || !url.username().is_empty()
                || url.password().is_some()
                || (url.scheme() != "https"
                    && !(url.scheme() == "http"
                        && ["localhost", "127.0.0.1"]
                            .contains(&url.host_str().unwrap_or_default())))
            {
                return Err("Use an HTTPS origin without a path".into());
            }
        }
        if [self.requests, self.reports, self.spaces]
            .iter()
            .any(|v| !(1..=1000000).contains(v))
        {
            return Err("Invalid resource limit".into());
        }
        Ok(())
    }
}
struct Limit {
    minute: i64,
    count: usize,
}
impl Limit {
    fn allow(&mut self, now: i64, max: usize) -> bool {
        if self.minute != now / 60000 {
            self.minute = now / 60000;
            self.count = 0;
        }
        self.count += 1;
        self.count <= max
    }
}
pub struct App {
    pub config: Config,
    pub store: Store,
    spaces: HashSet<String>,
    requests: Limit,
    reports: Limit,
}
fn directory(path: &Path) -> Result<()> {
    if fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink() || !m.is_dir())
        .unwrap_or(false)
    {
        return Err("Invalid storage directory".into());
    }
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}
impl App {
    pub fn new(config: Config) -> Result<Self> {
        config.validate()?;
        directory(&config.directory)?;
        let private = config.directory.join("private");
        directory(&private)?;
        let store = Store::new(Db::open(&config.directory.join("public.sqlite"))?, now())?;
        let snapshot = config.directory.join("legacy-summary.json");
        if store.get("selfhost-imported-at")?.is_none() && snapshot.exists() {
            let raw = fs::read(snapshot)?;
            if raw.len() > 1024 * 1024 {
                return Err("Legacy snapshot is too large".into());
            }
            store.import(&serde_json::from_slice(&raw)?, now())?;
        }
        let spaces = fs::read_dir(private)?
            .filter_map(|e| e.ok())
            .filter_map(|e| e.file_name().to_str().map(str::to_owned))
            .filter(|s| regex(r"^[a-f0-9]{64}\.sqlite$", s))
            .map(|s| s[..64].to_string())
            .collect();
        Ok(Self {
            config,
            store,
            spaces,
            requests: Limit {
                minute: -1,
                count: 0,
            },
            reports: Limit {
                minute: -1,
                count: 0,
            },
        })
    }
    fn space(&mut self, id: &str, create: bool) -> Result<Option<Db>> {
        if !self.spaces.contains(id) {
            if !create {
                return Ok(None);
            }
            if self.spaces.len() >= self.config.spaces {
                return Err("capacity".into());
            }
        }
        let db = Db::open(
            &self
                .config
                .directory
                .join("private")
                .join(format!("{id}.sqlite")),
        )?;
        private::init(&db)?;
        self.spaces.insert(id.into());
        Ok(Some(db))
    }
    pub fn prune(&mut self) -> Result<()> {
        for id in self.spaces.clone() {
            let db = self.space(&id, false)?.unwrap();
            private::prune(&db, now())?;
        }
        Ok(())
    }
    pub fn route(
        &mut self,
        method: &str,
        path: &str,
        query: &str,
        headers: &HeaderMap,
        body: &[u8],
        at: i64,
    ) -> Result<Reply> {
        if path == "/healthz" && ["GET", "HEAD"].contains(&method) {
            let mut r = Reply::json(
                200,
                json!({"status":"ok","service":"bdlminer-stats","storage":"sqlite","runtime":"rust"}),
            );
            if method == "HEAD" {
                r.body.clear();
            }
            return Ok(r);
        }
        if !self.requests.allow(at, self.config.requests)
            || (method == "POST" && !self.reports.allow(at, self.config.reports))
        {
            return Ok(Reply::error(429, "Please wait before trying again"));
        }
        if header(headers, "content-encoding")
            .filter(|v| *v != "identity")
            .is_some()
        {
            return Ok(Reply::error(415, "Invalid request"));
        }
        if path.starts_with("/api/remote") {
            return self.remote(method, path, query, headers, body, at);
        }
        if ["/remote", "/remote/", "/"].contains(&path) {
            if method != "GET" {
                return Ok(Reply::text(405, "GET only"));
            }
            let mut r = Reply::new(302, vec![]);
            r.headers.push((
                "Location".into(),
                format!(
                    "{}{}",
                    self.config.viewers[0],
                    if path == "/" {
                        "/stats.html"
                    } else {
                        "/remote/"
                    }
                ),
            ));
            return Ok(r);
        }
        if path == "/report" {
            if method != "POST" {
                return Ok(Reply::text(405, "POST only"));
            }
            if body.len() > 512 {
                return Ok(Reply::text(413, "Too large"));
            }
            let report = serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| crate::parse_report(&v));
            if let Some(report) = report {
                self.store.add(&report, at)?;
                return Ok(Reply::new(204, vec![]));
            }
            return Ok(Reply::text(400, "Bad report"));
        }
        if path == "/api/summary" {
            if method != "GET" {
                return Ok(Reply::text(405, "GET only"));
            }
            if let Some(password) = &self.config.password {
                let given = header(headers, "authorization")
                    .and_then(|v| v.strip_prefix("Basic "))
                    .and_then(|v| STANDARD.decode(v).ok())
                    .map(|v| String::from_utf8_lossy(&v).to_string());
                let given = given
                    .as_deref()
                    .and_then(|v| v.split_once(':').map(|(_, v)| v))
                    .unwrap_or_default();
                if !same(given, password) {
                    let mut r = Reply::text(401, "Password required");
                    r.headers.push((
                        "WWW-Authenticate".into(),
                        "Basic realm=\"BDLMiner stats\", charset=\"UTF-8\"".into(),
                    ));
                    return Ok(r);
                }
            }
            let mut r = Reply::json(200, self.store.summary(at)?);
            if self.config.password.is_none() {
                r.set("Cache-Control", "public, max-age=15");
                r.set("Access-Control-Allow-Origin", "*");
            }
            return Ok(r);
        }
        Ok(Reply::text(404, "Not found"))
    }
    fn remote(
        &mut self,
        method: &str,
        path: &str,
        query: &str,
        headers: &HeaderMap,
        body: &[u8],
        at: i64,
    ) -> Result<Reply> {
        let origin = header(headers, "origin");
        let allowed = origin
            .map(|v| self.config.viewers.iter().any(|o| o == v) || v == self.config.origin)
            .unwrap_or(true);
        if !allowed {
            return Ok(Reply::private_error(403, "Origin not allowed"));
        }
        if origin.is_some() && path == "/api/remote/report" {
            return Ok(Reply::private_error(403, "Browser reports are not allowed"));
        }
        let methods = match path {
            "/api/remote" => "GET, DELETE",
            "/api/remote/history" => "GET",
            _ => "",
        };
        let mut reply = if method == "OPTIONS" {
            let m = header(headers, "access-control-request-method").unwrap_or_default();
            let h = header(headers, "access-control-request-headers").unwrap_or_default();
            if origin.is_none()
                || !methods.split(", ").any(|v| v == m)
                || m.is_empty()
                || h.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .any(|h| {
                        !["authorization", "content-type"]
                            .contains(&h.to_ascii_lowercase().as_str())
                    })
            {
                Reply::private_error(403, "Preflight not allowed")
            } else {
                let mut r = Reply::private(204, Value::Null);
                r.set("Access-Control-Allow-Methods", methods);
                r.set(
                    "Access-Control-Allow-Headers",
                    "Authorization, Content-Type",
                );
                r.set("Access-Control-Max-Age", "600");
                r
            }
        } else {
            self.private_route(method, path, query, headers, body, at)?
        };
        if let Some(origin) = origin {
            reply.set("Access-Control-Allow-Origin", origin);
            reply.set("Vary", "Origin");
        }
        Ok(reply)
    }
    fn private_route(
        &mut self,
        method: &str,
        path: &str,
        query: &str,
        headers: &HeaderMap,
        body: &[u8],
        at: i64,
    ) -> Result<Reply> {
        let methods = match path {
            "/api/remote" => &["GET", "DELETE"][..],
            "/api/remote/report" => &["POST"][..],
            "/api/remote/history" => &["GET"][..],
            _ => return Ok(Reply::private_error(404, "Not found")),
        };
        if !methods.contains(&method) {
            return Ok(Reply::private_error(405, "Method not allowed"));
        }
        let Some((id, key)) = private::auth(header(headers, "authorization").unwrap_or_default())
        else {
            return Ok(Reply::private_error(
                401,
                "Wallet address or private access key required",
            ));
        };
        if method == "DELETE" && !key {
            return Ok(Reply::private_error(
                403,
                "Only a private access key can erase readings",
            ));
        }
        let report = if method == "POST" {
            if !header(headers, "content-type")
                .unwrap_or_default()
                .starts_with("application/json")
            {
                return Ok(Reply::private_error(415, "Invalid private report"));
            }
            if body.len() > 2048 {
                return Ok(Reply::private_error(413, "Invalid private report"));
            }
            match serde_json::from_slice::<Value>(body)
                .ok()
                .and_then(|v| private::parse(&v))
            {
                Some(v) => Some(v),
                None => return Ok(Reply::private_error(400, "Invalid private report")),
            }
        } else {
            None
        };
        let db = match self.space(&id, method != "GET") {
            Ok(Some(db)) => db,
            Ok(None) => {
                let db = Db::memory()?;
                private::init(&db)?;
                db
            }
            Err(e) if e.to_string() == "capacity" => {
                return Ok(Reply::private_error(503, "Storage capacity reached"))
            }
            Err(e) => return Err(e),
        };
        if method == "POST" {
            let status = db.transaction(|| private::add(&db, &report.unwrap(), at))?;
            return Ok(Reply::private(status, Value::Null));
        }
        if method == "DELETE" {
            db.transaction(|| private::revoke(&db))?;
            return Ok(Reply::private(204, Value::Null));
        }
        if private::revoked(&db)? {
            return Ok(Reply::private_error(
                410,
                "This access key has been revoked",
            ));
        }
        if path.ends_with("/history") {
            let query: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(query.as_bytes())
                    .into_owned()
                    .collect();
            let miner = query.get("miner").map(String::as_str).unwrap_or_default();
            let hours = query
                .get("hours")
                .map(|s| s.parse().unwrap_or(-1))
                .unwrap_or(24);
            return Ok(match private::history(&db, miner, hours, at)? {
                Some(v) => Reply::private(200, v),
                None => Reply::private_error(400, "Invalid history window"),
            });
        }
        Ok(Reply::private(200, private::snapshot(&db, at)?))
    }
}
fn header<'a>(headers: &'a HeaderMap, key: &str) -> Option<&'a str> {
    headers.get(key).and_then(|v| v.to_str().ok())
}
pub fn same(given: &str, key: &str) -> bool {
    let mut diff = given.len() ^ key.len();
    for (i, b) in key.bytes().enumerate() {
        diff |= usize::from(b ^ given.as_bytes().get(i).copied().unwrap_or(0));
    }
    diff == 0
}
pub struct Reply {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}
impl Reply {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        let mut r = Self {
            status,
            body,
            headers: vec![],
        };
        r.set("Cache-Control", "no-store");
        r.set("X-Content-Type-Options", "nosniff");
        r.set("X-Frame-Options", "DENY");
        if [429, 503].contains(&status) {
            r.set("Retry-After", "60");
        }
        r
    }
    pub fn set(&mut self, key: &str, value: &str) {
        self.headers.retain(|(k, _)| !k.eq_ignore_ascii_case(key));
        self.headers.push((key.into(), value.into()));
    }
    pub fn json(status: u16, value: Value) -> Self {
        let mut r = Self::new(
            status,
            if value.is_null() {
                vec![]
            } else {
                value.to_string().into_bytes()
            },
        );
        r.set("Content-Type", "application/json");
        r
    }
    pub fn text(status: u16, value: &str) -> Self {
        let mut r = Self::new(status, value.as_bytes().to_vec());
        r.set("Content-Type", "text/plain; charset=utf-8");
        r
    }
    pub fn error(status: u16, message: &str) -> Self {
        Self::json(status, json!({"error":message}))
    }
    fn private(status: u16, value: Value) -> Self {
        let mut r = Self::json(status, value);
        for(k,v)in [("X-Robots-Tag","noindex, nofollow"),("Referrer-Policy","no-referrer"),("Content-Security-Policy","default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")]{r.set(k,v);}
        r
    }
    fn private_error(status: u16, message: &str) -> Self {
        Self::private(status, json!({"error":message}))
    }
    fn response(self) -> Response {
        let mut builder = Response::builder().status(StatusCode::from_u16(self.status).unwrap());
        for (k, v) in self.headers {
            builder = builder.header(k, v);
        }
        builder.body(Body::from(self.body)).unwrap()
    }
}
pub fn router(app: Arc<Mutex<App>>) -> Router {
    Router::new().fallback(handle).with_state(app)
}
async fn handle(State(app): State<Arc<Mutex<App>>>, request: Request) -> Response {
    static PERMITS: std::sync::OnceLock<tokio::sync::Semaphore> = std::sync::OnceLock::new();
    let Ok(_permit) = PERMITS
        .get_or_init(|| tokio::sync::Semaphore::new(32))
        .try_acquire()
    else {
        return Reply::error(503, "Service unavailable").response();
    };
    let (parts, body) = request.into_parts();
    let path = parts.uri.path();
    if parts.uri.to_string().len() > 2048
        || path.starts_with("//")
        || parts
            .headers
            .iter()
            .map(|(k, v)| k.as_str().len() + v.as_bytes().len() + 4)
            .sum::<usize>()
            > 8192
    {
        return Reply::error(400, "Invalid request").response();
    }
    let maximum = if path == "/report" { 512 } else { 2048 };
    if header(&parts.headers, "content-encoding")
        .filter(|v| *v != "identity")
        .is_some()
    {
        return Reply::error(415, "Invalid request").response();
    }
    let body =
        match tokio::time::timeout(std::time::Duration::from_secs(15), to_bytes(body, maximum))
            .await
        {
            Ok(Ok(b)) => b,
            Ok(Err(_)) => return Reply::error(413, "Invalid request").response(),
            Err(_) => return Reply::error(408, "Invalid request").response(),
        };
    let reply = match app.lock() {
        Ok(mut app) => app.route(
            parts.method.as_str(),
            path,
            parts.uri.query().unwrap_or_default(),
            &parts.headers,
            &body,
            now(),
        ),
        Err(_) => Err("unavailable".into()),
    };
    match reply {
        Ok(r) => r.response(),
        Err(_) => Reply::error(500, "Service unavailable").response(),
    }
}
