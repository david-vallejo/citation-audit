import { config } from './config.js';
import { all, get, insert, update, uuid, now, getCanonical, setCanonical } from './db.js';
import { placeDetails, searchPlaces, resolvePlaceInput } from './canonical/places.js';
import { scrapeWebsite } from './canonical/website.js';
import { discover } from './discovery/index.js';
import { fetchPage, mapLimit } from './fetch/page.js';
import { extractListing, BudgetError, usageToday } from './extract/claude.js';
import { classify, unverifiedAll, displayCanonical, CONFLICT, UNVERIFIED, CONSISTENT } from './compare/classify.js';
import { normPhone, fmtPhone } from './compare/normalize.js';

export function targetOf(client, canonical) {
  const addr = canonical.address?.value;
  return { name: canonical.name?.value || client.name, city: typeof addr === 'object' ? addr?.city : '', phone: canonical.phone?.value ? fmtPhone(canonical.phone.value) : '' };
}

export async function refreshCanonical(client, { log = console.log, lookup = null, skipWebsite = false } = {}) {
  let gbp = null;
  if (lookup && !client.place_id) {
    const resolved = await resolvePlaceInput(lookup);
    if (resolved.placeId) {
      log(`  resolved a Place ID from the ${resolved.via}`);
      gbp = await placeDetails(resolved.placeId);
    } else {
      log(`  searching Google for "${resolved.query}"${resolved.bias ? ' near the coordinates in the link' : ''}`);
      const hits = await searchPlaces(resolved.query, resolved.bias);
      if (!hits.length) throw new Error(`Google found no business matching "${resolved.query}". Open it in Google Maps and paste the address bar instead.`);
      gbp = hits[0];
    }
    update('clients', client.id, { place_id: gbp.place_id, updated_at: now() });
    client.place_id = gbp.place_id;
    log(`  matched GBP: ${gbp.name} — ${gbp.formatted_address} (${gbp.place_id})`);
  } else if (client.place_id) {
    gbp = await placeDetails(client.place_id);
    log(`  GBP: ${gbp.name} — ${gbp.formatted_address}`);
  } else {
    log('  no place_id on client; skipping GBP (add with: client set <slug> --place-id ... or --lookup "Name City ST")');
  }
  if (gbp) {
    for (const f of ['name', 'address', 'phone', 'website', 'hours', 'categories']) {
      if (gbp[f] != null && gbp[f] !== '' && !(Array.isArray(gbp[f]) && !gbp[f].length)) setCanonical(client.id, f, gbp[f], 'gbp', gbp.maps_url);
    }
    if (gbp.website && !client.website) update('clients', client.id, { website: gbp.website, updated_at: now() });
  }
  const website = client.website || gbp?.website;
  if (website && !skipWebsite) {
    const canon = getCanonical(client.id);
    const site = await scrapeWebsite(website, targetOf(client, canon), { log });
    const src = site.sources[0];
    for (const f of ['year_founded', 'services', 'email']) if (site.facts[f] != null) setCanonical(client.id, f, site.facts[f], 'website', src);
    for (const f of ['name', 'address', 'phone', 'hours']) if (site.facts[f] != null && !canon[f]) setCanonical(client.id, f, site.facts[f], 'website', src);
    if (!getCanonical(client.id).website) setCanonical(client.id, 'website', website, 'website', src);
    log(`  website facts: year=${site.facts.year_founded ?? '–'} services=${site.facts.services?.length ?? 0} email=${site.facts.email ?? '–'}`);
  }
  return getCanonical(client.id);
}

function citationResult(findings) {
  if (findings.some(f => f.status === CONFLICT)) return CONFLICT;
  if (findings.every(f => f.status === UNVERIFIED)) return UNVERIFIED;
  return CONSISTENT;
}

async function auditOne(run, client, canonical, target, citation, log) {
  const startedAt = now();
  let page, findings, snapshot = { id: uuid(), run_id: run.id, citation_id: citation.id, fetched_at: startedAt, http_status: null, fetch_method: 'error', extracted_json: null, extraction_confidence: null, text_excerpt: null, error: null };
  try {
    page = await fetchPage(citation.url);
    snapshot.http_status = page.status; snapshot.fetch_method = page.method; snapshot.text_excerpt = page.text.slice(0, 2000) || null;
    let source = page, cap = 1, evidenceNote = '';
    if (page.method === 'blocked' || page.method === 'error') {
      snapshot.error = page.error;
      if (citation.search_snippet) {
        source = { title: '', description: '', jsonld: [], text: `SEARCH RESULT SNIPPET (the profile itself could not be fetched; only this summary is available):\n${citation.search_snippet}` };
        snapshot.fetch_method = 'snippet'; snapshot.text_excerpt = citation.search_snippet; cap = 0.6; evidenceNote = ' [from search snippet only]';
      } else {
        findings = unverifiedAll(`Could not fetch profile (${page.error}); check manually`, canonical);
      }
    } else if (page.method === 'archive') { cap = 0.7; evidenceNote = ` [from archived copy ${page.archivedOn}]`; }
    if (!findings) {
      const { data } = await extractListing(source, citation.url, target);
      snapshot.extracted_json = JSON.stringify(data); snapshot.extraction_confidence = data.confidence;
      if (!data.is_profile_page && data.confidence < 0.5) {
        findings = unverifiedAll(`Page is not a single-business profile (${data.notes || 'no matching listing found'})`, canonical);
      } else {
        findings = classify(canonical, data, { extractionConfidence: Math.min(data.confidence, cap) });
        const nameF = findings.find(f => f.field === 'name');
        if (nameF?.status === CONFLICT && nameF.confidence < 0.6) for (const f of findings) if (f.status !== UNVERIFIED) f.needs_qa = 1;
        if (data.confidence < 0.5) for (const f of findings) if (f.status !== UNVERIFIED) f.needs_qa = 1;
        if (evidenceNote) for (const f of findings) { f.reason = (f.reason || '') + evidenceNote; if (f.status !== UNVERIFIED) f.needs_qa = 1; }
      }
    }
  } catch (e) {
    snapshot.error = e.message;
    findings = unverifiedAll(e instanceof BudgetError ? `Skipped: ${e.message}` : `Extraction failed: ${e.message}`, canonical);
  }
  insert('snapshots', snapshot);
  for (const f of findings) insert('findings', { id: uuid(), run_id: run.id, citation_id: citation.id, ...f });
  const result = citationResult(findings);
  update('citations', citation.id, { last_audited_at: now(), last_result: result });
  const tag = result === CONFLICT ? `CONFLICT (${findings.filter(f => f.status === CONFLICT).map(f => f.field).join(', ')})` : result === UNVERIFIED ? `UNVERIFIED (${snapshot.error || findings[0]?.reason || ''})` : 'consistent';
  log(`  ${citation.directory.padEnd(16)} ${tag}  ${citation.url}`);
  return result;
}

export async function runAudit(client, { rediscover = false, limit = Infinity, provider, log = console.log, dryRun = false } = {}) {
  const canonical = getCanonical(client.id);
  if (!canonical.name || !canonical.phone) throw new Error(`Canonical facts incomplete for ${client.slug}; run: node src/cli.js canonical ${client.slug}`);
  const target = targetOf(client, canonical);
  const active = () => all("SELECT * FROM citations WHERE client_id = ? AND status = 'active' ORDER BY directory, url", [client.id]);
  let mode = 'recheck';
  if (rediscover || !active().length) {
    mode = rediscover ? 'rediscover' : 'initial-discovery';
    log(`${mode === 'rediscover' ? 'Re-discovery requested' : 'No inventory yet'} — running discovery (${provider || config.discoveryProvider})…`);
    const d = await discover(client, canonical, { provider, log });
    log(`  discovery: ${d.queries} queries, ${d.seen} results, ${d.added} new citations`);
  } else {
    log(`Inventory has ${active().length} known profiles — re-auditing stored URLs (no web discovery).`);
  }
  const citations = active().slice(0, limit);
  if (dryRun) return { mode, citations };
  const run = insert('audit_runs', { id: uuid(), client_id: client.id, mode, started_at: now(), finished_at: null, citations_total: citations.length, consistent: 0, conflicts: 0, unverified: 0, sheet_url: null });
  log(`Audit run ${run.id} — ${citations.length} citations, ${config.fetchConcurrency} at a time`);
  const results = await mapLimit(citations, config.fetchConcurrency, c => auditOne(run, client, canonical, target, c, log));
  const tally = { consistent: 0, conflicts: 0, unverified: 0 };
  for (const r of results) { if (r === CONFLICT) tally.conflicts++; else if (r === UNVERIFIED) tally.unverified++; else tally.consistent++; }
  update('audit_runs', run.id, { finished_at: now(), ...tally });
  const qa = get('SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND needs_qa = 1', [run.id]).n;
  const u = usageToday();
  log(`Done: ${tally.consistent} consistent, ${tally.conflicts} conflict, ${tally.unverified} unable to verify; ${qa} findings queued for QA`);
  log(`Claude today: ${u.calls}/${u.calls_limit} calls, $${u.cost.toFixed(3)} of $${u.cost_limit.toFixed(2)} cap (${config.model})`);
  return { ...run, ...tally, qa_pending: qa };
}

export function effectiveFindings(runId) {
  return all(`
    SELECT f.*, c.url, c.directory, c.status AS citation_status, c.discovered_via, c.discovered_at, c.last_audited_at,
           q.decision, q.corrected_status, q.note AS qa_note, q.reviewer, q.decided_at,
           s.fetch_method, s.http_status, s.extraction_confidence, s.error AS snapshot_error,
           CASE WHEN q.decision = 'dismiss' THEN 'dismissed'
                WHEN q.decision = 'correct' THEN q.corrected_status
                ELSE f.status END AS effective_status,
           CASE WHEN q.decision IS NOT NULL THEN 0 ELSE f.needs_qa END AS qa_open
    FROM findings f
    JOIN citations c ON c.id = f.citation_id
    LEFT JOIN qa_decisions q ON q.finding_id = f.id
    LEFT JOIN snapshots s ON s.run_id = f.run_id AND s.citation_id = f.citation_id
    WHERE f.run_id = ?
    ORDER BY c.directory, c.url, f.field`, [runId]);
}

export function latestRun(clientId) {
  return get('SELECT * FROM audit_runs WHERE client_id = ? ORDER BY started_at DESC LIMIT 1', [clientId]);
}

export function suggestion(f) {
  const where = f.directory;
  switch (f.field) {
    case 'phone': return `Update phone on ${where} to ${f.expected}`;
    case 'address': return `Update address on ${where} to "${f.expected}"`;
    case 'name': return `Change business name on ${where} to "${f.expected}"`;
    case 'website': return `Point website link on ${where} to ${f.expected}`;
    case 'hours': return `Update hours on ${where} to: ${f.expected}`;
    case 'year_founded': return `Correct year founded on ${where} to ${f.expected}`;
    case 'services': return `Remove services not offered from ${where}: ${(f.reason || '').replace(/^.*?: /, '')}`;
    default: return `Update ${f.field} on ${where} to "${f.expected}"`;
  }
}

export { displayCanonical, normPhone };
