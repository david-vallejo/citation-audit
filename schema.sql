-- Portable SQL: runs on SQLite today, MySQL later with the same DDL
-- (VARCHAR(36) ids = uuid, VARCHAR(32) timestamps = ISO-8601, TEXT *_json = JSON).
-- MySQL note: drop `IF NOT EXISTS` from the CREATE INDEX lines (MySQL 8 does not accept it there).

CREATE TABLE IF NOT EXISTS clients (
  id          VARCHAR(36) PRIMARY KEY,
  slug        VARCHAR(64) NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  website     TEXT,
  place_id    TEXT,
  gbp_url     VARCHAR(700),
  sheet_id    TEXT,
  created_at  VARCHAR(32) NOT NULL,
  updated_at  VARCHAR(32) NOT NULL
);

-- One row per client per audited field. source=manual is sticky and never overwritten by a refresh.
CREATE TABLE IF NOT EXISTS canonical_facts (
  id          VARCHAR(36) PRIMARY KEY,
  client_id   VARCHAR(36) NOT NULL REFERENCES clients(id),
  field       VARCHAR(32) NOT NULL,
  value_json  TEXT NOT NULL,
  source      VARCHAR(16) NOT NULL,
  source_url  TEXT,
  captured_at VARCHAR(32) NOT NULL,
  UNIQUE (client_id, field)
);

-- The client's own Google Business Profile as last read through the Places API, and the
-- facts the client's website states about itself. Kept apart from canonical_facts, which
-- holds only the winning value per field, so the profile and the site can be compared.
CREATE TABLE IF NOT EXISTS gbp_profiles (
  client_id   VARCHAR(36) PRIMARY KEY REFERENCES clients(id),
  place_id    TEXT NOT NULL,
  facts_json  TEXT NOT NULL,
  fetched_at  VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS website_facts (
  client_id   VARCHAR(36) PRIMARY KEY REFERENCES clients(id),
  url         TEXT NOT NULL,
  facts_json  TEXT NOT NULL,
  fetched_at  VARCHAR(32) NOT NULL
);

-- Persistent inventory. Discovery appends here; audits re-read from here.
CREATE TABLE IF NOT EXISTS citations (
  id              VARCHAR(36) PRIMARY KEY,
  client_id       VARCHAR(36) NOT NULL REFERENCES clients(id),
  url             VARCHAR(700) NOT NULL,
  directory       VARCHAR(120) NOT NULL,
  discovered_via  TEXT NOT NULL,
  discovered_at   VARCHAR(32) NOT NULL,
  status          VARCHAR(24) NOT NULL DEFAULT 'active',
  last_audited_at VARCHAR(32),
  last_result     TEXT,
  notes           TEXT,
  search_snippet  TEXT,
  UNIQUE (client_id, url)
);

CREATE TABLE IF NOT EXISTS discovery_log (
  id            VARCHAR(36) PRIMARY KEY,
  client_id     VARCHAR(36) NOT NULL REFERENCES clients(id),
  provider      VARCHAR(24) NOT NULL,
  query         TEXT NOT NULL,
  results_count INTEGER NOT NULL,
  new_citations INTEGER NOT NULL,
  ran_at        VARCHAR(32) NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_runs (
  id              VARCHAR(36) PRIMARY KEY,
  client_id       VARCHAR(36) NOT NULL REFERENCES clients(id),
  mode            VARCHAR(24) NOT NULL,
  started_at      VARCHAR(32) NOT NULL,
  finished_at     VARCHAR(32),
  citations_total INTEGER NOT NULL DEFAULT 0,
  consistent      INTEGER NOT NULL DEFAULT 0,
  conflicts       INTEGER NOT NULL DEFAULT 0,
  unverified      INTEGER NOT NULL DEFAULT 0,
  sheet_url       TEXT
);

-- Raw evidence: what we fetched and what the model extracted, per citation per run.
CREATE TABLE IF NOT EXISTS snapshots (
  id                    VARCHAR(36) PRIMARY KEY,
  run_id                VARCHAR(36) NOT NULL REFERENCES audit_runs(id),
  citation_id           VARCHAR(36) NOT NULL REFERENCES citations(id),
  fetched_at            VARCHAR(32) NOT NULL,
  http_status           INTEGER,
  fetch_method          VARCHAR(40) NOT NULL,
  extracted_json        TEXT,
  extraction_confidence DOUBLE,
  text_excerpt          TEXT,
  error                 TEXT,
  UNIQUE (run_id, citation_id)
);

-- One row per citation per field per run. status: consistent | conflict | unable_to_verify
CREATE TABLE IF NOT EXISTS findings (
  id          VARCHAR(36) PRIMARY KEY,
  run_id      VARCHAR(36) NOT NULL REFERENCES audit_runs(id),
  citation_id VARCHAR(36) NOT NULL REFERENCES citations(id),
  field       VARCHAR(32) NOT NULL,
  expected    TEXT,
  found       TEXT,
  status      VARCHAR(24) NOT NULL,
  confidence  DOUBLE NOT NULL,
  reason      TEXT,
  needs_qa    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, citation_id, field)
);

-- Human override. decision: confirm | dismiss | correct. Effective status = corrected_status if set, else finding.status.
CREATE TABLE IF NOT EXISTS qa_decisions (
  id               VARCHAR(36) PRIMARY KEY,
  finding_id       VARCHAR(36) NOT NULL UNIQUE REFERENCES findings(id),
  decision         VARCHAR(16) NOT NULL,
  corrected_status VARCHAR(24),
  reviewer         TEXT,
  note             TEXT,
  decided_at       VARCHAR(32) NOT NULL
);

-- Generated report files, kept in the database so they survive an ephemeral disk
-- and ride the same backup as everything else. Served back as downloads.
CREATE TABLE IF NOT EXISTS report_files (
  id         VARCHAR(36) PRIMARY KEY,
  run_id     VARCHAR(36) NOT NULL REFERENCES audit_runs(id),
  name       VARCHAR(64) NOT NULL,
  content    TEXT NOT NULL,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at VARCHAR(32) NOT NULL,
  UNIQUE (run_id, name)
);

-- Every Claude call, for the daily caps and the cost readout in the UI.
CREATE TABLE IF NOT EXISTS llm_usage (
  id            VARCHAR(36) PRIMARY KEY,
  purpose       VARCHAR(40) NOT NULL,
  model         VARCHAR(64) NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read    INTEGER NOT NULL DEFAULT 0,
  cache_write   INTEGER NOT NULL DEFAULT 0,
  cost_usd      DOUBLE NOT NULL DEFAULT 0,
  at            VARCHAR(32) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_citations_client ON citations(client_id, status);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id, status, needs_qa);
CREATE INDEX IF NOT EXISTS idx_snapshots_run ON snapshots(run_id);
CREATE INDEX IF NOT EXISTS idx_llm_usage_at ON llm_usage(at);
CREATE INDEX IF NOT EXISTS idx_report_files_run ON report_files(run_id);
