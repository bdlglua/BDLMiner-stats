# BDLMiner stats

The total hashrate of the [BDLMiner](https://github.com/bdlglua/BDLMinerV1) miners
that share it, and a private page to follow it.

Miners with the *Share my hashrate anonymously* setting (on by default since
BDLMiner 1.9.0) post a report once an hour:

```json
{"v": "1.9.0", "board": "m5stickc-plus2", "hashrate": 1.02e6}
```

That is all they send: no Bitcoin address, worker, pool, name or identifier. This
[Cloudflare Worker](https://developers.cloudflare.com/workers/) (free plan) keeps the
reports for 35 days in the SQLite storage of a Durable Object and adds them up: the
reports of the last hour give the total hashrate and the number of miners, those of
each past hour the 7-day history. The sender's network address only limits the number
of reports (30 an hour per address); it is never stored.

## Endpoints

| Path | Access | What |
|---|---|---|
| `POST /report` | Miners | One report; 204 when stored, 400 when malformed, 429 over the limit |
| `GET /` | Password | The statistics page: total hashrate, miners, average, best hour, 7-day chart, by board and version |
| `GET /api/summary` | Password | The same as JSON |

The page uses HTTP Basic authentication with the `STATS_PASSWORD` secret (any user
name); without it, the page stays closed.

The figures are indicative: only the miners that share their hashrate are counted,
and the reports cannot be authenticated (the firmware is open source).

## Setup

1. **Cloudflare**: the same free account as any other Worker; note the *Account ID* and
   create an API token from the *Edit Cloudflare Workers* template.
2. **GitHub** (Settings → Secrets and variables → Actions → secrets):
   `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `STATS_PASSWORD`, the password
   of the page.
3. Run the **Test and deploy** workflow, or push to `main`. The Worker answers at
   `https://bdlminer-stats.<your-subdomain>.workers.dev/`, the address built into the
   firmware (`STATS_URL` in BDLMinerV1's `src/share.h`).

## Development

```sh
npm test    # Node 22+: the store runs on node:sqlite, the Worker on faked bindings
```

## License

[GNU GPL v3.0](LICENSE), like BDLMiner V1.
