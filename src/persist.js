import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { config } from './config.js';
import { getDb } from './db.js';

// Optional: keep the SQLite file in a GitHub repo so Render's ephemeral disk doesn't lose the inventory.
// Set GH_DB_TOKEN (fine-grained PAT, contents read/write on one private repo) and GH_DB_REPO (owner/name).
const TOKEN = process.env.GH_DB_TOKEN, REPO = process.env.GH_DB_REPO, PATH = process.env.GH_DB_PATH || 'citation-audit.sqlite';
export const enabled = Boolean(TOKEN && REPO);

const api = (path, opts = {}) => fetch(`https://api.github.com${path}`, { ...opts, headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'citation-audit', Accept: 'application/vnd.github+json', ...(opts.headers || {}) } });

// How many clients a database file holds. Used to decide whether a copy is worth
// keeping, so an empty database can never quietly replace a populated one.
function clientCount(file) {
  if (!existsSync(file)) return 0;
  try {
    const d = new DatabaseSync(file, { readOnly: true });
    try { return d.prepare('SELECT COUNT(*) AS n FROM clients').get().n; }
    finally { d.close(); }
  } catch { return 0; }
}

export async function restore() {
  if (!enabled) return false;
  const localClients = clientCount(config.dbPath);
  // Restore when there is nothing local, and also when the local copy is empty
  // while the backup is not. The second case recovers an instance that started
  // before the backup existed, which is exactly how data gets stranded.
  if (existsSync(config.dbPath) && localClients > 0) return false;
  const res = await api(`/repos/${REPO}/contents/${PATH}`, { headers: { Accept: 'application/vnd.github.raw' } });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`restore: GitHub ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const tmp = `${config.dbPath}.incoming`;
  writeFileSync(tmp, buf);
  const remoteClients = clientCount(tmp);
  if (existsSync(config.dbPath) && remoteClients === 0) {
    rmSync(tmp, { force: true });
    return false;
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${config.dbPath}${suffix}`, { force: true });
  renameSync(tmp, config.dbPath);
  console.log(`[persist] restored database from ${REPO}/${PATH} (${remoteClients} client(s))`);
  return true;
}

let timer = null, inflight = false, dirty = false;
export function schedulePersist(delay = 5000) {
  if (!enabled) return;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(persistNow, delay);
}

export async function persistNow({ force = false } = {}) {
  if (!enabled || inflight) { if (inflight) dirty = true; return; }
  inflight = true; dirty = false;
  try {
    getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const localClients = clientCount(config.dbPath);
    const cur = await api(`/repos/${REPO}/contents/${PATH}`);
    const sha = cur.ok ? (await cur.json()).sha : undefined;

    // Never let an empty database overwrite a populated backup. Two things cause
    // this: a fresh instance that started before the backup existed, and a
    // deploy overlap where the old and new instances both sync.
    if (!force && localClients === 0 && sha) {
      const raw = await api(`/repos/${REPO}/contents/${PATH}`, { headers: { Accept: 'application/vnd.github.raw' } });
      if (raw.ok) {
        const tmp = `${config.dbPath}.remote-check`;
        writeFileSync(tmp, Buffer.from(await raw.arrayBuffer()));
        const remoteClients = clientCount(tmp);
        rmSync(tmp, { force: true });
        if (remoteClients > 0) {
          console.error(`[persist] refusing to overwrite a backup holding ${remoteClients} client(s) with an empty database. Restart to restore it.`);
          return;
        }
      }
    }

    const content = readFileSync(config.dbPath).toString('base64');
    const res = await api(`/repos/${REPO}/contents/${PATH}`, { method: 'PUT', body: JSON.stringify({ message: `db sync ${new Date().toISOString()} (${localClients} client(s))`, content, sha }) });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
    console.log(`[persist] database synced to GitHub (${localClients} client(s))`);
  } catch (e) { console.error('[persist] failed:', e.message); }
  finally { inflight = false; if (dirty) schedulePersist(); }
}
