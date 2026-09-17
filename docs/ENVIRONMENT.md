# Environment variables

Everything except the Claude key is optional. When a key is absent the tool says so and
carries on with a documented fallback; nothing blocks.

## Required

| Variable | What it does | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Reads listing pages and the client website. | Nothing can be audited. This is the only hard requirement. |

## Strongly recommended

| Variable | What it does | Without it |
|---|---|---|
| `APP_PASSWORD` | Basic auth on the public URL. | The site is open to anyone with the link, running audits on your key. |
| `GOOGLE_CSE_KEY` + `GOOGLE_CSE_CX` | Finds directory profiles. Free, 100 queries a day, ~9 per client. | Falls back to DuckDuckGo, which blocks automated queries in practice. Discovery returns nothing and you paste profile URLs by hand. |
| `GH_DB_TOKEN` + `GH_DB_REPO` | Keeps the database across restarts. | Everything is erased when the host restarts, redeploys, or sleeps. |

## Optional

| Variable | What it does | Without it |
|---|---|---|
| `GOOGLE_PLACES_API_KEY` | Pulls facts from Google Business Profile. Needs Google Cloud billing. | "Refresh canonical facts" reads the client website instead and fills in name, address, phone, hours, year founded and services. Verified to work. |
| `FETCH_PROXY` + `FETCH_PROXY_KEY` | Reads directories that block plain requests. `scraperapi` or `scrapingbee`. | Yelp, YellowPages, BBB, Angi and Manta fall back to an archived copy or the search snippet, both routed to QA. Anything unreadable becomes "Unable to Verify". |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Writes the report to a Google Sheet. | Reports are written as three CSV files instead. |

## Tuning (all have working defaults)

| Variable | Default | Notes |
|---|---|---|
| `CLAUDE_MODEL` | `claude-haiku-4-5` | About $0.003 a profile. Sonnet is ~2x, Opus ~5x. |
| `DAILY_CLAUDE_CALLS` | `80` | Hard stop. Remaining profiles are marked Unable to Verify. |
| `DAILY_COST_LIMIT_USD` | `1.00` | Hard stop. Resets at midnight UTC. |
| `MAX_PAGE_CHARS` | `20000` | Page text sent to the model, roughly 5,000 tokens. |
| `DISCOVERY_PROVIDER` | `google-cse,ddg` | Comma-separated failover chain. |
| `DISCOVERY_SITE_QUERIES` | `6` | `site:` queries per client. Lower uses less search quota. |
| `FETCH_CONCURRENCY` | `4` | Profiles fetched at once. |
| `QA_CONFIDENCE_THRESHOLD` | `0.8` | Below this a finding goes to the QA queue instead of the client report. |
| `WAYBACK_FALLBACK` | `1` | Set `0` to skip the archive fallback. |
| `DB_PATH` | `data/citation-audit.sqlite` | On Render this is `/tmp/citation-audit.sqlite`. |

## Checking what is active

Open `/setup` and press **Run the check**. It tests every key for real, including one
Claude call, and tells you what each missing one costs you. The header on every page
shows the model, search provider, report format and whether the database persists.
