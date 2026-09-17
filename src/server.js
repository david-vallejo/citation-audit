#!/usr/bin/env node
// Web UI: client setup → canonical facts → discovery → audit → QA queue → Google Sheet. Zero front-end deps.
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { config, AUDIT_FIELDS, PHASE2_FIELDS } from './config.js';
import { all, get, insert, update, uuid, now, getClient, getCanonical, setCanonical, getDb } from './db.js';
import { refreshCanonical, runAudit, effectiveFindings, latestRun, suggestion, displayCanonical } from './audit.js';
import { discover, addCitation, inventory } from './discovery/index.js';
import { classifyUrl } from './discovery/directories.js';
import { writeReport, runById } from './report/sheets.js';
import { parseAddress, normHours, normServices, normPhone } from './compare/normalize.js';
import { restore, schedulePersist, persistNow, enabled as persistEnabled } from './persist.js';
import { usageToday } from './extract/claude.js';
import { diagnose } from './diagnose.js';

const PORT = process.env.PORT || config.qaPort;
const PASSWORD = process.env.APP_PASSWORD;

// ---------- jobs (in-process, polled by the browser) ----------
// Short-lived messages shown as a closable banner after a redirect.
const flashes = new Map();
function flash(kind, title, detail = '') {
  for (const [k, v] of flashes) if (Date.now() - v.at > 15 * 60_000) flashes.delete(k);
  const id = uuid().slice(0, 8);
  flashes.set(id, { kind, title, detail, at: Date.now() });
  return id;
}
const takeFlash = id => { const f = flashes.get(id); if (f) flashes.delete(id); return f; };
const withFlash = (to, id) => (id ? `${to}${to.includes('?') ? '&' : '?'}m=${id}` : to);

const jobs = new Map();
function startJob(kind, slug, fn) {
  const job = { id: uuid(), kind, slug, log: [], done: false, error: null, result: null, started: now() };
  jobs.set(job.id, job);
  const log = m => { job.log.push(m); console.log(`[${slug}] ${m}`); };
  fn(log).then(r => { job.result = r; }).catch(e => { job.error = e.message; log(`ERROR: ${e.message}`); console.error(e); }).finally(() => { job.done = true; schedulePersist(); });
  return job;
}
const busy = slug => [...jobs.values()].some(j => j.slug === slug && !j.done);

// ---------- html helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const link = (href, text) => `<a href="${esc(href)}">${esc(text)}</a>`;
const ext = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text ?? href)}</a>`;
const badge = s => `<span class="badge ${esc(s)}">${esc({ consistent: 'Consistent', conflict: 'Conflict', unable_to_verify: 'Unable to verify', dismissed: 'Dismissed', active: 'active', ignored: 'ignored', not_client: 'not client' }[s] || s)}</span>`;
const table = (head, rows, cls = '') => `<table class="${cls}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" class="muted">Nothing here yet.</td></tr>`}</tbody></table>`;
const fieldLabel = f => ({ name: 'Business Name', address: 'Address', phone: 'Phone', website: 'Website', hours: 'Hours', year_founded: 'Year Founded', services: 'Services', categories: 'Categories', email: 'Email' }[f] || f);

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1c1f24;--muted:#6b7280;--line:#e5e7eb;--accent:#2563eb;--red:#b91c1c;--green:#15803d;--amber:#b45309}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:#111827;color:#fff;padding:12px 24px;display:flex;gap:18px;align-items:center}header a{color:#fff;text-decoration:none}header .brand{font-weight:600}header .muted{color:#9ca3af}
main{max-width:1280px;margin:0 auto;padding:20px 24px}h1{font-size:22px;margin:0 0 14px}h2{font-size:16px;margin:26px 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f3f4f6;font-weight:600;white-space:nowrap}
td.wrap{max-width:360px;word-break:break-word}.muted{color:var(--muted)}.small{font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600;background:#e5e7eb}.badge.conflict{background:#fee2e2;color:var(--red)}.badge.consistent{background:#dcfce7;color:var(--green)}.badge.unable_to_verify{background:#fef3c7;color:var(--amber)}.badge.dismissed{background:#e5e7eb;color:#374151}
button,.btn{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:7px 12px;font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}button.secondary,.btn.secondary{background:#e5e7eb;color:var(--ink)}button.danger{background:var(--red)}button:disabled{opacity:.5;cursor:default}
form.inline{display:inline}input,select,textarea{font:inherit;padding:6px 8px;border:1px solid #d1d5db;border-radius:6px}input[type=text],input[type=url]{width:100%}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.stat{font-size:26px;font-weight:600}.stat small{font-size:12px;color:var(--muted);font-weight:400;display:block}
pre.log{background:#0b1020;color:#d1d5db;padding:14px;border-radius:8px;max-height:520px;overflow:auto;font-size:12px;white-space:pre-wrap}
.qa form{display:flex;gap:4px;flex-wrap:wrap}.qa select,.qa input{font-size:12px;padding:4px 6px}.qa button{padding:4px 8px;font-size:12px}
.tabs a{margin-right:14px;padding-bottom:4px}.tabs a.on{border-bottom:2px solid var(--accent);font-weight:600}
.notice{position:relative;border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:12px 40px 12px 14px;margin:0 0 16px;background:var(--card)}
.notice.error{border-left-color:var(--red);background:#fef2f2}.notice.warn{border-left-color:var(--amber);background:#fffbeb}.notice.ok{border-left-color:var(--green);background:#f0fdf4}
.notice b{display:block;margin-bottom:2px}.notice .detail{font-size:12px;color:#374151;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;margin-top:4px}
.notice .x{position:absolute;top:6px;right:8px;background:none;border:0;font-size:18px;line-height:1;color:var(--muted);cursor:pointer;padding:2px 6px}
.notice .x:hover{color:var(--ink)}
`;

function noticeHtml(f) {
  if (!f) return '';
  const cls = f.kind === 'error' ? 'error' : f.kind === 'ok' ? 'ok' : 'warn';
  return `<div class="notice ${cls}"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${esc(f.title)}</b>${f.detail ? `<div class="detail">${esc(f.detail)}</div>` : ''}</div>`;
}

// Set by the router just before a page renders; layout consumes it exactly once.
let pendingNotice = null;
export const setNotice = f => { pendingNotice = f || null; };

function layout(title, body, { refresh } = {}) {
  const u = usageToday();
  const notice = pendingNotice; pendingNotice = null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Citation Audit</title><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head>
<body><header><a class="brand" href="/">Citation Audit</a><a href="/setup" class="muted small">Setup check</a><span class="muted">NAP + key-fact consistency checker</span><span style="flex:1"></span><span class="muted small" title="Daily caps reset at midnight UTC">Claude today: ${u.calls}/${u.calls_limit} calls · $${u.cost.toFixed(3)}/$${u.cost_limit.toFixed(2)}</span><span class="muted small">discovery: ${esc(config.discoveryProvider)} · model: ${esc(config.model)} · output: ${config.serviceAccountJson ? 'Google Sheets' : 'CSV (no service account)'}${persistEnabled ? ' · db→GitHub' : ''}</span></header><main>${noticeHtml(notice)}${body}</main></body></html>`;
}

// ---------- pages ----------
function homePage() {
  const clients = all('SELECT * FROM clients ORDER BY name');
  const rows = clients.map(c => {
    const run = latestRun(c.id);
    const inv = get("SELECT COUNT(*) n FROM citations WHERE client_id = ? AND status = 'active'", [c.id]).n;
    return [link(`/client/${c.slug}`, c.name), c.website ? ext(c.website, c.website.replace(/^https?:\/\//, '')) : '', String(inv), run ? `${link(`/run/${run.id}`, run.started_at.slice(0, 10))} · ${run.conflicts} conflict / ${run.unverified} unverified` : '<span class="muted">never</span>'];
  });
  const firstRun = !clients.length;
  return layout('Clients', `${firstRun ? '<div class="card" style="border-color:var(--accent)"><b>First time here?</b> Run the <a href="/setup">setup check</a> to confirm your keys work, then add a client below. After adding one, use the buttons in order: refresh facts, discover, run audit.</div>' : ''}<h1>Clients</h1><div class="card">${table(['Client', 'Website', 'Known profiles', 'Last audit'], rows)}</div>
<h2>Add a client</h2><div class="card"><form method="post" action="/client/add"><div class="grid">
<div><label>Slug (short id)</label><input type="text" name="slug" required placeholder="anvilfence"></div>
<div><label>Business name</label><input type="text" name="name" required placeholder="Anvil Fence Co"></div>
<div><label>Website</label><input type="url" name="website" placeholder="https://anvilfence.com"></div>
<div><label>Google Business Profile lookup (name + city + state) — or a Place ID</label><input type="text" name="lookup" placeholder="Anvil Fence Tulsa OK"></div>
</div><p class="actions"><button>Add client</button> <span class="muted small">Then click “Refresh canonical facts” on the client page. Places API key ${config.placesKey ? 'is set' : 'is NOT set — GBP lookup will be skipped'}.</span></p></form></div>`);
}

function canonicalTable(client, canon) {
  const fields = [...AUDIT_FIELDS, ...PHASE2_FIELDS];
  return table(['Field', 'Canonical value', 'Source', 'Captured', 'Override'], fields.map(f => {
    const c = canon[f];
    return [fieldLabel(f), `<span class="wrap">${esc(displayCanonical(f, c?.value)) || '<span class="muted">—</span>'}</span>`, c ? (c.source_url ? ext(c.source_url, c.source) : esc(c.source)) : '', c ? esc(c.captured_at.slice(0, 10)) : '',
      `<form method="post" action="/client/${client.slug}/canonical" class="inline"><input type="hidden" name="field" value="${f}"><input type="text" name="value" placeholder="${f === 'hours' ? 'Mon-Fri: 8am-5pm; Sat: Closed' : f === 'address' ? 'Street, City, ST 12345' : f === 'services' ? 'comma, separated' : ''}" style="width:240px"> <button class="secondary">Set</button>${c?.source === 'manual' ? ` <form method="post" action="/client/${client.slug}/canonical/clear" class="inline"><input type="hidden" name="field" value="${f}"><button class="secondary" title="Remove manual override">✕</button></form>` : ''}</form>`];
  }));
}

function clientPage(slug) {
  const client = getClient(slug);
  const canon = getCanonical(client.id);
  const inv = inventory(client.id);
  const runs = all('SELECT * FROM audit_runs WHERE client_id = ? ORDER BY started_at DESC', [client.id]);
  const log = all('SELECT * FROM discovery_log WHERE client_id = ? ORDER BY ran_at DESC LIMIT 30', [client.id]);
  const isBusy = busy(slug);
  const active = inv.filter(c => c.status === 'active').length;
  const dis = isBusy ? 'disabled' : '';
  return layout(client.name, `<h1>${esc(client.name)} <span class="muted small">${esc(slug)}</span></h1>
<div class="card"><div class="actions">
<form method="post" action="/client/${slug}/canonical/refresh" class="inline"><button ${dis}>1 · Refresh canonical facts</button></form>
<form method="post" action="/client/${slug}/discover" class="inline"><button ${dis} class="${active ? 'secondary' : ''}">2 · Discover profiles</button></form>
<form method="post" action="/client/${slug}/audit" class="inline"><button ${dis}>3 · Run audit${active ? ` (${active} stored profiles)` : ' (will discover first)'}</button> <label class="inline small" style="display:inline"><input type="checkbox" name="rediscover" value="1"> also re-discover</label> <input type="number" name="limit" placeholder="limit" style="width:70px"></form>
${isBusy ? '<span class="muted">a job is running — see below</span>' : ''}</div>
<p class="muted small">Website: ${client.website ? ext(client.website) : '—'} · Place ID: ${esc(client.place_id || '—')} · Sheet: ${client.sheet_id ? ext(`https://docs.google.com/spreadsheets/d/${client.sheet_id}`, 'open') : '—'}</p>
<form method="post" action="/client/${slug}/set" class="actions"><input type="url" name="website" placeholder="website" value="${esc(client.website || '')}" style="width:260px"><input type="text" name="place_id" placeholder="Place ID" value="${esc(client.place_id || '')}" style="width:260px"><input type="text" name="lookup" placeholder="or GBP lookup: Name City ST" style="width:220px"><button class="secondary">Save</button></form></div>

<h2>Source of truth (GBP + website; manual overrides are sticky)</h2><div class="card">${canonicalTable(client, canon)}</div>

<h2>Audit runs</h2><div class="card">${table(['Started', 'Mode', 'Profiles', 'Consistent', 'Conflicts', 'Unverified', 'Report'], runs.map(r => [link(`/run/${r.id}`, r.started_at.replace('T', ' ').slice(0, 16)), esc(r.mode), String(r.citations_total), String(r.consistent), String(r.conflicts), String(r.unverified), r.sheet_url ? (r.sheet_url.startsWith('http') ? ext(r.sheet_url, 'Google Sheet') : `<span class="small">${esc(r.sheet_url.replace(config.reportsDir, 'reports'))}</span>`) : (r.finished_at ? `<form method="post" action="/run/${r.id}/report" class="inline"><button class="secondary" ${dis}>Generate</button></form>` : '<span class="muted">running…</span>')]))}</div>

<h2>Citation inventory <span class="muted small">(${inv.length} known · ${active} active · persisted, re-used on every run)</span></h2><div class="card">
${table(['Directory', 'Profile URL', 'Status', 'Last result', 'Last audited', 'Found via', ''], inv.map(c => [esc(c.directory), `<span class="wrap">${ext(c.url)}</span>${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}`, badge(c.status), c.last_result ? badge(c.last_result) : '', esc((c.last_audited_at || '').slice(0, 10)), `${esc(c.discovered_via)} <span class="muted">${esc(c.discovered_at.slice(0, 10))}</span>`,
  `<form method="post" action="/citation/${c.id}/status" class="inline"><select name="status" onchange="this.form.submit()"><option ${c.status === 'active' ? 'selected' : ''} value="active">active</option><option ${c.status === 'ignored' ? 'selected' : ''} value="ignored">ignore</option><option ${c.status === 'not_client' ? 'selected' : ''} value="not_client">not this business</option><option ${c.status === 'dead' ? 'selected' : ''} value="dead">dead link</option></select></form>`]))}
<form method="post" action="/client/${slug}/citation/add" class="actions" style="margin-top:10px"><input type="url" name="url" placeholder="Add a profile URL manually (https://www.yelp.com/biz/…)" style="width:480px" required><button class="secondary">Add</button></form></div>

<h2>Discovery log</h2><div class="card">${table(['When', 'Provider', 'Query', 'Results', 'New'], log.map(l => [esc(l.ran_at.replace('T', ' ').slice(0, 16)), esc(l.provider), esc(l.query), String(l.results_count), String(l.new_citations)]))}</div>`);
}

function runPage(id, filter = 'qa') {
  const run = runById(id);
  if (!run) return null;
  const client = get('SELECT * FROM clients WHERE id = ?', [run.client_id]);
  const rows = effectiveFindings(id);
  const open = rows.filter(r => r.qa_open).length, conflicts = rows.filter(r => r.effective_status === 'conflict' && !r.qa_open).length;
  const shown = filter === 'qa' ? rows.filter(r => r.qa_open) : filter === 'conflicts' ? rows.filter(r => r.effective_status === 'conflict') : filter === 'action' ? rows.filter(r => r.effective_status === 'conflict' && !r.qa_open) : rows;
  const tab = (k, t) => `<a href="/run/${id}?filter=${k}" class="${filter === k ? 'on' : ''}">${t}</a>`;
  const qaForm = r => `<div class="qa"><form method="post" action="/finding/${r.id}/qa"><select name="decision"><option value="confirm">Confirm as-is</option><option value="dismiss">Dismiss (not a real issue)</option><option value="correct">Correct status →</option></select><select name="corrected_status"><option value="conflict">conflict</option><option value="consistent">consistent</option><option value="unable_to_verify">unable to verify</option></select><input type="text" name="note" placeholder="note" style="width:140px"><button>Save</button></form>${r.decision ? `<div class="small muted">QA: ${esc(r.decision)}${r.corrected_status ? ` → ${esc(r.corrected_status)}` : ''}${r.qa_note ? ` — ${esc(r.qa_note)}` : ''}</div>` : ''}</div>`;
  return layout(`Run ${id.slice(0, 8)}`, `<h1>${link(`/client/${client.slug}`, client.name)} · audit ${esc(run.started_at.replace('T', ' ').slice(0, 16))} <span class="muted small">${esc(run.mode)}</span></h1>
<div class="card"><div class="grid"><div class="stat">${run.citations_total}<small>profiles audited</small></div><div class="stat" style="color:var(--green)">${run.consistent}<small>consistent</small></div><div class="stat" style="color:var(--red)">${run.conflicts}<small>with conflicts</small></div><div class="stat" style="color:var(--amber)">${run.unverified}<small>unable to verify</small></div><div class="stat">${open}<small>findings awaiting QA</small></div></div>
<p class="actions">${run.sheet_url ? (run.sheet_url.startsWith('http') ? ext(run.sheet_url, 'Open Google Sheet') : `<span class="small">CSV report: ${esc(run.sheet_url.replace(config.reportsDir, 'reports'))}</span>`) : ''} <form method="post" action="/run/${id}/report" class="inline"><button ${busy(client.slug) ? 'disabled' : ''}>${run.sheet_url ? 'Regenerate report' : 'Generate report'}</button></form> <span class="muted small">Client Action tab = ${conflicts} confirmed conflict(s). Findings still in QA are held back from the client tab.</span></p></div>
<p class="tabs">${tab('qa', `QA queue (${open})`)}${tab('action', `Client action (${conflicts})`)}${tab('conflicts', 'All conflicts')}${tab('all', `All findings (${rows.length})`)}</p>
<div class="card">${table(['Directory / URL', 'Field', 'Status', 'Conf.', 'Canonical', 'Found on profile', 'Reason', filter === 'action' ? 'Suggested correction' : 'QA'], shown.map(r => [`${esc(r.directory)}<div class="small wrap">${ext(r.url, r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</div><div class="small">${link(`/citation/${r.citation_id}?run=${id}`, 'evidence')} · ${esc(r.fetch_method || '')}${r.http_status ? ` ${r.http_status}` : ''}</div>`, fieldLabel(r.field), `${badge(r.effective_status)}${r.effective_status !== r.status ? `<div class="small muted">raw: ${esc(r.status)}</div>` : ''}`, String(r.confidence), `<span class="wrap">${esc(r.expected)}</span>`, `<span class="wrap">${esc(r.found)}</span>`, `<span class="small">${esc(r.reason || '')}</span>`, filter === 'action' ? esc(suggestion(r)) : qaForm(r)]))}</div>`);
}

function citationPage(id, runId) {
  const c = get('SELECT * FROM citations WHERE id = ?', [id]);
  if (!c) return null;
  const snap = runId ? get('SELECT * FROM snapshots WHERE citation_id = ? AND run_id = ?', [id, runId]) : get('SELECT * FROM snapshots WHERE citation_id = ? ORDER BY fetched_at DESC LIMIT 1', [id]);
  const client = get('SELECT * FROM clients WHERE id = ?', [c.client_id]);
  const extracted = snap?.extracted_json ? JSON.parse(snap.extracted_json) : null;
  return layout('Evidence', `<h1>Evidence · ${esc(c.directory)}</h1><div class="card"><p>${ext(c.url)}<br><span class="muted small">${link(`/client/${client.slug}`, client.name)} · discovered ${esc(c.discovered_at.slice(0, 10))} via ${esc(c.discovered_via)}${runId ? ` · ${link(`/run/${runId}`, 'back to run')}` : ''}</span></p>
${snap ? `<p class="small">Fetched ${esc(snap.fetched_at)} · method <b>${esc(snap.fetch_method)}</b> · HTTP ${esc(snap.http_status ?? '–')} · extraction confidence ${esc(snap.extraction_confidence ?? '–')}${snap.error ? ` · <span style="color:var(--red)">${esc(snap.error)}</span>` : ''}</p>` : '<p class="muted">No snapshot yet.</p>'}</div>
${extracted ? `<h2>Extracted by Claude</h2><div class="card"><pre class="log" style="background:#f3f4f6;color:#111">${esc(JSON.stringify(extracted, null, 2))}</pre></div>` : ''}
${snap?.text_excerpt ? `<h2>Page text excerpt</h2><div class="card"><pre class="log" style="background:#f3f4f6;color:#111">${esc(snap.text_excerpt)}</pre></div>` : ''}`);
}

// Turn a raw job error into something a non-developer can act on.
function friendlyJobError(j) {
  const m = j.error || '';
  if (/authentication|invalid x-api-key|401/i.test(m)) return 'Your Claude API key was rejected. Create a new one at console.anthropic.com and update ANTHROPIC_API_KEY.';
  if (/credit balance|billing|402/i.test(m)) return 'Your Anthropic account is out of credit. Add a balance at console.anthropic.com under Billing.';
  if (/rate|429/i.test(m)) return 'Rate limited. Wait a minute and try again.';
  if (/daily .* cap/i.test(m)) return 'The daily Claude limit was reached. Raise DAILY_CLAUDE_CALLS or DAILY_COST_LIMIT_USD, or wait for the reset at midnight UTC.';
  if (/GOOGLE_PLACES_API_KEY/i.test(m)) return 'The Google Places key is missing. Add GOOGLE_PLACES_API_KEY, or type the facts in by hand.';
  if (/Places (searchText|details)/i.test(m)) return 'Google Places rejected the request. Check that "Places API (New)" is enabled and the key has no referrer restriction.';
  if (/found nothing/i.test(m)) return 'Google could not find that business. Try the full name plus city and state, or paste a Place ID instead.';
  if (/Could not fetch/i.test(m)) return 'The website could not be read. Check the address, or enter the facts by hand.';
  if (/discovery provider/i.test(m)) return 'The search provider failed. Add GOOGLE_CSE_KEY and GOOGLE_CSE_CX for reliable discovery.';
  if (/Canonical facts incomplete/i.test(m)) return 'Set the canonical name and phone before running an audit.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(m)) return 'A network request failed. Check the address and try again.';
  return 'The job failed. The technical detail is below.';
}

function jobPage(id) {
  const j = jobs.get(id);
  if (!j) return null;
  let next = '';
  if (j.done && !j.error) {
    if (j.kind === 'audit' && j.result?.id) next = `<p><a class="btn" href="/run/${j.result.id}">Open run → QA queue</a></p>`;
    else if (j.kind === 'report' && j.result?.location) next = `<p>${j.result.kind === 'google-sheet' ? `<a class="btn" href="${esc(j.result.location)}" target="_blank">Open Google Sheet</a>` : `CSV written to <code>${esc(j.result.location.replace(config.reportsDir, 'reports'))}</code>`}</p>`;
    else next = `<p><a class="btn" href="/client/${j.slug}">Back to client</a></p>`;
  }
  const errBox = j.error ? `<div class="notice error"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${esc(friendlyJobError(j))}</b><div class="detail">${esc(j.error)}</div></div>` : '';
  return layout(`${j.kind} job`, `${errBox}<h1>${esc(j.kind)} · ${link(`/client/${j.slug}`, j.slug)} ${j.done ? (j.error ? '<span class="badge conflict">failed</span>' : '<span class="badge consistent">done</span>') : '<span class="badge">running…</span>'}</h1>
<pre class="log" id="log">${esc(j.log.join('\n'))}</pre>${next}
<script>const done=${j.done};if(!done){const t=setInterval(async()=>{const r=await fetch('/job/${id}/log');const j=await r.json();document.getElementById('log').textContent=j.log.join('\\n');if(j.done){clearInterval(t);location.reload()}},1500)}</script>`);
}


function setupPage(result) {
  const icon = { ok: '<span class="badge consistent">OK</span>', warn: '<span class="badge unable_to_verify">Optional</span>', fail: '<span class="badge conflict">Blocking</span>' };
  const rows = (result?.checks || []).map(c => [icon[c.status], `<b>${esc(c.name)}</b>`, `<span class="wrap">${esc(c.detail)}</span>${c.fix ? `<div class="small muted">${esc(c.fix)}</div>` : ''}`]);
  return layout('Setup check', `<h1>Setup check</h1>
<div class="card"><p class="muted small">Confirms each key actually works, including one real (about $0.001) Claude call. Run it after changing anything in Render → Environment.</p>
<p class="actions"><form method="post" action="/setup/run" class="inline"><button>Run the check</button></form> <a class="btn secondary" href="/">Back to clients</a></p></div>
${result ? `<div class="card">${table(['', 'Check', 'Result'], rows)}
<p class="small muted">${result.blocking ? `<b style="color:var(--red)">${result.blocking} blocking problem(s).</b> Items marked Optional can be left as they are.` : 'No blocking problems. You can add a client and run an audit.'}</p></div>` : ''}`);
}

// ---------- actions ----------
// Plain-English reason the typed value can't be used, or null when it's fine.
function validateCanonical(field, parsed, raw) {
  switch (field) {
    case 'phone':
      return normPhone(raw) && normPhone(raw).length === 10 ? null : `"${raw}" is not a 10-digit US phone number. Example: (208) 375-6653`;
    case 'website':
      return /^(https?:\/\/)?[^\s.]+\.[^\s]+$/i.test(raw) ? null : `"${raw}" is not a web address. Example: https://anvilfence.com`;
    case 'year_founded':
      return Number.isInteger(parsed) && parsed >= 1800 && parsed <= new Date().getFullYear()
        ? null : `"${raw}" is not a year between 1800 and now. Example: 1958`;
    case 'address': {
      const a = parsed || {};
      if (!a.street || !a.city || !a.state) return `"${raw}" is missing part of the address. Use: street, city, ST ZIP — for example 106 E 46th Pl, Garden City, ID 83714`;
      return null;
    }
    case 'hours':
      return typeof parsed === 'object' && parsed
        ? null : `"${raw}" could not be read as hours. Example: Mon-Fri: 8am-5pm; Sat: Closed; Sun: Closed`;
    case 'services':
    case 'categories':
      return Array.isArray(parsed) && parsed.length ? null : `Enter at least one item, separated by commas. Example: Wood fence, Vinyl fence, Chain link`;
    case 'email':
      return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(raw) ? null : `"${raw}" is not an email address.`;
    default:
      return null;
  }
}

function parseCanonicalInput(field, raw) {
  const v = raw.trim();
  if (!v) return null;
  switch (field) {
    case 'address': return parseAddress(v);
    case 'hours': return normHours(v) || v;
    case 'services': case 'categories': return normServices(v);
    case 'year_founded': return parseInt(v, 10) || v;
    default: return v;
  }
}

function notFoundPage(what, backHref = '/', backText = 'Back to clients') {
  return layout('Not found', `<h1>Not found</h1><div class="card"><p>${esc(what)}</p><p class="muted small">If this used to work, the server may have restarted. On a free host the database is wiped on restart, so clients and audits have to be re-created.</p><p><a class="btn" href="${esc(backHref)}">${esc(backText)}</a></p></div>`);
}

async function handle(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  setNotice(takeFlash(url.searchParams.get('m')));
  const html = (s, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
  const redirect = (to, flashId) => { res.writeHead(303, { Location: withFlash(to, flashId) }); res.end(); };
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  // Send the user back where they came from with a closable message.
  const bounce = (to, kind, title, detail = '') => redirect(to, flash(kind, title, detail));
  let mm;

  if (m === 'GET') {
    if (p === '/') return html(homePage());
    if ((mm = p.match(/^\/client\/([\w-]+)$/))) {
      if (!get('SELECT id FROM clients WHERE slug = ?', [mm[1]])) return html(notFoundPage(`There is no client called "${mm[1]}".`), 404);
      return html(clientPage(mm[1]));
    }
    if ((mm = p.match(/^\/run\/([\w-]+)$/))) { const pg = runPage(mm[1], url.searchParams.get('filter') || 'qa'); return pg ? html(pg) : html(notFoundPage('That audit run no longer exists.'), 404); }
    if ((mm = p.match(/^\/citation\/([\w-]+)$/))) { const pg = citationPage(mm[1], url.searchParams.get('run')); return pg ? html(pg) : html(notFoundPage('That profile is no longer in the inventory.'), 404); }
    if ((mm = p.match(/^\/job\/([\w-]+)\/log$/))) { const j = jobs.get(mm[1]); return j ? json({ log: j.log, done: j.done, error: j.error }) : json({ log: ['unknown job'], done: true }); }
    if ((mm = p.match(/^\/job\/([\w-]+)$/))) { const pg = jobPage(mm[1]); return pg ? html(pg) : html(notFoundPage('That job is no longer in memory, which usually means the server restarted.'), 404); }
    if (p === '/db/download') { getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="citation-audit.sqlite"' }); return res.end(readFileSync(config.dbPath)); }
    if (p === '/health') return json({ ok: true });
    if (p === '/setup') return html(setupPage(null));
    return html(notFoundPage(`No page at ${p}.`), 404);
  }

  if (m === 'POST') {
    let f;
    try { f = Object.fromEntries(new URLSearchParams(body)); }
    catch { return bounce('/', 'error', 'That form could not be read', 'Please try again.'); }
    if (p === '/setup/run') {
      try {
        const result = await diagnose();
        return html(setupPage(result));
      } catch (e) {
        setNotice({ kind: 'error', title: 'The setup check itself failed', detail: e.stack || e.message });
        return html(setupPage(null));
      }
    }
    if (p === '/client/add') {
      const rawSlug = (f.slug || '').trim();
      const slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!f.name?.trim()) return bounce('/', 'error', 'Business name is required', 'Enter the name exactly as it should appear on directories, for example "Anvil Fence Company".');
      if (!slug) return bounce('/', 'error', 'A slug is required', rawSlug ? `"${rawSlug}" has no letters or numbers to use. A slug is a short id like "anvilfence".` : 'A slug is a short id like "anvilfence". It is only used in the URL.');
      if (get('SELECT id FROM clients WHERE slug = ?', [slug])) return bounce('/', 'error', `The slug "${slug}" is already taken`, 'Pick a different short id, or open the existing client from the list above.');
      if (f.website?.trim() && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(f.website.trim())) return bounce('/', 'error', 'That website address does not look valid', `Received "${f.website.trim()}". Include the full address, for example https://anvilfence.com`);
      const isPlaceId = /^ChIJ|^[A-Za-z0-9_-]{20,}$/.test(f.lookup || '');
      insert('clients', { id: uuid(), slug, name: f.name.trim(), website: f.website?.trim() || null, place_id: isPlaceId ? f.lookup.trim() : null, sheet_id: null, created_at: now(), updated_at: now() });
      schedulePersist();
      if (f.lookup && !isPlaceId) {
        if (!config.placesKey) return bounce(`/client/${slug}`, 'warn', 'Client added, but the Google lookup was skipped', 'GOOGLE_PLACES_API_KEY is not set, so the business could not be looked up. Enter the name, address and phone by hand in the table below, or add the key and use "Refresh canonical facts".');
        const client = getClient(slug);
        const j = startJob('canonical', slug, log => refreshCanonical(client, { log, lookup: f.lookup.trim() }));
        return redirect(`/job/${j.id}`);
      }
      return bounce(`/client/${slug}`, 'ok', `Added ${f.name.trim()}`, 'Next: set the canonical facts below, either with "Refresh canonical facts" or by typing them into the Override column.');
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/set$/))) {
      const client = getClient(mm[1]);
      if (f.website?.trim() && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(f.website.trim())) return bounce(`/client/${client.slug}`, 'error', 'That website address does not look valid', `Received "${f.website.trim()}". Include the full address, for example https://anvilfence.com`);
      update('clients', client.id, { website: f.website?.trim() || null, place_id: f.place_id?.trim() || null, updated_at: now() });
      schedulePersist();
      if (f.lookup?.trim() && !f.place_id?.trim()) { const j = startJob('canonical', client.slug, log => refreshCanonical(getClient(client.slug), { log, lookup: f.lookup.trim() })); return redirect(`/job/${j.id}`); }
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical$/))) {
      const client = getClient(mm[1]);
      const field = f.field;
      if (![...AUDIT_FIELDS, ...PHASE2_FIELDS].includes(field)) return bounce(`/client/${client.slug}`, 'error', 'Unknown field', `"${field}" is not one of the audited fields.`);
      const raw = (f.value || '').trim();
      if (!raw) return bounce(`/client/${client.slug}`, 'warn', 'Nothing was saved', 'The value box was empty. Type the correct value next to the field, then press Set.');
      const v = parseCanonicalInput(field, raw);
      const problem = validateCanonical(field, v, raw);
      if (problem) return bounce(`/client/${client.slug}`, 'error', `That ${fieldLabel(field).toLowerCase()} could not be used`, problem);
      setCanonical(client.id, field, v, 'manual', null, { force: true });
      schedulePersist();
      return bounce(`/client/${client.slug}`, 'ok', `${fieldLabel(field)} saved`, `Now set to: ${displayCanonical(field, v)}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical\/clear$/))) {
      const client = getClient(mm[1]);
      getDb().prepare('DELETE FROM canonical_facts WHERE client_id = ? AND field = ? AND source = ?').run(client.id, f.field, 'manual');
      schedulePersist();
      return bounce(`/client/${client.slug}`, 'ok', `Manual ${fieldLabel(f.field).toLowerCase()} removed`, 'Use "Refresh canonical facts" to pull it from Google or the website again.');
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical\/refresh$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return bounce(`/client/${client.slug}`, 'warn', 'Something is already running for this client', 'Wait for it to finish, then try again.');
      if (!client.place_id && !client.website) return bounce(`/client/${client.slug}`, 'error', 'Nothing to refresh from', 'Add a website address or a Google Place ID first, using the Save row below. Or type the facts in by hand.');
      if (!config.anthropicKey && client.website) return bounce(`/client/${client.slug}`, 'error', 'Claude API key is not set', 'Reading the website needs ANTHROPIC_API_KEY. Add it in your host\u2019s environment settings, then run the setup check.');
      const j = startJob('canonical', client.slug, log => refreshCanonical(client, { log }));
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/discover$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return bounce(`/client/${client.slug}`, 'warn', 'Something is already running for this client', 'Wait for it to finish, then try again.');
      if (!getCanonical(client.id).name) return bounce(`/client/${client.slug}`, 'error', 'Set the business name first', 'Discovery searches for the canonical business name. Set it in the table below, then try again.');
      const j = startJob('discover', client.slug, async log => { const canon = getCanonical(client.id); if (!canon.name) log('No canonical name yet — using client name only. Refresh canonical facts first for better queries.'); const r = await discover(client, canon, { log }); log(`Discovery done: ${r.queries} queries, ${r.seen} results, ${r.added} new profiles`); return r; });
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/audit$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return bounce(`/client/${client.slug}`, 'warn', 'Something is already running for this client', 'Wait for it to finish, then try again.');
      const canon = getCanonical(client.id);
      const missing = ['name', 'phone'].filter(k => !canon[k]);
      if (missing.length) return bounce(`/client/${client.slug}`, 'error', `Set the ${missing.map(fieldLabel).join(' and ').toLowerCase()} first`, 'An audit compares every profile against the canonical name and phone, so both are required. Fill them in below, or use "Refresh canonical facts".');
      const rawLimit = (f.limit || '').trim();
      if (rawLimit && !/^\d+$/.test(rawLimit)) return bounce(`/client/${client.slug}`, 'error', 'The limit must be a whole number', `Received "${rawLimit}". Leave it empty to audit every stored profile.`);
      const limit = rawLimit ? parseInt(rawLimit, 10) : Infinity;
      if (rawLimit && limit < 1) return bounce(`/client/${client.slug}`, 'error', 'The limit must be at least 1', 'Leave it empty to audit every stored profile.');
      if (!config.anthropicKey) return bounce(`/client/${client.slug}`, 'error', 'Claude API key is not set', 'Auditing reads each profile with Claude. Add ANTHROPIC_API_KEY in your host\u2019s environment settings, then run the setup check.');
      const u = usageToday();
      if (u.calls >= u.calls_limit || u.cost >= u.cost_limit) return bounce(`/client/${client.slug}`, 'error', 'Daily Claude limit already reached', `Used ${u.calls} of ${u.calls_limit} calls and $${u.cost.toFixed(3)} of $${u.cost_limit.toFixed(2)}. Raise DAILY_CLAUDE_CALLS or DAILY_COST_LIMIT_USD in your host\u2019s environment settings, or wait for the reset at midnight UTC.`);
      const j = startJob('audit', client.slug, log => runAudit(client, { log, rediscover: f.rediscover === '1', limit }));
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/citation\/add$/))) {
      const client = getClient(mm[1]);
      const raw = (f.url || '').trim();
      if (!raw) return bounce(`/client/${client.slug}`, 'warn', 'Nothing was added', 'Paste the full address of the profile page, for example https://www.yelp.com/biz/anvil-fence');
      const c = classifyUrl(raw, null);
      if (!c) return bounce(`/client/${client.slug}`, 'error', 'That does not look like a web address', `Received "${raw}". It needs to start with http:// or https://`);
      const r = addCitation(client.id, raw, c.directory || c.host, 'manual');
      schedulePersist();
      return r.created
        ? bounce(`/client/${client.slug}`, 'ok', `Added a ${c.directory || c.host} profile`, 'It will be checked on the next audit.')
        : bounce(`/client/${client.slug}`, 'warn', 'That profile was already in the inventory', 'Nothing was changed.');
    }
    if ((mm = p.match(/^\/citation\/([\w-]+)\/status$/))) {
      const c = get('SELECT * FROM citations WHERE id = ?', [mm[1]]);
      if (!c) return html(notFoundPage('That profile is no longer in the inventory.'), 404);
      const client = get('SELECT slug FROM clients WHERE id = ?', [c.client_id]);
      if (!['active', 'ignored', 'not_client', 'dead'].includes(f.status)) return bounce(`/client/${client.slug}`, 'error', 'Unknown status', `"${f.status}" is not a valid status.`);
      update('citations', c.id, { status: f.status });
      schedulePersist();
      return bounce(`/client/${client.slug}`, 'ok', `Marked as ${f.status.replace('_', ' ')}`, f.status === 'active' ? 'It will be checked on the next audit.' : 'It will be skipped on future audits but kept for the record.');
    }
    if ((mm = p.match(/^\/finding\/([\w-]+)\/qa$/))) {
      const fi = get('SELECT * FROM findings WHERE id = ?', [mm[1]]);
      if (!fi) return html(notFoundPage('That finding no longer exists.'), 404);
      if (!['confirm', 'dismiss', 'correct'].includes(f.decision)) return bounce(`/run/${fi.run_id}`, 'error', 'Pick a decision first', 'Choose Confirm, Dismiss, or Correct from the dropdown, then press Save.');
      if (f.decision === 'correct' && !['conflict', 'consistent', 'unable_to_verify'].includes(f.corrected_status)) return bounce(`/run/${fi.run_id}`, 'error', 'Pick the corrected status', 'When correcting a finding, choose what the status should be from the second dropdown.');
      const existing = get('SELECT id FROM qa_decisions WHERE finding_id = ?', [fi.id]);
      const row = { decision: f.decision, corrected_status: f.decision === 'correct' ? f.corrected_status : null, reviewer: f.reviewer || 'qa-ui', note: f.note || null, decided_at: now() };
      if (existing) update('qa_decisions', existing.id, row); else insert('qa_decisions', { id: uuid(), finding_id: fi.id, ...row });
      schedulePersist();
      return bounce(`/run/${fi.run_id}?filter=${url.searchParams.get('filter') || 'qa'}`, 'ok', 'Review saved', f.decision === 'dismiss' ? 'This finding is now excluded from the client report.' : f.decision === 'correct' ? `Status changed to ${String(f.corrected_status).replace('_', ' ')}.` : 'Confirmed, so it will appear on the client report.');
    }
    if ((mm = p.match(/^\/run\/([\w-]+)\/report$/))) {
      const run = runById(mm[1]);
      if (!run) return html(notFoundPage('That audit run no longer exists.'), 404);
      const client = get('SELECT * FROM clients WHERE id = ?', [run.client_id]);
      if (busy(client.slug)) return bounce(`/run/${run.id}`, 'warn', 'Something is already running for this client', 'Wait for it to finish, then try again.');
      if (!run.finished_at) return bounce(`/run/${run.id}`, 'warn', 'That audit has not finished yet', 'Wait for it to complete, then generate the report.');
      const j = startJob('report', client.slug, async log => { log(`Building 3-tab report for run ${run.id}…`); const r = await writeReport(run, client); log(`${r.kind}: ${r.location}`); return r; });
      return redirect(`/job/${j.id}`);
    }
  }
  html(notFoundPage(`No page at ${p}.`), 404);
}

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  return Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':') === PASSWORD;
}

await restore().catch(e => console.error('[persist] restore failed:', e.message));
getDb();
createServer((req, res) => {
  // /health must stay open: platform health checks send no credentials, and a 401 there fails the deploy.
  const isHealth = (req.url || '').split('?')[0] === '/health';
  if (!isHealth && !authorized(req)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="citation-audit"' }); return res.end('auth required'); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => handle(req, res, body).catch(e => {
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
    setNotice({ kind: 'error', title: 'Something went wrong on that page', detail: e.stack || e.message });
    res.end(layout('Error', `<h1>Unexpected error</h1><div class="card"><p>The action did not complete. The technical detail is in the box above; send it over if it keeps happening.</p><p><a class="btn" href="/">Back to clients</a></p></div>`));
  }));
}).listen(PORT, () => console.log(`Citation Audit UI → http://localhost:${PORT}`));
process.on('SIGTERM', async () => { await persistNow(); process.exit(0); });
