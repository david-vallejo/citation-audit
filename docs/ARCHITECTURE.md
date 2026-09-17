# Architecture

## 1. Data model (schema.sql)

```
clients ──< canonical_facts        one row per audited field (name, address, phone, website, hours, year_founded, services [, categories, email])
   │                                value_json + source (gbp | website | manual) + source_url + captured_at
   │
   ├──< citations                  THE PERSISTENT INVENTORY. One row per (client, normalized profile URL).
   │       directory, discovered_via, discovered_at, status (active|ignored|not_client|dead),
   │       last_audited_at, last_result, search_snippet
   │
   ├──< discovery_log              every search query ever run, with result/new counts (proves we don't re-discover)
   │
   └──< audit_runs ──< snapshots   raw evidence per citation per run: fetch method, HTTP status, extracted JSON, text excerpt
             │
             └──< findings ──< qa_decisions
                  one row per (run, citation, field): expected, found, status, confidence, reason, needs_qa
                  qa_decisions: confirm | dismiss | correct(+corrected_status) — effective status = override if present
```

All ids are UUID `VARCHAR(36)`, timestamps ISO-8601 `VARCHAR(32)`, structured values JSON `TEXT`. Column types were chosen to be valid on both SQLite and MySQL, so the same DDL creates the production MySQL schema; `src/db.js` is the only file that talks to the driver, and the queries already use `?` placeholders as `mysql2` expects. `llm_usage` records every Claude call for the daily caps.

## 2. Pipeline

```
 ┌───────────────┐   ┌────────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌─────────────┐
 │ 1 Canonical   │ → │ 2 Discovery    │ → │ 3 Fetch      │ → │ 4 Extract    │ → │ 5 Compare +  │ → │ 6 QA queue  │ → Sheet
 │ GBP + website │   │ (only if empty │   │ direct→proxy │   │ Claude, strict│   │ classify     │   │ (humans)    │
 │ + manual      │   │  or requested) │   │ →reader→arch │   │ JSON schema  │   │ deterministic│   │             │
 └───────────────┘   └────────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └─────────────┘
```

**1. Canonical facts.** Places API (New) `places/{id}` with a field mask gives name, address components, phone, website, opening periods, categories. The website is fetched (home + about/services) and passed through the same Claude extractor with an "own site" prompt to get year founded, services, email; JSON-LD `LocalBusiness` is merged first. GBP wins for NAP/hours; website wins for year/services; `manual` overrides win over both and are never overwritten by a refresh.

**2. Discovery.** Query set = `"Name" City ST`, `"Name" fence`, two phone formats, and `"Name" City site:<directory>` for the 14 highest-value directories. Each result URL is classified by `discovery/directories.js`: known-directory **profile** pattern → keep; known directory but a search/category page → drop; client's own site → drop; unknown host → keep only if the title/snippet contains the phone or ≥2 name tokens. New URLs are normalized (host lowercased, `www.` stripped, tracking params removed) and inserted with `UNIQUE(client_id, url)`, so re-running discovery only ever appends.

**3. Fetch.** `fetch/page.js` tries in order: plain fetch with a browser UA → scraping proxy (if `FETCH_PROXY` set) → Jina Reader → Wayback Machine. A bot wall is detected by status (403/429/503) or body heuristics. Archive copies mark findings "[from archived copy YYYY-MM-DD]" and cap confidence at 0.7; when nothing can be fetched, the stored search snippet is used as evidence with a 0.6 cap. Both caps push the findings into QA.

**4. Extract.** One Claude call per profile: system prompt with extraction rules (cached), the page's title/meta/JSON-LD/text, and the target business identity. Output is constrained by `output_config.format` to a JSON schema (`extract/claude.js` → `LISTING_SCHEMA`) with `is_profile_page`, NAP, per-day hours strings verbatim, year, services, categories, email, and a `confidence`. The model is told never to infer; nulls are expected.

**5. Compare + classify.** No LLM judgment here — everything is deterministic in `compare/`:
- phone → 10 digits; address → street-suffix/directional abbreviations, suite split, state code, ZIP5; website → registrable host; hours → per-day `[{open,close}]|closed` grid; name → exact / suffix-insensitive / token similarity; services → stop-word-stripped token match ("extra" services listed = conflict).
- Each field yields `{status, confidence, reason}`. `needs_qa = 1` when confidence < `QA_CONFIDENCE_THRESHOLD` (0.8) — e.g. suite omitted, name variant, single-day hours difference, low extraction confidence, evidence from archive/snippet, or a name mismatch so large the profile may be a different business (then *all* fields go to QA).
- Citation-level result: any conflict → Conflict; all fields unverifiable → Unable to Verify; else Consistent.

**6. QA + report.** `qa_decisions` overlay findings (`effectiveFindings()`); the Client Action tab includes only conflicts that are high-confidence or QA-confirmed; the Inventory tab summarizes each profile; the Internal QA tab has every finding with confidence, raw vs effective status, fetch method, extraction confidence, errors and evidence links.

## 3. Inventory re-check logic

```
runAudit(client):
  canonical = canonical_facts(client)             # must have name + phone
  if --rediscover OR count(citations where active) == 0:
      discover()                                  # appends new URLs only (UNIQUE constraint), logs each query
  citations = SELECT * FROM citations WHERE client_id=? AND status='active'
  run = INSERT audit_runs(mode = recheck | rediscover | initial-discovery)
  for each citation (N in parallel):
      snapshot = fetch + extract                  # raw evidence kept per run
      findings = classify(canonical, extracted)   # one row per field
      UPDATE citations SET last_audited_at, last_result
  UPDATE audit_runs totals
```

- Monthly re-audits therefore cost 0 search queries and touch only the stored URLs.
- A profile marked `ignored` / `not_client` / `dead` in the UI is skipped on every later run but stays in the table (auditable history).
- History is never rewritten: every run has its own snapshots and findings, so you can diff "what Yelp said in August vs September".
- Moving to MySQL: `src/db.js` swaps `node:sqlite` for `mysql2` (same `?` placeholders); `get/all/run/insert/update` become async, which is the only ripple.

## 4. Confidence scoring

| Signal | Effect |
|---|---|
| Exact normalized match | 0.95–0.99 consistent |
| Match after suffix/abbreviation normalization | 0.75–0.85 → QA if below threshold |
| Street/phone/domain/state differs | 0.95 conflict (client tab directly) |
| Suite omitted/extra, city differs, single-day hours drift, year ±1, extra services | 0.6–0.75 conflict → QA |
| Model extraction confidence | caps every finding's confidence |
| Evidence from archive / search snippet | caps at 0.7 / 0.6 → QA |
| Name barely matches | all fields → QA (identity in doubt) |
