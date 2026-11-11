use futures_util::StreamExt;
use serde_json::json;
use worker::*;
const DEFAULT_VIEWERS: &str = "https://miner.bdl-pool.com https://bdlglua.github.io";
fn private(response: &mut Response) -> Result<()> {
    for (k, v) in [
        ("Cache-Control", "no-store"),
        ("X-Content-Type-Options", "nosniff"),
        ("X-Robots-Tag", "noindex, nofollow"),
        ("Referrer-Policy", "no-referrer"),
    ] {
        response.headers_mut().set(k, v)?;
    }
    Ok(())
}
fn error(status: u16, message: &str) -> Result<Response> {
    let mut response = Response::from_json(&json!({"error":message}))?.with_status(status);
    private(&mut response)?;
    Ok(response)
}
fn origin(value: &str) -> Option<url::Url> {
    let url = url::Url::parse(value).ok()?;
    if url.origin().ascii_serialization() != value
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
    {
        None
    } else {
        Some(url)
    }
}
#[event(fetch)]
async fn main(mut request: Request, env: Env, _ctx: Context) -> Result<Response> {
    let source = request.url()?;
    let path = source.path();
    let viewers = env
        .var("REMOTE_VIEWER_ORIGIN")
        .map(|v| v.to_string())
        .unwrap_or_else(|_| DEFAULT_VIEWERS.into());
    let viewers: Vec<_> = viewers.split_whitespace().collect();
    let viewer = viewers
        .first()
        .copied()
        .unwrap_or("https://miner.bdl-pool.com");
    let incoming_origin = request.headers().get("Origin")?;
    let private_route = path.starts_with("/api/remote");
    let cors = if private_route {
        if incoming_origin
            .as_deref()
            .map(|o| o != source.origin().ascii_serialization() && !viewers.contains(&o))
            .unwrap_or(false)
        {
            return error(403, "Origin not allowed");
        }
        if incoming_origin.is_some() && path == "/api/remote/report" {
            return error(403, "Browser reports are not allowed");
        }
        incoming_origin.clone()
    } else {
        None
    };
    if private_route && request.method() == Method::Options {
        let methods = match path {
            "/api/remote" => "GET, DELETE",
            "/api/remote/history" => "GET",
            _ => "",
        };
        let method = request
            .headers()
            .get("Access-Control-Request-Method")?
            .unwrap_or_default();
        let headers = request
            .headers()
            .get("Access-Control-Request-Headers")?
            .unwrap_or_default();
        if cors.is_none()
            || method.is_empty()
            || !methods.split(", ").any(|m| m == method)
            || headers
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .any(|s| {
                    !["authorization", "content-type"].contains(&s.to_ascii_lowercase().as_str())
                })
        {
            return error(403, "Preflight not allowed");
        }
        let mut r = Response::empty()?.with_status(204);
        private(&mut r)?;
        for (k, v) in [
            ("Access-Control-Allow-Origin", cors.as_deref().unwrap()),
            ("Vary", "Origin"),
            ("Access-Control-Allow-Methods", methods),
            (
                "Access-Control-Allow-Headers",
                "Authorization, Content-Type",
            ),
            ("Access-Control-Max-Age", "600"),
        ] {
            r.headers_mut().set(k, v)?;
        }
        return Ok(r);
    }
    if ["/", "/remote", "/remote/"].contains(&path) {
        if request.method() != Method::Get {
            return Response::error("GET only", 405);
        }
        let mut r = Response::empty()?.with_status(302);
        private(&mut r)?;
        r.headers_mut().set(
            "Location",
            &format!(
                "{viewer}{}",
                if path == "/" {
                    "/stats.html"
                } else {
                    "/remote/"
                }
            ),
        )?;
        return Ok(r);
    }
    if ![
        "/report",
        "/api/summary",
        "/api/remote",
        "/api/remote/report",
        "/api/remote/history",
        "/healthz",
        "/remote.js",
        "/remote.css",
    ]
    .contains(&path)
    {
        return Response::error("Not found", 404);
    }
    let destination = env
        .var("SELF_HOSTED_ORIGIN")
        .map(|s| s.to_string())
        .unwrap_or_default();
    let Some(mut target) = origin(&destination).filter(|u| u.origin() != source.origin()) else {
        return error(503, "Collector unavailable");
    };
    target.set_path(path);
    target.set_query(source.query());
    let headers = Headers::new();
    for name in [
        "Authorization",
        "Content-Type",
        "Origin",
        "Accept",
        "Access-Control-Request-Method",
        "Access-Control-Request-Headers",
    ] {
        if let Some(value) = request.headers().get(name)? {
            headers.set(
                name,
                if name == "Origin" && value == source.origin().ascii_serialization() {
                    &destination
                } else {
                    &value
                },
            )?;
        }
    }
    let mut init = RequestInit::new();
    init.with_method(request.method())
        .with_headers(headers)
        .with_redirect(RequestRedirect::Manual);
    if ![Method::Get, Method::Head].contains(&request.method()) {
        let maximum = if path == "/report" { 512 } else { 2048 };
        let mut stream = request.stream()?;
        let mut bytes = Vec::new();
        while let Some(part) = stream.next().await {
            let part = part?;
            if bytes.len() + part.len() > maximum {
                return error(413, "Invalid request");
            }
            bytes.extend_from_slice(&part);
        }
        init.with_body(Some(js_sys::Uint8Array::from(bytes.as_slice()).into()));
    }
    let upstream = Request::new_with_init(target.as_str(), &init)?;
    let signal = AbortSignal::from(web_sys::AbortSignal::timeout_with_u32(15000));
    let result = Fetch::Request(upstream)
        .send_with_signal(&signal)
        .await
        .ok()
        .filter(|r| !(300..400).contains(&r.status_code()));
    let mut response = if let Some(response) = result {
        response
    } else {
        let mut r = error(503, "Collector temporarily unavailable")?;
        r.headers_mut().set("Retry-After", "15")?;
        if path == "/api/summary" {
            r.headers_mut().set("Access-Control-Allow-Origin", "*")?;
        }
        r
    };
    let headers = response.headers().clone();
    response = response.with_headers(headers);
    if let Some(cors) = cors {
        response
            .headers_mut()
            .set("Access-Control-Allow-Origin", &cors)?;
        response.headers_mut().set("Vary", "Origin")?;
    }
    Ok(response)
}
// Preserve the existing Durable Object classes and namespaces. The compatibility
// route forwards to the native collector and never opens or alters their data.
#[durable_object]
pub struct StatsStore {
    _state: State,
}
impl DurableObject for StatsStore {
    fn new(state: State, _env: Env) -> Self {
        Self { _state: state }
    }
    async fn fetch(&self, _request: Request) -> Result<Response> {
        error(503, "Native collector required")
    }
    async fn alarm(&self) -> Result<Response> {
        Response::empty()
    }
}
#[durable_object]
pub struct RemoteStore {
    _state: State,
}
impl DurableObject for RemoteStore {
    fn new(state: State, _env: Env) -> Self {
        Self { _state: state }
    }
    async fn alarm(&self) -> Result<Response> {
        Response::empty()
    }
    async fn fetch(&self, _request: Request) -> Result<Response> {
        error(503, "Native collector required")
    }
}
