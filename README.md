# BDLMiner stats

The total hashrate of the [BDLMiner](https://github.com/bdlglua/BDLMinerV1) miners
that share it, and a public page to follow it:
**<https://bdlminer-stats.bdlminer-bot.workers.dev/>**

Miners with the *Share my hashrate anonymously* setting (on by default since
BDLMiner 1.9.0) post a report every 5 minutes (1.9.0 and 1.9.1: once an hour, without
`every`):

```json
{"v": "1.9.2", "board": "m5stickc-plus2", "hashrate": 1.02e6, "every": 300}
```

That is all they send: no Bitcoin address, worker, pool, name or identifier. This
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

## Endpoints

| Path | Access | What |
|---|---|---|
| `POST /report` | Miners | One report; 204 when stored, 400 when malformed, 429 over the limit |
| `GET /` | Everyone | The statistics page: total hashrate, miners, average, best hour, 24-hour chart, by board and version |
| `GET /api/summary` | Everyone | The same as JSON, with `recent` (5-minute samples over 24 hours, then now), `history` (hourly, 7 days) and `fleet` (online / offline per board); cached 15 s, readable from any site |

The figures hold nothing about any one miner. To make them private, set a
`STATS_PASSWORD` secret: the page and the JSON then ask for it (HTTP Basic, any user
name).

The figures are indicative: only the miners that share their hashrate are counted,
and the reports cannot be authenticated (the firmware is open source).

## Setup

1. **Cloudflare**: the same free account as any other Worker; note the *Account ID* and
   create an API token from the *Edit Cloudflare Workers* template.
2. **GitHub** (Settings → Secrets and variables → Actions → secrets):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (and `STATS_PASSWORD` only for a
   private page).
3. Run the **Test and deploy** workflow, or push to `main`. The Worker answers at
   `https://bdlminer-stats.<your-subdomain>.workers.dev/`, the address built into the
   firmware (`STATS_URL` in BDLMinerV1's `src/share.h`).

## Development

```sh
npm test    # Node 22+: the store runs on node:sqlite, the Worker on faked bindings
```

## License

[GNU GPL v3.0](LICENSE), like BDLMiner V1.
