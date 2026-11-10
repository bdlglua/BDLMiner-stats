# Self-hosted statistics

Node.js 24 LTS and SQLite run the same public and private report handlers as
the Worker. There are no npm production dependencies. `127.0.0.1:8787` is
reachable through the **existing** pool API Caddy host and OpenPort HTTPS
relay. Mining, Bitcoin Core, certificates, DNS and relay identities are not
modified. No inbound router port is required.

## Installation on the pool server

Run with the `bdl` account:

```sh
git clone https://github.com/bdlglua/BDLMiner-stats.git /home/bdl/bdlminer-stats
sudo python3 /home/bdl/bdlminer-stats/server/install.py
```

For an existing checkout, use `git -C /home/bdl/bdlminer-stats pull --ff-only`
before running the installer again. The installer requires the existing
`/etc/bdl-pool-openport/public.json` and pool API Caddy fragment. It installs
an isolated, checksum-verified official Node.js 24 runtime for x64/ARM64;
system Node.js is left unchanged. Code is root-owned in `/opt/bdlminer-stats`.
The `bdlminer-stats` service account owns only `/var/lib/bdlminer-stats` and
the public-backup directory. Installation validates Caddy as the Caddy user,
checks both APIs over local verified HTTPS, and restores the previous routes
and app version if activation fails.

Expected addresses with the current relay:

* `https://api.bdl-pool.com:36018/healthz`
* `https://api.bdl-pool.com:36018/api/summary`
* `https://api.bdl-pool.com:36018/report`
* `https://api.bdl-pool.com:36018/api/remote`
* `https://api.bdl-pool.com:36018/api/remote/report`
* `https://api.bdl-pool.com:36018/api/remote/history`

The pool's `/api/v1/*` routes stay on port 8081. The installer adds an import
inside its existing Caddy host; `/etc/caddy/bdlminer-routes/stats.caddy`
contains only the additional paths. Pool reinstallation/domain helpers must
preserve `import /etc/caddy/bdlminer-routes/*.caddy` inside that host.

## Cutover and historical data

**Installation prepares the new endpoint; it does not change the live website,
Worker configuration, firmware or current firmware releases.** Verify the
public health endpoint before switching clients.

On first installation, a bounded public summary is downloaded from the old
Worker when available. Its real five-minute measurements over 24 hours, older
hourly chart points over seven days, and best-hour record are preserved. An
hourly mean cannot reconstruct old five-minute extrema, variation, board
inventory or coverage: these are computed only from actual five-minute
samples. Coverage can therefore be lower than 100% during the first week.
Live miners are never fabricated from historical samples. A successful import
is not repeated on reinstall. If Cloudflare refuses the snapshot, installation
continues without an import and reports that fact.

Private history is not in the public export. Existing private keys and payout
addresses work on the new service, but its private readings start when miners
send to it. The old service/data is not deleted. A separate authenticated data
migration would be needed to copy old private history.

Change the website's summary URL, both private-viewer API origins and the
firmware's anonymous/private report endpoints only after the native service is
reachable. Older installed firmware embeds the old Worker URL and needs an
update to remove that dependency. A temporary Worker proxy could bridge old
devices, but would still consume Worker request quota. A site-only change does
not move those report senders.

## Operations and limits

```sh
sudo systemctl status bdlminer-stats --no-pager
sudo journalctl -u bdlminer-stats -n 25 --no-pager
sudo systemctl list-timers bdlminer-stats-backup.timer
```

There is no hosting subscription or Cloudflare allowance for native requests.
Capacity depends on CPU, disk, connectivity and OpenPort's own availability and
terms. Default local admission limits are 1,200 requests/minute and 300 report
requests/minute, protecting this shared server. They are adjustable, not a
billing allowance. Private spaces are capped at 2,048, each with the existing
32-miner limit; at most 32 SQLite connections stay open. Valid unknown reads
do not allocate a database. A revoked key keeps a small permanent tombstone.

Set overrides in a root-owned `/etc/bdlminer-stats.conf`, then restart only
`bdlminer-stats.service`. Supported variables: `STATS_REQUESTS_PER_MINUTE`,
`STATS_REPORTS_PER_MINUTE`, `STATS_MAX_SPACES`, `REMOTE_VIEWER_ORIGIN`
(space-separated exact origins). Changing the storage/origin variables needs
matching backup/Caddy configuration and should not be done casually.

A plain TCP relay loses original client addresses. The collector ignores
spoofable forwarding headers and uses server-wide admission limits; it does
not guess that all devices behind the relay are one updating miner. This
preserves anonymous reports across mixed firmware versions. IPs, access
values, URLs and report bodies are not written to request logs.

Public samples keep the existing 35-day retention. Private readings retain
seven days and are swept hourly even when never read again. Private databases
have mode 0600 inside a mode-0700 service state directory. Daily **public-only**
online SQLite backups retain seven days in
`/var/backups/bdlminer-stats/public`; private telemetry is not duplicated into
longer-lived backups. These backups are on the same disk; off-server backup
is a separate operational choice. Deleting/revoking a key persists across
service restarts and database-cache eviction.

## Development

```sh
npm test
python3 -m unittest discover -s server -p 'test_*.py'
npm run test:selfhost:browser
```

The browser suite uses the real local native collector and SQLite, including
CORS, charts, wallet access, revocation and logout races. The original Worker
browser suite remains available with `npm run test:browser`.
