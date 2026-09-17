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
import { parseAddress, normHours, normServices } from './compare/normalize.js';
import { restore, schedulePersist, persistNow, enabled as persistEnabled } from './persist.js';
import { usageToday } from './extract/claude.js';

const PORT = process.env.PORT || config.qaPort;
const PASSWORD = process.env.APP_PASSWORD;

// ---------- jobs (in-process, polled by the browser) ----------
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
`;

function layout(title, body, { refresh } = {}) {
  const u = usageToday();
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · Citation Audit</title><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head>
<body><header><a class="brand" href="/">Citation Audit</a><span class="muted">NAP + key-fact consistency checker</span><span style="flex:1"></span><span class="muted small" title="Daily caps reset at midnight UTC">Claude today: ${u.calls}/${u.calls_limit} calls · $${u.cost.toFixed(3)}/$${u.cost_limit.toFixed(2)}</span><span class="muted small">discovery: ${esc(config.discoveryProvider)} · model: ${esc(config.model)} · output: ${config.serviceAccountJson ? 'Google Sheets' : 'CSV (no service account)'}${persistEnabled ? ' · db→GitHub' : ''}</span></header><main>${body}</main></body></html>`;
}

// ---------- pages ----------
function homePage() {
  const clients = all('SELECT * FROM clients ORDER BY name');
  const rows = clients.map(c => {
    const run = latestRun(c.id);
    const inv = get("SELECT COUNT(*) n FROM citations WHERE client_id = ? AND status = 'active'", [c.id]).n;
    return [link(`/client/${c.slug}`, c.name), c.website ? ext(c.website, c.website.replace(/^https?:\/\//, '')) : '', String(inv), run ? `${link(`/run/${run.id}`, run.started_at.slice(0, 10))} · ${run.conflicts} conflict / ${run.unverified} unverified` : '<span class="muted">never</span>'];
  });
  return layout('Clients', `<h1>Clients</h1><div class="card">${table(['Client', 'Website', 'Known profiles', 'Last audit'], rows)}</div>
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

function jobPage(id) {
  const j = jobs.get(id);
  if (!j) return null;
  let next = '';
  if (j.done && !j.error) {
    if (j.kind === 'audit' && j.result?.id) next = `<p><a class="btn" href="/run/${j.result.id}">Open run → QA queue</a></p>`;
    else if (j.kind === 'report' && j.result?.location) next = `<p>${j.result.kind === 'google-sheet' ? `<a class="btn" href="${esc(j.result.location)}" target="_blank">Open Google Sheet</a>` : `CSV written to <code>${esc(j.result.location.replace(config.reportsDir, 'reports'))}</code>`}</p>`;
    else next = `<p><a class="btn" href="/client/${j.slug}">Back to client</a></p>`;
  }
  return layout(`${j.kind} job`, `<h1>${esc(j.kind)} · ${link(`/client/${j.slug}`, j.slug)} ${j.done ? (j.error ? '<span class="badge conflict">failed</span>' : '<span class="badge consistent">done</span>') : '<span class="badge">running…</span>'}</h1>
<pre class="log" id="log">${esc(j.log.join('\n'))}</pre>${next}
<script>const done=${j.done};if(!done){const t=setInterval(async()=>{const r=await fetch('/job/${id}/log');const j=await r.json();document.getElementById('log').textContent=j.log.join('\\n');if(j.done){clearInterval(t);location.reload()}},1500)}</script>`);
}

// ---------- actions ----------
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

async function handle(req, res, body) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname, m = req.method;
  const html = (s, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(s); };
  const redirect = to => { res.writeHead(303, { Location: to }); res.end(); };
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  let mm;

  if (m === 'GET') {
    if (p === '/') return html(homePage());
    if ((mm = p.match(/^\/client\/([\w-]+)$/))) return html(clientPage(mm[1]));
    if ((mm = p.match(/^\/run\/([\w-]+)$/))) { const pg = runPage(mm[1], url.searchParams.get('filter') || 'qa'); return pg ? html(pg) : html('not found', 404); }
    if ((mm = p.match(/^\/citation\/([\w-]+)$/))) { const pg = citationPage(mm[1], url.searchParams.get('run')); return pg ? html(pg) : html('not found', 404); }
    if ((mm = p.match(/^\/job\/([\w-]+)\/log$/))) { const j = jobs.get(mm[1]); return j ? json({ log: j.log, done: j.done, error: j.error }) : json({ log: ['unknown job'], done: true }); }
    if ((mm = p.match(/^\/job\/([\w-]+)$/))) { const pg = jobPage(mm[1]); return pg ? html(pg) : html('job not found (server restarted?)', 404); }
    if (p === '/db/download') { getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="citation-audit.sqlite"' }); return res.end(readFileSync(config.dbPath)); }
    if (p === '/health') return json({ ok: true });
    return html('not found', 404);
  }

  if (m === 'POST') {
    const f = Object.fromEntries(new URLSearchParams(body));
    if (p === '/client/add') {
      const slug = (f.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!slug || !f.name) return html('slug and name required', 400);
      if (get('SELECT id FROM clients WHERE slug = ?', [slug])) return html('slug exists', 400);
      const isPlaceId = /^ChIJ|^[A-Za-z0-9_-]{20,}$/.test(f.lookup || '');
      insert('clients', { id: uuid(), slug, name: f.name.trim(), website: f.website?.trim() || null, place_id: isPlaceId ? f.lookup.trim() : null, sheet_id: null, created_at: now(), updated_at: now() });
      schedulePersist();
      if (f.lookup && !isPlaceId) { const client = getClient(slug); const j = startJob('canonical', slug, log => refreshCanonical(client, { log, lookup: f.lookup.trim() })); return redirect(`/job/${j.id}`); }
      return redirect(`/client/${slug}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/set$/))) {
      const client = getClient(mm[1]);
      update('clients', client.id, { website: f.website?.trim() || null, place_id: f.place_id?.trim() || null, updated_at: now() });
      schedulePersist();
      if (f.lookup?.trim() && !f.place_id?.trim()) { const j = startJob('canonical', client.slug, log => refreshCanonical(getClient(client.slug), { log, lookup: f.lookup.trim() })); return redirect(`/job/${j.id}`); }
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical$/))) {
      const client = getClient(mm[1]);
      const v = parseCanonicalInput(f.field, f.value || '');
      if (v != null) { setCanonical(client.id, f.field, v, 'manual', null, { force: true }); schedulePersist(); }
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical\/clear$/))) {
      const client = getClient(mm[1]);
      getDb().prepare('DELETE FROM canonical_facts WHERE client_id = ? AND field = ? AND source = ?').run(client.id, f.field, 'manual');
      schedulePersist();
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical\/refresh$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return redirect(`/client/${client.slug}`);
      const j = startJob('canonical', client.slug, log => refreshCanonical(client, { log }));
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/discover$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return redirect(`/client/${client.slug}`);
      const j = startJob('discover', client.slug, async log => { const canon = getCanonical(client.id); if (!canon.name) log('No canonical name yet — using client name only. Refresh canonical facts first for better queries.'); const r = await discover(client, canon, { log }); log(`Discovery done: ${r.queries} queries, ${r.seen} results, ${r.added} new profiles`); return r; });
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/audit$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return redirect(`/client/${client.slug}`);
      const j = startJob('audit', client.slug, log => runAudit(client, { log, rediscover: f.rediscover === '1', limit: parseInt(f.limit, 10) || Infinity }));
      return redirect(`/job/${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/citation\/add$/))) {
      const client = getClient(mm[1]);
      const c = classifyUrl(f.url || '', null);
      if (c) { addCitation(client.id, f.url.trim(), c.directory || c.host, 'manual'); schedulePersist(); }
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/citation\/([\w-]+)\/status$/))) {
      const c = get('SELECT * FROM citations WHERE id = ?', [mm[1]]);
      if (c && ['active', 'ignored', 'not_client', 'dead'].includes(f.status)) { update('citations', c.id, { status: f.status }); schedulePersist(); }
      const client = get('SELECT slug FROM clients WHERE id = ?', [c.client_id]);
      return redirect(`/client/${client.slug}`);
    }
    if ((mm = p.match(/^\/finding\/([\w-]+)\/qa$/))) {
      const fi = get('SELECT * FROM findings WHERE id = ?', [mm[1]]);
      if (!fi) return html('not found', 404);
      const existing = get('SELECT id FROM qa_decisions WHERE finding_id = ?', [fi.id]);
      const row = { decision: f.decision, corrected_status: f.decision === 'correct' ? f.corrected_status : null, reviewer: f.reviewer || 'qa-ui', note: f.note || null, decided_at: now() };
      if (existing) update('qa_decisions', existing.id, row); else insert('qa_decisions', { id: uuid(), finding_id: fi.id, ...row });
      schedulePersist();
      return redirect(`/run/${fi.run_id}?filter=${url.searchParams.get('filter') || 'qa'}`);
    }
    if ((mm = p.match(/^\/run\/([\w-]+)\/report$/))) {
      const run = runById(mm[1]);
      const client = get('SELECT * FROM clients WHERE id = ?', [run.client_id]);
      if (busy(client.slug)) return redirect(`/run/${run.id}`);
      const j = startJob('report', client.slug, async log => { log(`Building 3-tab report for run ${run.id}…`); const r = await writeReport(run, client); log(`${r.kind}: ${r.location}`); return r; });
      return redirect(`/job/${j.id}`);
    }
  }
  html('not found', 404);
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
  req.on('end', () => handle(req, res, body).catch(e => { console.error(e); res.writeHead(500, { 'Content-Type': 'text/html' }); res.end(layout('Error', `<h1>Error</h1><pre class="log">${esc(e.stack || e.message)}</pre>`)); }));
}).listen(PORT, () => console.log(`Citation Audit UI → http://localhost:${PORT}`));
process.on('SIGTERM', async () => { await persistNow(); process.exit(0); });
