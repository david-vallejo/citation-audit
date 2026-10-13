import { config } from '../config.js';
import { all, get, insert, uuid, now, getPrevious, getLocations } from '../db.js';
import { normalizeUrl, unwrapUrl, normUrlHost, normPhone, parseAddress } from '../compare/normalize.js';
import { classifyUrl, PRIORITY_KEYS, PRIORITY_SITES } from './directories.js';
import * as ddg from './providers/ddg.js';
import * as cse from './providers/google-cse.js';
import * as serp from './providers/serpapi.js';
import * as serpGoogle from './providers/scraperapi-google.js';

const PROVIDERS = { 'scraperapi-google': serpGoogle, ddg, 'google-cse': cse, serpapi: serp };

const phoneQuery = p => `"${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}" OR "(${p.slice(0, 3)}) ${p.slice(3, 6)}-${p.slice(6)}"`;

// Outdated listings only show the old details, so a search for the current address and
// phone never finds them. Search the previous ones explicitly, directory by directory.
// Other current locations are searched the same way.
function previousQueries(name, previous) {
  const q = [];
  for (const raw of previous.phones) { const p = normPhone(raw); if (p) q.push(phoneQuery(p)); }
  for (const raw of previous.addresses) {
    const a = parseAddress(raw);
    if (!a) continue;
    const loc = [a.city, a.state].filter(Boolean).join(' ');
    if (loc) q.push(`"${name}" ${loc}`);
    if (a.street) q.push(`"${name}" "${a.street}"`);
    if (a.city) for (const k of PRIORITY_KEYS.slice(0, config.discoverySiteQueries)) q.push(`"${name}" ${a.city} site:${PRIORITY_SITES[k]}`);
  }
  return q;
}

// A full sweep searches every priority directory plus the long tail of smaller ones, by
// name alone, so listings filed under another town or a service area still turn up.
export const SWEEP_SITES = ['chamberofcommerce.com', 'merchantcircle.com', 'hotfrog.com', 'foursquare.com', 'alignable.com', 'dexknows.com', 'showmelocal.com', 'cylex.us.com', 'brownbook.net', 'ezlocal.com', 'citysquares.com', 'bizapedia.com', 'dnb.com', 'birdeye.com', 'instagram.com', 'youtube.com', 'linkedin.com', 'nicelocal.com', 'yellowbook.com', 'expertise.com'];

// "Empire Netting & Fence" is also listed as "Empire Fence & Netting" and "Empire Netting and Fence".
export function nameVariants(name) {
  const out = new Set([name]);
  const m = name.match(/^(\S+(?:\s+\S+)*?)\s+(\S+)\s+(?:&|and)\s+(\S+)$/i);
  if (m) {
    out.add(`${m[1]} ${m[3]} & ${m[2]}`);
    out.add(`${m[1]} ${m[2]} and ${m[3]}`);
    out.add(`${m[1]} ${m[3]} and ${m[2]}`);
  }
  return [...out];
}

// Plain Google searches, the way a person would look for the business: every spelling of the
// name, the phone in each common format, the street address, and each location's town.
// These find the listings and mentions that no directory-by-directory query thinks to ask for.
export function webQueries(canonical, client) {
  const name = canonical.name?.value || client.name;
  const addr = canonical.address?.value;
  const a = typeof addr === 'object' ? addr : parseAddress(addr || '');
  const phone = canonical.phone?.value ? normPhone(canonical.phone.value) : null;
  const own = normUrlHost(client.website || canonical.website?.value);
  const q = nameVariants(name).map(v => `"${v}"${own ? ` -site:${own}` : ''}`);
  if (phone) q.push(`"${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}"`, `"(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}"`, `"${phone.slice(0, 3)}.${phone.slice(3, 6)}.${phone.slice(6)}"`);
  if (a?.street) q.push(`"${a.street}" ${a.city || ''}`.trim());
  const first = name.split(/\s+/).slice(0, 2).join(' ');
  for (const loc of [a, ...getLocations(client).addresses.map(parseAddress)]) {
    if (!loc) continue;
    const town = [loc.city || (!/\d/.test(loc.street || '') ? loc.street : ''), loc.state].filter(Boolean).join(' ');
    if (town) q.push(`"${first}" ${town}`, `"${name}" ${town} reviews`);
  }
  return q;
}

export function buildQueries(canonical, client, { full = false } = {}) {
  const name = canonical.name?.value || client.name;
  const addr = canonical.address?.value;
  const city = typeof addr === 'object' ? addr?.city : (addr || '').split(',').slice(-2, -1)[0]?.trim();
  const state = typeof addr === 'object' ? addr?.state : '';
  const phone = canonical.phone?.value ? normPhone(canonical.phone.value) : null;
  const loc = [city, state].filter(Boolean).join(' ');
  const q = [`"${name}" ${loc}`.trim()];
  if (phone) q.push(phoneQuery(phone));
  q.push(`"${name}" ${loc} reviews`.trim());
  for (const k of PRIORITY_KEYS.slice(0, config.discoverySiteQueries)) q.push(`"${name}" ${city || ''} site:${PRIORITY_SITES[k]}`.replace(/\s+/g, ' '));
  for (const extra of webQueries(canonical, client)) q.push(extra);
  const anyName = nameVariants(name).map(v => `"${v}"`).join(' OR ');
  if (full) for (const site of [...PRIORITY_KEYS.map(k => PRIORITY_SITES[k]), ...SWEEP_SITES]) q.push(`${anyName} site:${site}`);
  for (const extra of previousQueries(name, getPrevious(client))) if (!q.includes(extra)) q.push(extra);
  for (const extra of previousQueries(name, getLocations(client))) if (!q.includes(extra)) q.push(extra);
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
export async function discover(client, canonical, { provider = config.discoveryProvider, log = console.log, maxQueries = Infinity, full = false } = {}) {
  let chain = String(provider).split(',').map(s => s.trim()).filter(Boolean);
  // When the ScraperAPI key is present, real Google results are available without any
  // Google Cloud setup. Put that first unless the chain names it already, so an older
  // DISCOVERY_PROVIDER value in the host's environment does not have to be edited.
  if (serpGoogle.available() && !chain.includes('scraperapi-google')) chain = ['scraperapi-google', ...chain];
  for (const name of chain) if (!PROVIDERS[name]) throw new Error(`Unknown discovery provider "${name}" (scraperapi-google | google-cse | ddg | serpapi)`);
  log(`Discovery providers, in order: ${chain.join(' → ')}`);
  let idx = 0;
  const current = () => chain[idx];
  const clientHost = normUrlHost(client.website || canonical.website?.value);
  const phone = canonical.phone?.value ? normPhone(canonical.phone.value) : null;
  const oldPhones = getPrevious(client).phones.map(normPhone).filter(Boolean);
  // A result has to name this business, not just any fence company in the same town.
  // "site:yelp.com" queries return competitors too, and the audit would then spend
  // credits reading them and flag every field as a conflict. Match on the words that
  // distinguish the business, not the industry or the city it shares with everyone.
  const GENERIC = new Set(['fence', 'fences', 'fencing', 'company', 'co', 'llc', 'inc', 'corp', 'corporation', 'the', 'and', 'of', 'for', 'services', 'service', 'contractor', 'contractors', 'construction', 'gate', 'gates', 'install', 'installation', 'repair']);
  const addrVal = canonical.address?.value;
  const place = typeof addrVal === 'object' ? `${addrVal?.city || ''} ${addrVal?.state || ''}` : String(addrVal || '');
  const placeTokens = new Set(place.toLowerCase().split(/\W+/).filter(Boolean));
  const nameTokens = (canonical.name?.value || client.name).toLowerCase().split(/\W+/).filter(t => t.length > 2);
  const distinctive = nameTokens.filter(t => !GENERIC.has(t) && !placeTokens.has(t));
  const namePhrase = nameTokens.join(' ');
  const clean = str => { try { str = decodeURIComponent(str); } catch { /* keep raw */ } return str.toLowerCase().replace(/[-_+.%/]/g, ' '); };
  const matchesBusiness = r => {
    // The snippet echoes whatever was searched for, so a competitor's page still "mentions"
    // the client there. The URL slug and the page title do not lie; require the match in those.
    const strong = clean(`${r.title} ${r.url}`);
    const anywhere = clean(`${r.title} ${r.snippet} ${r.url}`);
    const digits = anywhere.replace(/\D/g, '');
    if (phone && digits.includes(phone)) return true;
    if (oldPhones.some(p => digits.includes(p))) return true;
    if (distinctive.length) return distinctive.some(t => strong.includes(t));
    return strong.includes(namePhrase);
  };
  const queries = [...new Set(buildQueries(canonical, client, { full }))].slice(0, maxQueries);
  let added = 0, seen = 0, failedInARow = 0, skipped = 0;
  // One bad response must not end the sweep. Retry a query that failed for a passing reason,
  // skip it if it keeps failing, and only give up on a provider after several queries in a row fail.
  const passing = e => /\b(429|5\d\d)\b|timeout|timed out|fetch failed|ECONNRESET/i.test(e.message);
  for (const query of queries) {
    let results = null, provider = current();
    for (let attempt = 0; results === null; attempt++) {
      try { results = await PROVIDERS[provider].search(query); failedInARow = 0; }
      catch (e) {
        log(`  ! ${provider}: ${e.message.slice(0, 160)}`);
        insert('discovery_log', { id: uuid(), client_id: client.id, provider, query, results_count: 0, new_citations: 0, ran_at: now() });
        if (passing(e) && attempt < 2) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
        if (++failedInARow < 3) { results = false; break; }
        if (idx + 1 < chain.length) { idx++; provider = current(); failedInARow = 0; attempt = -1; log(`  → failing over to ${provider}`); continue; }
        results = 'stop';
      }
    }
    if (results === 'stop') { log('  all discovery providers failed; stopping (inventory so far is kept)'); break; }
    if (results === false) { skipped++; log(`  skipped after repeated errors: ${query}`); continue; }
    let newHere = 0;
    for (const r of results) {
      seen++;
      r.url = unwrapUrl(r.url);
      const c = classifyUrl(r.url, clientHost);
      if (!c || c.kind === 'own-site' || c.kind === 'noise' || c.kind === 'directory-nonprofile') continue;
      if (!matchesBusiness(r)) { log(`  · not this business: ${r.url}`); continue; }
      const { created } = addCitation(client.id, r.url, c.directory, provider, { notes: c.kind === 'other' ? 'Not one of the known directories; kept because its title or address names the business' : null, snippet: [r.title, r.snippet].filter(Boolean).join(' — ') });
      if (created) { newHere++; log(`  + ${c.directory}: ${r.url}`); }
    }
    added += newHere;
    insert('discovery_log', { id: uuid(), client_id: client.id, provider, query, results_count: results.length, new_citations: newHere, ran_at: now() });
    log(`  ${query}  →  ${results.length} results, ${newHere} new`);
  }
  if (skipped) log(`  ${skipped} search(es) skipped after repeated errors`);
  return { queries: queries.length, seen, added, skipped, provider: current() };
}

export function inventory(clientId) {
  return all('SELECT * FROM citations WHERE client_id = ? ORDER BY directory, url', [clientId]);
}
