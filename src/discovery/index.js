import { config } from '../config.js';
import { all, get, insert, uuid, now } from '../db.js';
import { normalizeUrl, normUrlHost, normPhone } from '../compare/normalize.js';
import { classifyUrl, PRIORITY_KEYS, PRIORITY_SITES } from './directories.js';
import * as ddg from './providers/ddg.js';
import * as cse from './providers/google-cse.js';
import * as serp from './providers/serpapi.js';

const PROVIDERS = { ddg, 'google-cse': cse, serpapi: serp };

export function buildQueries(canonical, client) {
  const name = canonical.name?.value || client.name;
  const addr = canonical.address?.value;
  const city = typeof addr === 'object' ? addr?.city : (addr || '').split(',').slice(-2, -1)[0]?.trim();
  const state = typeof addr === 'object' ? addr?.state : '';
  const phone = canonical.phone?.value ? normPhone(canonical.phone.value) : null;
  const loc = [city, state].filter(Boolean).join(' ');
  const q = [`"${name}" ${loc}`.trim()];
  if (phone) q.push(`"${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}" OR "(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}"`);
  q.push(`"${name}" ${loc} reviews`.trim());
  for (const k of PRIORITY_KEYS.slice(0, config.discoverySiteQueries)) q.push(`"${name}" ${city || ''} site:${PRIORITY_SITES[k]}`.replace(/\s+/g, ' '));
  return q;
}

export function addCitation(clientId, url, directory, via, extra = {}) {
  const norm = normalizeUrl(url);
  const existing = get('SELECT id FROM citations WHERE client_id = ? AND url = ?', [clientId, norm]);
  if (existing) return { id: existing.id, created: false };
  const row = insert('citations', { id: uuid(), client_id: clientId, url: norm, directory, discovered_via: via, discovered_at: now(), status: 'active', last_audited_at: null, last_result: null, notes: extra.notes || null, search_snippet: extra.snippet || null });
  return { id: row.id, created: true };
}

// provider may be a comma-separated failover chain, e.g. "google-cse,ddg": when one provider errors, the next takes over.
export async function discover(client, canonical, { provider = config.discoveryProvider, log = console.log, maxQueries = Infinity } = {}) {
  const chain = String(provider).split(',').map(s => s.trim()).filter(Boolean);
  for (const name of chain) if (!PROVIDERS[name]) throw new Error(`Unknown discovery provider "${name}" (ddg | google-cse | serpapi)`);
  let idx = 0;
  const current = () => chain[idx];
  const clientHost = normUrlHost(client.website || canonical.website?.value);
  const phone = canonical.phone?.value ? normPhone(canonical.phone.value) : null;
  const nameTokens = (canonical.name?.value || client.name).toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const queries = buildQueries(canonical, client).slice(0, maxQueries);
  let added = 0, seen = 0;
  for (const query of queries) {
    let results = null, provider = current();
    while (results === null) {
      try { results = await PROVIDERS[provider].search(query); }
      catch (e) {
        log(`  ! ${provider}: ${e.message}`);
        insert('discovery_log', { id: uuid(), client_id: client.id, provider, query, results_count: 0, new_citations: 0, ran_at: now() });
        if (idx + 1 < chain.length) { idx++; provider = current(); log(`  → failing over to ${provider}`); continue; }
        results = false;
      }
    }
    if (results === false) { log('  all discovery providers failed; stopping (inventory so far is kept)'); break; }
    let newHere = 0;
    for (const r of results) {
      seen++;
      const c = classifyUrl(r.url, clientHost);
      if (!c || c.kind === 'own-site' || c.kind === 'noise' || c.kind === 'directory-nonprofile') continue;
      const blob = `${r.title} ${r.snippet}`.toLowerCase();
      const mentionsPhone = phone && blob.replace(/\D/g, '').includes(phone);
      const mentionsName = nameTokens.filter(t => blob.includes(t)).length >= Math.min(2, nameTokens.length);
      if (c.kind === 'other' && !mentionsPhone && !mentionsName) continue;
      const { created } = addCitation(client.id, r.url, c.directory, provider, { notes: c.kind === 'other' ? 'Unlisted source; matched by name/phone in search snippet' : null, snippet: [r.title, r.snippet].filter(Boolean).join(' — ') });
      if (created) { newHere++; log(`  + ${c.directory}: ${r.url}`); }
    }
    added += newHere;
    insert('discovery_log', { id: uuid(), client_id: client.id, provider, query, results_count: results.length, new_citations: newHere, ran_at: now() });
    log(`  ${query}  →  ${results.length} results, ${newHere} new`);
  }
  return { queries: queries.length, seen, added, provider: current() };
}

export function inventory(clientId) {
  return all('SELECT * FROM citations WHERE client_id = ? ORDER BY directory, url', [clientId]);
}
