# BDLMiner stats

The total hashrate of the [BDLMiner](https://github.com/bdlglua/BDLMinerV2) miners
that share it, and a public page to follow it:
**<https://bdlminer-stats.bdlminer-bot.workers.dev/>**

Production collection and private monitoring now use
**<https://api.bdl-pool.com:36018>**, backed by local SQLite on the pool server.
The website reads it directly. The old Worker is a compatibility proxy for
already installed firmware; it no longer stores new reports in Durable Objects.
Those devices still consume Worker request allowance until updated. See
[installation and migration details](server/README.md).

Miners with the *Share my hashrate anonymously* setting (on by default since
BDLMiner 1.9.0) post a report every 5 minutes (1.9.0 and 1.9.1: once an hour, without
`every`):

```json
{"v": "1.9.4", "board": "m5stack-esp32", "hashrate": 1.02e6, "every": 300, "model": "M5Stack Core2"}
```

`coin` (from 2.1.0) is an optional fixed ticker, `BTC`, `BCH`, `BSV`, `XEC`, `DGB` or `PPC`. Reports without
it count under BTC. The summary and public page provide a `coins` breakdown.
It describes the configured profile; the actual chain is supplied by the pool.
No address, account or worker is added.

`model` (from 1.9.4) only comes when the board tells more than its firmware: the M5Stack
firmware serves several models, which the summary's `models` list tells apart.

The version may also be a SemVer prerelease such as `2.0.0-beta.1` or `2.0.0-rc.1`,
with optional build metadata. It is kept as reported and bounded to the firmware's
23-character limit. The same board-specific hashrate limits apply to stable and
prerelease reports; accepting a beta does not imply its release or hardware validation.

**Share my pool anonymously** (`sharepool`) can add a `pool` group to the existing
report. Introduced as default-off in 2.0.2, it is on by default from 2.0.3 for new
devices and records without the setting; saved disabled choices are preserved.
Owners can switch it off independently. It requires hashrate sharing and
an active pool connection. A fixed allowlist maps public hosts and their
subdomains to `public-pool.io`, `nerdminers.org`, `nerdminer.io`, `ckpool.org`,
`ocean.xyz`, `braiins.com`, `viabtc.com`, `f2pool.com` or `antpool.com`.
Other hosts, including local/private endpoints, become `other` on the device.
The configured hostname, URL, port, Bitcoin address and worker are never sent.
The collector accepts only these finite groups; raw endpoints are rejected.

The summary's `pools` list uses the same live weighting and grace interval as
the other breakdowns. `unknown` includes older firmware, pool sharing disabled
and a disconnected pool. It is not an inferred pool name. Old reports remain
valid and existing samples need no migration. No per-miner pool list is exposed.
Public pool names link to a predefined official website and show its URL. Links
come from the collector's fixed catalog, never from a report. Private/other and
undisclosed groups have no link.

No Bitcoin address, worker, private hostname, name or identifier is sent. This
[Cloudflare Worker](https://developers.cloudflare.com/workers/) (free plan) adds them up
in the SQLite storage of a Durable Object. Without an identifier, each report stands for
its miner during the interval that follows it, `[t, t + every)`: a miner's reports tile
the timeline without overlapping, so the total over the last 5 minutes is the current
hashrate, and the number of reports covering *now* the miners online. Every 5 minutes
that total becomes a sample (kept 35 days): the 24-hour chart, the hourly history and
the best hour come from them. Per board, the miners gone offline are estimated as the
most that ran together through a full hour over 7 days (the fewest seen during that
hour, so that a miner counted twice for a moment does not add one), minus those online. The sender's network address only
limits the number of reports (400 an hour per address) and, in memory, recognises a
miner that restarts on a new version (same address, same board, another version): its
previous report then ends, so that it is not counted twice. It is never stored.

## Private remote monitoring

The [`/remote/` viewer](https://miner.bdl-pool.com/remote/) (also at
[bdlglua.github.io/remote/](https://bdlglua.github.io/remote/)) lets owners monitor their own paired miners without
a local hub. From BDLMiner 2.3.0, an explicit opt-in sends selected readings every
five minutes using a browser-generated 256-bit key. Personal names and keyed
pseudonymous miner IDs are isolated from the anonymous aggregate above.

Each key maps to a separate `RemoteStore` Durable Object by its SHA-256 digest;
the raw key is not stored. Up to 32 miners share a space, with seven-day history.
The page keeps a key only in memory (an address may be remembered on request), has no third-party resources, and cannot
control miners. Deletion erases readings and permanently revokes the key; only a
minimal revocation marker remains. Request addresses are kept in memory only for
an admission limit of 600 requests/hour/address. The hosting operator can access
stored readings. Details: [pairing, data and revocation](https://github.com/bdlglua/BDLMinerV2/blob/main/docs/remote-access.md).

From BDLMiner 2.5.4 a miner can instead report under its payout address
(`Authorization: Address <address>`, the part before any `.worker`, case-folded).
The owner then opens `/remote/` with that same address: nothing to generate or
copy. Like a pool's address page, anyone who knows the address can read these
readings, and an address space cannot be erased through the API; owners who want
a secret, revocable space keep using a key.

`GET /api/remote`, `GET /api/remote/history?miner=<id>&hours=24` and
`DELETE /api/remote` require `Authorization: Bearer <personal-key>` or
`Authorization: Address <address>` (reads only) even if the public page is open. Paired boards use `POST /api/remote/report`. All private
responses use `no-store`, an exact viewer origin allowlist (`REMOTE_VIEWER_ORIGIN`), bounded inputs and
finite telemetry fields; payouts, workers, raw MACs and private pool hosts are
excluded. These reports never contribute to `/api/summary`.

The viewer includes period statistics, interactive hashrate and temperature area
charts, recent readings and CSV export. The chart fits the available readings
within the selected 1-hour, 6-hour, 24-hour or 7-day window; missing reports and
restarts remain visible as gaps. The history API returns a `summary` calculated
from all received reports before chart downsampling: average/minimum/maximum
hashrate, relative standard deviation, average/maximum temperature, report count,
first/last report times and observed boot-ID changes. These are statistics of
received readings, not inferred mining uptime. No additional firmware reports,
credentials or storage migration are needed; existing seven-day readings work.

The private interface is exported from the same source as the legacy Worker page:
`node scripts/build-remote-site.js <site-directory>/remote` writes three static
files plus their source/digest manifest. The website workflows build and publish
them on GitHub Pages, at https://miner.bdl-pool.com/remote/ (BDLMinerV2) and
https://bdlglua.github.io/remote/ (root site). The interface sends bearer-authenticated requests
to this Worker with cookies omitted. Browser origins outside the configured
viewer origins (space-separated `REMOTE_VIEWER_ORIGIN`) and the service's own origin are refused; preflight does not grant
access without a key. Firmware reports continue using their existing endpoint.
After the GitHub page is published, `REMOTE_VIEWER_REDIRECT=true` sends legacy
`/remote` links to the first viewer origin's `/remote/` without forwarding any query string.

## Endpoints

The public summary also includes `periods` keyed by `1`, `6`, `24` and `168`
hours. Each contains the mean, minimum, maximum and relative standard deviation
of the five-minute aggregate hashrates, mean/peak active-miner counts, available
and expected sample counts, and the first/last measurement times. Period means
exclude the instantaneous live value and do not treat missing samples as zero.
Hourly chart points carry their source sample counts, actual ending timestamps
and a missing-data flag; `current_hour` provides the same information for the
unfinished hour. These additions retain the existing anonymous-only data model.

| Path | Access | What |
|---|---|---|
| `POST /report` | Miners | One report; 204 when stored, 400 when malformed, 429 over the limit |
| `GET /` | Everyone | The statistics page: total hashrate, miners, average, best hour, 24-hour chart, by board, version, cryptocurrency and pool |
| `GET /api/summary` | Everyone | The same as JSON, with `pools` (name, miners, hashrate), `recent` (5-minute samples over 24 hours, then now), `history` (hourly, 7 days) and `fleet` (online / offline per board); cached 15 s, readable from any site |

The figures hold nothing about any one miner. To make them private, set a
`STATS_PASSWORD` secret: the page and the JSON then ask for it (HTTP Basic, any user
name).

The figures are indicative: only the miners that share their hashrate are counted,
and the reports cannot be authenticated (the firmware is open source).

## Setup

For the existing pool server, see [self-hosted installation](server/README.md).
It runs the same collection and private-monitoring contracts with local SQLite,
behind the current Caddy/OpenPort API host. Install and verify it before changing
the website and firmware endpoints; existing devices still use their embedded
Worker address until updated.

1. **Cloudflare**: the same free account as any other Worker; note the *Account ID* and
   create an API token from the *Edit Cloudflare Workers* template.
2. **GitHub** (Settings → Secrets and variables → Actions → secrets):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (and `STATS_PASSWORD` only for a
   private page).
3. Run the **Test and deploy** workflow, or push to `main`. The Worker answers at
   `https://bdlminer-stats.<your-subdomain>.workers.dev/`, the address built into the
   firmware (`STATS_URL` in BDLMinerV2's `src/share.h`).

## Development

```sh
npm test    # Node 22+: the store runs on node:sqlite, the Worker on faked bindings
```

## License

[GNU GPL v3.0](LICENSE), like BDLMiner V2.
