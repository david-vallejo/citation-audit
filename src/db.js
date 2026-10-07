import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config, TOOL_DIR } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new DatabaseSync(config.dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(readFileSync(join(TOOL_DIR, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

// Columns added after the first release. CREATE TABLE IF NOT EXISTS will not add them
// to an existing database, so bring old files forward here. Each entry is idempotent.
const ADDED_COLUMNS = [
  ['clients', 'gbp_url', 'VARCHAR(700)'],
  ['citations', 'search_snippet', 'TEXT'],
  ['clients', 'previous_json', 'TEXT'],
];
function migrate(d) {
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

export const uuid = () => randomUUID();
export const now = () => new Date().toISOString();

export function all(sql, params = []) { return getDb().prepare(sql).all(...params); }
export function get(sql, params = []) { return getDb().prepare(sql).get(...params); }
export function run(sql, params = []) { return getDb().prepare(sql).run(...params); }

export function insert(table, row) {
  const keys = Object.keys(row);
  run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => row[k]));
  return row;
}

export function update(table, id, patch) {
  const keys = Object.keys(patch);
  run(`UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map(k => patch[k]), id]);
}

export function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN');
  try { const r = fn(); d.exec('COMMIT'); return r; }
  catch (e) { d.exec('ROLLBACK'); throw e; }
}

export function getClient(slug) {
  const c = get('SELECT * FROM clients WHERE slug = ?', [slug]);
  if (!c) throw new Error(`Unknown client "${slug}". Run: node src/cli.js client add ${slug} --name "..." --website https://...`);
  return c;
}

// Contact details the business used to have: an old address or phone that outdated
// listings still show. Discovery searches for them and the audit treats a listing that
// shows them as this business with old info, not as some other business.
export function getPrevious(client) {
  let p = {};
  try { p = JSON.parse(client?.previous_json || '{}') || {}; } catch { p = {}; }
  return { addresses: Array.isArray(p.addresses) ? p.addresses.filter(Boolean) : [], phones: Array.isArray(p.phones) ? p.phones.filter(Boolean) : [] };
}

export function parsePreviousInput(text) {
  const addresses = [], phones = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const digits = line.replace(/\D/g, '');
    const letters = line.replace(/[^a-z]/gi, '');
    if ((digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) && letters.length <= 3) phones.push(line);
    else addresses.push(line);
  }
  return { addresses, phones };
}

export function getCanonical(clientId) {
  const out = {};
  for (const r of all('SELECT * FROM canonical_facts WHERE client_id = ?', [clientId])) {
    out[r.field] = { value: JSON.parse(r.value_json), source: r.source, source_url: r.source_url, captured_at: r.captured_at };
  }
  return out;
}

export function setCanonical(clientId, field, value, source, sourceUrl = null, { force = false } = {}) {
  const existing = get('SELECT * FROM canonical_facts WHERE client_id = ? AND field = ?', [clientId, field]);
  if (existing && existing.source === 'manual' && source !== 'manual' && !force) return existing;
  if (existing) {
    update('canonical_facts', existing.id, { value_json: JSON.stringify(value), source, source_url: sourceUrl, captured_at: now() });
    return existing;
  }
  return insert('canonical_facts', { id: uuid(), client_id: clientId, field, value_json: JSON.stringify(value), source, source_url: sourceUrl, captured_at: now() });
}

// Latest raw read of each source, one row per client. Written on every refresh; manual
// overrides live in canonical_facts and never touch these.
function putSource(table, clientId, cols, facts) {
  run(`DELETE FROM ${table} WHERE client_id = ?`, [clientId]);
  insert(table, { client_id: clientId, ...cols, facts_json: JSON.stringify(facts), fetched_at: now() });
}
function getSource(table, clientId) {
  const r = get(`SELECT * FROM ${table} WHERE client_id = ?`, [clientId]);
  return r ? { ...r, facts: JSON.parse(r.facts_json) } : null;
}
export const saveGbpProfile = (clientId, gbp) => putSource('gbp_profiles', clientId, { place_id: gbp.place_id }, gbp);
export const getGbpProfile = clientId => getSource('gbp_profiles', clientId);
export const saveWebsiteFacts = (clientId, url, facts) => putSource('website_facts', clientId, { url }, facts);
export const getWebsiteFacts = clientId => getSource('website_facts', clientId);
