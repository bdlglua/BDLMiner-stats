use bdlminer_stats::{
    http::{router, App, Config},
    now, Result,
};
use std::{
    env, fs,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
fn variable(name: &str, default: &str) -> String {
    env::var(name).unwrap_or_else(|_| default.into())
}
#[tokio::main(worker_threads = 2)]
async fn main() -> Result<()> {
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }
    let directory = PathBuf::from(variable("STATS_DATA", "/var/lib/bdlminer-stats"));
    if env::args().nth(1).as_deref() == Some("backup") {
        return backup(directory);
    }
    let mut config = Config::new(directory);
    config.origin = variable("STATS_PUBLIC_ORIGIN", &config.origin);
    config.viewers = variable("REMOTE_VIEWER_ORIGIN", &config.viewers.join(" "))
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    config.requests = variable("STATS_REQUESTS_PER_MINUTE", "1200").parse()?;
    config.reports = variable("STATS_REPORTS_PER_MINUTE", "300").parse()?;
    config.spaces = variable("STATS_MAX_SPACES", "2048").parse()?;
    config.password = env::var("STATS_PASSWORD").ok().filter(|s| !s.is_empty());
    let app = Arc::new(Mutex::new(App::new(config)?));
    let timers = app.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        let mut prune = now();
        loop {
            interval.tick().await;
            if let Ok(mut app) = timers.lock() {
                let _ = app.store.sample(now());
                if now() - prune >= 3600000 {
                    let _ = app.prune();
                    prune = now();
                }
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
    println!("BDLMiner Rust statistics ready on 127.0.0.1:8787");
    axum::serve(listener, router(app))
        .with_graceful_shutdown(shutdown())
        .await?;
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut term =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
        tokio::select! {_=term.recv()=>{},_=tokio::signal::ctrl_c()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
fn backup(directory: PathBuf) -> Result<()> {
    let destination = PathBuf::from(variable(
        "STATS_BACKUPS",
        "/var/backups/bdlminer-stats/public",
    ));
    fs::create_dir_all(&destination)?;
    let day = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let temporary = destination.join(format!("public-{day}.tmp"));
    if temporary.exists() {
        fs::remove_file(&temporary)?;
    }
    let db = rusqlite::Connection::open_with_flags(
        directory.join("public.sqlite"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    db.backup(rusqlite::MAIN_DB, &temporary, None)?;
    fs::rename(&temporary, destination.join(format!("public-{day}.sqlite")))?;
    for entry in fs::read_dir(destination)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(date) = name
            .strip_prefix("public-")
            .and_then(|s| s.strip_suffix(".sqlite"))
            .and_then(|s| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok())
        {
            if date < chrono::Utc::now().date_naive() - chrono::Duration::days(7) {
                fs::remove_file(entry.path())?;
            }
        }
    }
    println!("Public statistics backed up.");
    Ok(())
}
