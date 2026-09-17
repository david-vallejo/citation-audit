import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';

// Optional: keep the SQLite file in a GitHub repo so Render's ephemeral disk doesn't lose the inventory.
// Set GH_DB_TOKEN (fine-grained PAT, contents read/write on one private repo) and GH_DB_REPO (owner/name).
const TOKEN = process.env.GH_DB_TOKEN, REPO = process.env.GH_DB_REPO, PATH = process.env.GH_DB_PATH || 'citation-audit.sqlite';
export const enabled = Boolean(TOKEN && REPO);

const api = (path, opts = {}) => fetch(`https://api.github.com${path}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'citation-audit', Accept: 'application/vnd.github+json', ...(opts.headers || {}) } });

export async function restore() {
  if (!enabled || existsSync(config.dbPath)) return false;
  const res = await api(`/repos/${REPO}/contents/${PATH}`, { headers: { Accept: 'application/vnd.github.raw' } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`restore: GitHub ${res.status}`);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  writeFileSync(config.dbPath, Buffer.from(await res.arrayBuffer()));
  console.log(`[persist] restored database from ${REPO}/${PATH}`);
  return true;
}

let timer = null, inflight = false, dirty = false;
export function schedulePersist(delay = 5000) {
  if (!enabled) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(persistNow, delay);
}

export async function persistNow() {
  if (!enabled || inflight) { if (inflight) dirty = true; return; }
  inflight = true; dirty = false;
  try {
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const content = readFileSync(config.dbPath).toString('base64');
    const cur = await api(`/repos/${REPO}/contents/${PATH}`);
    const sha = cur.ok ? (await cur.json()).sha : undefined;
    const res = await api(`/repos/${REPO}/contents/${PATH}`, { method: 'PUT', body: JSON.stringify({ message: `db sync ${new Date().toISOString()}`, content, sha }) });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.log('[persist] database synced to GitHub');
  } catch (e) { console.error('[persist] failed:', e.message); }
  finally { inflight = false; if (dirty) schedulePersist(); }
}
