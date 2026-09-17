# Loom outline — Citation Audit technical demo (≈8 min)

**0:00 Problem framing (30s)** — Inconsistent NAP across directories hurts local rankings; today it's checked by hand. This tool automates discovery + verification and leaves humans only the judgment calls.

**0:30 Data storage (2 min)** — open `schema.sql` and `docs/ARCHITECTURE.md` §1.
- `clients` → `canonical_facts` (source of truth per field, with provenance and sticky manual overrides).
- `citations` = the persistent inventory (UNIQUE per client+URL, status lifecycle, last result).
- `audit_runs` → `snapshots` (raw evidence) → `findings` (per field) → `qa_decisions` (human overlay).
- Portable SQL: SQLite for the demo, same DDL on Supabase next.

**2:30 Pipeline live (3 min)** — in the web UI:
1. Client page: source of truth table (GBP + website + manual). Show one manual override.
2. Click *Discover* → watch the log: 18 queries, URL classification, "N new". Show `discovery_log`.
3. Click *Run audit* → log shows each profile: fetch method (direct / reader / archive / snippet), CONFLICT (fields) / consistent / UNVERIFIED (why).
4. Open a run → QA queue: confirm one, dismiss one. Open *Evidence*: page text + extracted JSON.
5. *Generate report* → Google Sheet with the 3 tabs. Point out that findings still in QA are absent from Client Action.

**5:30 Re-check logic (1.5 min)** — run the audit a second time: "Inventory has N known profiles — re-auditing stored URLs (no web discovery)". Show `--rediscover` flag and status = ignored/not_client exclusion. Show two runs side by side (history retained).

**7:00 Free tier vs production (1 min)** — table in README: DDG/Jina/Wayback/snippet today; SerpAPI + ScraperAPI + Supabase later. Everything is provider-pluggable (`DISCOVERY_PROVIDER`, `FETCH_PROXY`). Render free hosting + GitHub DB sync.

**8:00 Next steps** — Phase 2 fields (categories, email) already extracted and stored, comparison switches on when canonical values exist; scheduled monthly re-audits; Supabase migration.
