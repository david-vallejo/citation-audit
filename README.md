# Citation Audit

Discovers a client's web citations (Yelp, YellowPages, BBB, Angi, Facebook, …), checks Name / Address / Phone plus website, hours, year founded and services against a **source of truth** (Google Business Profile + the client's website), classifies every field as **Consistent / Conflict / Unable to Verify**, routes low-confidence findings to a **human QA queue**, and writes a **3-tab Google Sheet** (Client Action · Citation Inventory · Internal QA).

The inventory of known profile URLs is **persistent per client**: discovery runs once (or on demand); every later audit simply re-checks the stored URLs.

## Requirements

- Node 24+ (uses the built-in `node:sqlite`)
- An Anthropic API key (extraction)
- Optional: Google Places API key (GBP facts), Google service-account JSON (Sheets output), a search API key, a scraping-proxy key

## Setup

```
npm install
cp .env.example .env     # fill in ANTHROPIC_API_KEY at minimum
npm start                # web UI → http://localhost:8322
```

## Web UI workflow (what the demo shows)

1. **Add client** – slug, name, website, and a GBP lookup ("Anvil Fence Garden City ID") or Place ID.
2. **Refresh canonical facts** – pulls GBP (Places API) + scrapes the website (JSON-LD, about/services pages → Claude) into the *Source of truth* table. Any field can be overridden by hand; manual values are sticky.
3. **Discover profiles** – runs ~18 branded/phone/`site:` queries through the configured search provider, keeps only real profile URLs on known directories (or unknown hosts that mention the name/phone), and appends them to the inventory. Never re-runs unless asked.
4. **Run audit** – for every active inventory URL: fetch → extract listing facts with Claude (strict JSON schema) → deterministic normalize + compare → classify. One finding per field per profile. Low-confidence findings get `needs_qa`.
5. **QA queue** – confirm / dismiss / correct each flagged finding. Evidence page shows the fetched text and the extracted JSON.
6. **Generate report** – 3-tab Google Sheet, or CSV files when no service account is configured. Those are stored in the database, not just on disk, so they survive a restart and are downloaded from the run page. Findings still in QA are held out of the Client Action tab.

The CLI mirrors every step: `node src/cli.js` prints the commands. `node src/cli.js run <slug>` does the whole pipeline.

## Cost controls

- Default model is `claude-haiku-4-5` (about $0.01 per profile; a 20-profile audit ≈ $0.25). `claude-sonnet-5` is ~2x, `claude-opus-5` ~5x — set `CLAUDE_MODEL`.
- Hard daily caps: `DAILY_CLAUDE_CALLS` (default 80) and `DAILY_COST_LIMIT_USD` (default $1.00). When hit, remaining profiles are marked *Unable to Verify* with a "Skipped: daily cap" reason and the run finishes; every call is logged in `llm_usage` and today's spend shows in the page header.
- Page text sent to the model is capped at `MAX_PAGE_CHARS` (20k chars ≈ 5k tokens); the system prompt is cached.
- Also set a monthly spend limit in the Anthropic console (Settings → Limits) as the outer guard.
- The key must be an API key from console.anthropic.com. A Claude.ai / Claude Code subscription login cannot be used by the app.

## Free-tier configuration (demo)

| Concern | Free option used | Paid upgrade later |
|---|---|---|
| Search discovery | `DISCOVERY_PROVIDER=google-cse,ddg` — Google Programmable Search (free 100 queries/day, ~9 queries per client) with keyless DuckDuckGo as failover (DDG rate-limits after a few quick queries; the provider waits and retries once) | `serpapi` |
| Profile fetching | direct → Jina Reader → Wayback Machine → search snippet | `FETCH_PROXY=scraperapi` (1,000 free credits/mo) or `scrapingbee` |
| GBP facts | Google Places API (New) has a monthly free allowance | – |
| Database | SQLite file (`DB_PATH`), optionally synced to a private GitHub repo | MySQL (schema uses MySQL-compatible types; `src/db.js` is the only driver-specific file; `?` placeholders already match `mysql2`). Free MySQL hosts: Aiven free tier, TiDB Cloud serverless |
| Sheets | Service account + Sheets/Drive API (free) | – |
| Hosting | Render free web service (Docker) | – |

**Why fetch fallbacks matter:** Yelp, YellowPages, BBB, Angi and Manta return 403 to plain requests and to Jina. Without a scraping proxy those profiles are verified from the Wayback copy (dated, routed to QA) or from the search-result snippet (routed to QA), or land in *Unable to Verify*. Adding a ScraperAPI free key fixes most of them.

## Deploy to Render (free)

1. Push this folder to a GitHub repo (or point Render at the monorepo with root `_tools/citation-audit`).
2. Render → New → Blueprint → select the repo; `render.yaml` defines the service.
3. Set env vars: `ANTHROPIC_API_KEY`, `GOOGLE_PLACES_API_KEY`, `APP_PASSWORD` (basic auth for the public URL), and optionally `GH_DB_TOKEN` + `GH_DB_REPO` so the SQLite file survives restarts (free instances have an ephemeral disk and spin down when idle). For Google Sheets on Render, add the service-account JSON as a **Secret File** and set `GOOGLE_SERVICE_ACCOUNT_JSON` to its path.
4. First request after idle takes ~30s (free-tier cold start).

## Google setup

- **Places API (New) — optional, needs Google Cloud billing:** enable *Places API (New)* → create an API key → `GOOGLE_PLACES_API_KEY`. Skip it if you would rather not attach a card: *Refresh canonical facts* reads the client website with Claude and fills in name, address, phone, hours, year founded and services on its own. Google Business Profile is only a second opinion on those same fields.
- **Programmable Search (discovery):** programmablesearchengine.google.com → create an engine → copy its Search engine ID to `GOOGLE_CSE_CX`; enable *Custom Search API* in the same Cloud project and use the API key as `GOOGLE_CSE_KEY`.
  Google **deprecated "Search the entire web"** and it can no longer be enabled on new engines, so the engine must be restricted to the citation directories instead. Paste the domains from `docs/cse-domains.txt` into *Search Features → Sites to search* (40 entries, Google's cap is 50). That is not a downgrade for this tool: every result then comes from a real directory, so discovery gets cleaner, not worse. Only directories missing from that list become undiscoverable, and you can add any others you care about.
- **Sheets:** same project → enable *Google Sheets API* and *Google Drive API* → create a service account → download JSON → `GOOGLE_SERVICE_ACCOUNT_JSON=./service-account.json`. Put your Google account in `SHEET_SHARE_WITH` so the generated sheet appears in your Drive.

## Layout

```
schema.sql                 portable DDL (SQLite now, Postgres later)
src/server.js              web UI + job runner (the Render service)
src/cli.js                 CLI mirror
src/audit.js               canonical refresh + audit run orchestration
src/canonical/places.js    Google Places API (New) → canonical facts
src/canonical/website.js   client website → JSON-LD + Claude extraction
src/discovery/             search providers (ddg, google-cse, serpapi) + directory list + inventory
src/fetch/page.js          layered fetching: direct → proxy → reader → archive
src/extract/claude.js      Claude structured-output extraction (strict JSON schema)
src/compare/normalize.js   phone/address/hours/url/name/service normalizers
src/compare/classify.js    per-field comparison → Consistent/Conflict/Unable to Verify + confidence + needs_qa
src/report/sheets.js       3-tab Google Sheet writer (service-account JWT, no googleapis dep) + CSV fallback
src/persist.js             optional SQLite ↔ GitHub sync for ephemeral hosts
docs/ARCHITECTURE.md       data model + pipeline + re-check logic (Loom script source)
docs/LOOM-OUTLINE.md       talk track for the technical demo
test/                      unit tests for the comparison engine (`npm test`)
```
