#!/usr/bin/env node
// Web UI: client setup → canonical facts → discovery → audit → QA queue → Google Sheet. Zero front-end deps.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { config, AUDIT_FIELDS, PHASE2_FIELDS } from './config.js';
import { all, get, insert, update, uuid, now, getClient, getCanonical, setCanonical, getDb, transaction, getPrevious, parsePreviousInput } from './db.js';
import { refreshCanonical, runAudit, effectiveFindings, latestRun, suggestion, displayCanonical, gbpCheck, gbpSuggestion } from './audit.js';
import { discover, addCitation, inventory } from './discovery/index.js';
import { classifyUrl } from './discovery/directories.js';
import { writeReport, runById, reportFiles, reportFile } from './report/sheets.js';
import { parseAddress, normHours, normServices, normPhone } from './compare/normalize.js';
import { restore, schedulePersist, persistNow, enabled as persistEnabled } from './persist.js';
import { usageToday, resetUsageToday, nextResetAt } from './extract/claude.js';
import { proxyUsage, refreshProxyUsage, enabled as proxyEnabled } from './proxyUsage.js';
import { diagnose } from './diagnose.js';

const PORT = process.env.PORT || config.qaPort;
const PASSWORD = process.env.APP_PASSWORD;
// The Google Business Profile link is always stored on the client, so pasting it once
// keeps it. Reading facts *from* that profile needs the Places API, which needs Google
// Cloud billing; that half stays dormant until GOOGLE_PLACES_API_KEY is set.
const GBP_READS = Boolean(config.placesKey);
// Mirrors the auto-prepend in discovery/index.js so the readout matches what runs.
function effectiveChain() {
  const chain = String(config.discoveryProvider).split(',').map(x => x.trim()).filter(Boolean);
  const viaScraper = config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key);
  return (viaScraper && !chain.includes('scraperapi-google') ? ['scraperapi-google', ...chain] : chain).join(',');
}
// The bar shows only what runs first; the full chain is on the setup page.
const PROVIDER_NAMES = { 'scraperapi-google': 'Google via ScraperAPI', 'google-cse': 'Google Custom Search', ddg: 'DuckDuckGo', serpapi: 'SerpAPI' };
function primaryProvider() { const first = effectiveChain().split(',')[0]; return PROVIDER_NAMES[first] || first; }
const STARTED = new Date().toISOString();

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

// Adding a client and then clicking three buttons is busywork. This runs the whole
// pipeline once: read the source of truth, find profiles, audit them, build the report.
// Each stage is allowed to fall short without losing the stages before it.
async function firstRun(slug, log) {
  const out = {};
  log('Step 1 of 3 — reading the source of truth');
  try {
    await refreshCanonical(getClient(slug), { log, lookup: config.placesKey ? getClient(slug).gbp_url : null });
    out.canonical = true;
  } catch (e) {
    log(`  could not read it: ${e.message}`);
    log('  stopping here: an audit needs at least a business name and phone.');
    out.stoppedAt = 'canonical';
    return out;
  }
  const canon = getCanonical(getClient(slug).id);
  if (!canon.name || !canon.phone) {
    log('  the website did not give both a business name and a phone number.');
    log('  fill those in on the client page, then run the audit.');
    out.stoppedAt = 'canonical';
    return out;
  }
  log('');
  log('Step 2 of 3 — finding and checking directory profiles');
  let run;
  try {
    run = await runAudit(getClient(slug), { log });
    out.runId = run.id;
  } catch (e) {
    log(`  ${e.message}`);
    out.stoppedAt = 'audit';
    return out;
  }
  log('');
  log('Step 3 of 3 — building the report');
  try {
    const rep = await writeReport(run, getClient(slug));
    out.report = rep;
    log(`  ${rep.kind === 'google-sheet' ? 'Google Sheet' : 'CSV'}: ${rep.location}`);
  } catch (e) {
    log(`  the report could not be written: ${e.message}`);
    log('  the audit itself is saved; generate the report from the run page.');
    out.stoppedAt = 'report';
  }
  return out;
}

const jobs = new Map();
function startJob(kind, slug, fn) {
  for (const [id, j] of jobs) if (j.done && Date.now() - Date.parse(j.started) > 60 * 60_000) jobs.delete(id);
  const job = { id: uuid(), kind, slug, log: [], done: false, error: null, result: null, started: now() };
  jobs.set(job.id, job);
  const log = m => { job.log.push(m); console.log(`[${slug}] ${m}`); };
  fn(log).then(r => { job.result = r; }).catch(e => { job.error = e.message; log(`ERROR: ${e.message}`); console.error(e); }).finally(() => { job.done = true; schedulePersist(); refreshProxyUsage(true); });
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
:root{
  --paper:#f4f6f8; --sheet:#ffffff; --band:#f0f3f6;
  --ink:#1a2330; --ink-2:#3d4a5c; --muted:#6b7787; --faint:#9aa5b3;
  --rule:#d5dbe3; --rule-soft:#e6eaef;
  --accent:#1f5fbf; --accent-ink:#17488f; --accent-wash:#e8f0fb;
  --ok:#1e7f4f; --ok-wash:#e6f4ec; --bad:#b3261e; --bad-wash:#fbe9e7; --warn:#9a6700; --warn-wash:#fbf3d9;
  --sans:"Public Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --r:4px;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0; min-height:100vh; color:var(--ink); background:var(--paper); font:400 14px/1.5 var(--sans); font-variant-numeric:tabular-nums}

/* ---- top bar: brand, then a row of readouts separated by hairlines ---- */
header{display:flex; align-items:stretch; background:var(--sheet); border-bottom:1px solid var(--rule); position:sticky; top:0; z-index:20}
header > *{display:flex; align-items:center; padding:0 14px; white-space:nowrap}
header > * + *{border-left:1px solid var(--rule-soft)}
header a{color:var(--ink-2); text-decoration:none}
header a:hover{color:var(--accent)}
header .brand{color:var(--ink); font-weight:700; letter-spacing:-.01em; font-size:15px; padding-left:22px; padding-right:18px}
header .grow{flex:1; border-left:0; padding:0}
header .read{font-size:12px; color:var(--muted); gap:5px; padding-top:12px; padding-bottom:12px}
header .read b{color:var(--ink); font-weight:600}
header a.read{text-decoration:none}
header a.read:hover b{color:var(--accent)}
main{max-width:1320px; margin:0 auto; padding:28px 24px 80px}

/* ---- type ---- */
h1{font-size:26px; font-weight:700; letter-spacing:-.02em; line-height:1.2; margin:0 0 18px; color:var(--ink)}
h1 a{color:var(--ink); text-decoration:none}
h1 a:hover{color:var(--accent)}
h1 .muted{font-weight:400; letter-spacing:0; font-size:15px}
/* a section label sits on its own rule, the way a ledger heading does */
h2{font-size:13px; font-weight:600; color:var(--ink); margin:32px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--rule); letter-spacing:.005em}
h2 .muted{font-weight:400}
a{color:var(--accent)}
a:hover{color:var(--accent-ink)}
.muted{color:var(--muted)}
.small{font-size:12px}
code{font-family:var(--mono); font-size:12.5px; color:var(--ink-2); background:var(--band); padding:1px 5px; border-radius:3px}
.mono{font-family:var(--mono); font-size:12.5px}

/* ---- where you are ---- */
.crumb{font-size:12px; color:var(--muted); margin:0 0 6px}
.crumb a{color:var(--muted); text-decoration:none}
.crumb a:hover{color:var(--accent); text-decoration:underline}

/* ---- labelled fields in a row ---- */
form.fields{display:grid; grid-template-columns:minmax(220px,1fr) minmax(260px,1.3fr) auto; gap:14px; align-items:end; margin-top:16px; padding-top:16px; border-top:1px solid var(--rule-soft)}
form.fields .offfield{display:flex; width:100%}
form.fields .offfield input{width:100%}
form.fields .fields-save{display:flex; align-items:center; gap:12px; padding-bottom:1px}
form.fields .fields-previous{grid-column:1 / -1}
form.fields .fields-previous textarea{width:100%; min-height:62px; resize:vertical}
@media (max-width:820px){form.fields{grid-template-columns:1fr}}

/* ---- sheets: a white page on the paper, one rule, no shadow ---- */
.card{background:var(--sheet); border:1px solid var(--rule); border-radius:var(--r); padding:18px 20px; margin-bottom:16px}

/* ---- tables carry the data ---- */
table{width:100%; border-collapse:collapse; font-size:13.5px}
th,td{text-align:left; padding:10px 12px; border-bottom:1px solid var(--rule-soft); vertical-align:top}
th{background:var(--band); color:var(--ink-2); font-weight:600; font-size:12px; white-space:nowrap; border-bottom:1px solid var(--rule); position:sticky; top:45px; z-index:2}
tbody tr:hover td{background:#fafbfc}
tbody tr:last-child td{border-bottom:0}
td{color:var(--ink)}
td b,td strong{font-weight:600}
td.wrap,.wrap{max-width:380px; word-break:break-word}
td a[href^="http"]{color:var(--accent); text-decoration:none}
td a[href^="http"]:hover{text-decoration:underline}
th a{color:var(--ink-2); text-decoration:none}
th a:hover{color:var(--accent)}
th a.sorted{color:var(--ink)}
th a.sorted::after{content:" \\2193"; color:var(--accent)}

/* ---- state indicators ---- */
.badge{display:inline-flex; align-items:center; gap:6px; padding:1px 9px 1px 7px; border-radius:999px; font-size:12px; font-weight:500; line-height:1.7; border:1px solid var(--rule); color:var(--ink-2); background:var(--sheet)}
.badge::before{content:""; width:6px; height:6px; border-radius:50%; background:currentColor; flex:none}
.badge.conflict{color:var(--bad); border-color:#efb8b3; background:var(--bad-wash)}
.badge.consistent{color:var(--ok); border-color:#b6dcc6; background:var(--ok-wash)}
.badge.unable_to_verify{color:var(--warn); border-color:#e6d59a; background:var(--warn-wash)}
.badge.dismissed{color:var(--muted)}
.badge.working{color:var(--accent); border-color:#b9cdf0; background:var(--accent-wash)}
.badge.working::before{width:9px; height:9px; background:none; border:1.5px solid #b9cdf0; border-top-color:var(--accent); animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ---- controls ---- */
button,.btn{font:500 13px var(--sans); cursor:pointer; border-radius:var(--r); padding:7px 14px; text-decoration:none; display:inline-block; color:#fff; background:var(--accent); border:1px solid var(--accent-ink)}
button:hover,.btn:hover{background:var(--accent-ink); color:#fff}
button.secondary,.btn.secondary{background:var(--sheet); color:var(--ink); border:1px solid var(--rule)}
button.secondary:hover,.btn.secondary:hover{border-color:var(--ink-2); background:var(--sheet); color:var(--ink)}
button.danger{background:var(--bad); border-color:#8e1e17}
button.danger:hover{background:#8e1e17}
button:disabled,.btn:disabled{opacity:.45; cursor:default}
.btn.small,button.small{padding:4px 10px; font-size:12px}
input,select,textarea{font:400 13.5px var(--sans); color:var(--ink); background:var(--sheet); border:1px solid var(--rule); border-radius:var(--r); padding:7px 9px}
input::placeholder{color:var(--faint)}
input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible{outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent)}
input[type=text],input[type=url],input[type=number]{width:100%}
select{appearance:none; padding-right:26px; background-image:linear-gradient(45deg,transparent 50%,var(--ink-2) 50%),linear-gradient(135deg,var(--ink-2) 50%,transparent 50%); background-position:calc(100% - 14px) 14px,calc(100% - 9px) 14px; background-size:5px 5px,5px 5px; background-repeat:no-repeat}
label{display:block; font-size:12px; color:var(--muted); margin-bottom:4px}
form.inline{display:inline}
.actions{display:flex; flex-wrap:wrap; gap:9px; align-items:center}
.grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:14px}
.grid.readout{grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:0}

/* ---- the reconciliation summary: the one loud element ---- */
.grid.readout .stat{padding:4px 18px 12px 0; margin-right:18px; border-bottom:2px solid currentColor}
.stat{font-size:40px; font-weight:600; line-height:1.05; letter-spacing:-.02em; color:var(--ink)}
.stat small{display:block; margin-top:8px; font-size:12px; font-weight:400; color:var(--muted); letter-spacing:0}

/* ---- notices ---- */
.notice{position:relative; border:1px solid var(--rule); border-left:3px solid var(--ink-2); border-radius:var(--r); padding:12px 42px 12px 15px; margin:0 0 16px; background:var(--sheet)}
.notice b{display:block; margin-bottom:2px; color:var(--ink); font-weight:600}
.notice .detail{font-size:12.5px; color:var(--ink-2); white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; margin-top:6px; padding-top:8px; border-top:1px solid var(--rule-soft)}
.notice.error{border-left-color:var(--bad); background:var(--bad-wash)}
.notice.error b{color:var(--bad)}
.notice.warn{border-left-color:var(--warn); background:var(--warn-wash)}
.notice.warn b{color:var(--warn)}
.notice.ok{border-left-color:var(--ok); background:var(--ok-wash)}
.notice.ok b{color:var(--ok)}
.notice .x{position:absolute; top:7px; right:9px; background:none; border:0; font-size:18px; line-height:1; color:var(--muted); cursor:pointer; padding:3px 7px}
.notice .x:hover{color:var(--ink); background:none}

/* ---- logs: the one place monospace belongs ---- */
pre.log{background:var(--band); color:var(--ink); border:1px solid var(--rule); border-radius:var(--r); padding:14px 16px; max-height:520px; overflow:auto; font-family:var(--mono); font-size:12.5px; line-height:1.6; white-space:pre-wrap; margin:0 0 14px}
pre.log.live::after{content:"\\2588"; color:var(--accent); animation:blink 1.1s steps(1) infinite; margin-left:1px}
@keyframes blink{50%{opacity:0}}

/* ---- tabs ---- */
.tabs{display:flex; gap:22px; border-bottom:1px solid var(--rule); margin:24px 0 16px; padding:0}
.tabs a{padding:8px 0 9px; color:var(--muted); text-decoration:none; font-size:13.5px; border-bottom:2px solid transparent; margin-bottom:-1px}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--ink); font-weight:600; border-bottom-color:var(--accent)}
.tabs .pdf-btn{margin-left:auto; align-self:center}
.print-only{display:none}
@media print{
  @page{size:landscape; margin:12mm}
  body{background:#fff}
  header,form,button,.notice,.crumb,.no-print,.tabs a:not(.on){display:none!important}
  .print-only{display:block}
  .tabs{border-bottom:none; margin:12px 0 6px}
  .card{box-shadow:none; border:none; padding:0}
  table{font-size:10px}
  tr{break-inside:avoid}
  a{color:inherit; text-decoration:none}
}

/* ---- qa row controls ---- */
.qa form{display:flex; gap:5px; flex-wrap:wrap; align-items:center}
.qa select,.qa input{font-size:12px; padding:4px 7px}
.qa select{padding-right:24px; background-position:calc(100% - 12px) 12px,calc(100% - 7px) 12px}
.qa button{padding:4px 11px; font-size:12px}

/* ---- a section that folds away; the summary line looks like any other section heading ---- */
details.fold{margin:32px 0 0}
details.fold summary{list-style:none; cursor:pointer; font-size:13px; font-weight:600; color:var(--ink); padding-bottom:6px; border-bottom:1px solid var(--rule); margin-bottom:10px; display:flex; align-items:baseline; gap:10px}
details.fold summary::-webkit-details-marker{display:none}
details.fold summary::before{content:"\\25B8"; color:var(--muted); font-size:11px; flex:none; transition:transform .12s}
details.fold[open] summary::before{transform:rotate(90deg)}
details.fold summary .muted{font-weight:400}
details.fold summary:hover{color:var(--accent)}

/* ---- the explanation behind a verdict ---- */
dialog.why{border:1px solid var(--rule); border-radius:var(--r); padding:0; width:min(820px, calc(100vw - 32px)); color:var(--ink); background:var(--sheet); white-space:normal; text-align:left}
dialog.why .why-body{overflow:auto; max-height:70vh}
dialog.why td{white-space:normal}
dialog.why::backdrop{background:rgba(26,35,48,.45)}
dialog.why .why-head{display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-bottom:1px solid var(--rule)}
dialog.why .why-head b{font-size:14px}
dialog.why .why-body{padding:16px 18px}
dialog.why table{font-size:13px}
dialog.why th{position:static}
.nowrap .badge + button{margin-left:6px; vertical-align:middle}

/* ---- a field that is switched off, with its explanation ---- */
.offfield{position:relative; display:inline-flex; align-items:center}
.offfield input{padding-right:30px}
.info{position:absolute; right:8px; width:16px; height:16px; border-radius:50%; border:1px solid var(--rule); color:var(--muted); background:var(--sheet); font:600 11px/14px var(--sans); text-align:center; cursor:help; user-select:none}
.info:hover,.info:focus{border-color:var(--accent); color:var(--accent); outline:none}

/* ---- canonical table: view state vs edit state ---- */
table.canon td:last-child{text-align:right; white-space:nowrap; width:1%}
table.canon .edit{display:none}
table.canon tr.editing .view{display:none}
table.canon tr.editing .edit{display:flex; gap:6px; align-items:center; justify-content:flex-end; flex-wrap:nowrap}
table.canon tr.editing td{background:var(--accent-wash)}
table.canon .edit input[type=text]{width:100%; min-width:220px}
table.canon tr.editing td:nth-child(2){width:52%}
td.nowrap,.nowrap{white-space:nowrap}

@media (max-width:1180px){
  header{flex-wrap:wrap}
  header > *{padding:9px 13px}
  header .grow{display:none}
}
@media (max-width:820px){
  main{padding:18px 15px 56px}
  th{position:static}
  td.wrap,.wrap{max-width:none}
  .stat{font-size:30px}
}
@media (prefers-reduced-motion:reduce){
  *{animation:none!important; transition:none!important}
  .badge.working::before{border-top-color:var(--accent); border-color:var(--accent)}
}
`;

function noticeHtml(f) {
  if (!f) return '';
  const cls = f.kind === 'error' ? 'error' : f.kind === 'ok' ? 'ok' : 'warn';
  return `<div class="notice ${cls}"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${esc(f.title)}</b>${f.detail ? `<div class="detail">${esc(f.detail)}</div>` : ''}</div>`;
}

// Set by the router just before a page renders; layout consumes it exactly once.
let pendingNotice = null;
const setNotice = f => { pendingNotice = f || null; };

function layout(title, body, { refresh } = {}) {
  const u = usageToday();
  refreshProxyUsage();
  const pu = proxyUsage();
  const notice = pendingNotice; pendingNotice = null;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Citation Audit</title><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'> <circle cx='16' cy='16' r='16' fill='%2374d4ff'/> <path d='M9 16.4l4.8 4.9L23 11.4' fill='none' stroke='%230d3b55' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'/> </svg>"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<style>${CSS}</style></head>
<body><header><a class="brand" href="/">Citation Audit</a><a href="/setup" class="small">Setup check</a><span class="grow"></span><a class="read" href="/setup" title="Daily caps reset at midnight UTC. Click for the full setup check.">calls <b>${u.calls}/${u.calls_limit}</b></a><a class="read" href="/setup" title="Daily caps reset at midnight UTC. Click for the full setup check.">spend <b>$${u.cost.toFixed(3)}</b> of $${u.cost_limit.toFixed(2)}</a><a class="read" href="/setup" title="Click for the full setup check">search <b>${esc(primaryProvider())}</b></a>${proxyEnabled() ? `<a class="read" href="/setup" title="ScraperAPI credits left this month. Click for details.">credits <b>${pu ? pu.left.toLocaleString() : '…'}</b>${pu ? ` of ${pu.limit.toLocaleString()}` : ''}</a>` : ''}<a class="read" href="/setup" title="Click for the full setup check">reports <b>${config.serviceAccountJson ? 'Google Sheets' : 'CSV'}</b></a><a class="read" href="/setup" title="Click for the full setup check">saved <b>${persistEnabled ? 'to GitHub' : 'until restart'}</b></a></header><main>${noticeHtml(notice)}${body}</main></body></html>`;
}

// ---------- pages ----------
const CLIENT_SORTS = {
  name: { label: 'Client', cmp: (a, b) => a.name.localeCompare(b.name) },
  recent: { label: 'Last audit', cmp: (a, b) => (b.run?.started_at || '').localeCompare(a.run?.started_at || '') },
  conflicts: { label: 'Inconsistencies', cmp: (a, b) => (b.run?.conflicts ?? -1) - (a.run?.conflicts ?? -1) },
  profiles: { label: 'Profiles', cmp: (a, b) => b.inv - a.inv },
};

function homePage(sort = 'name') {
  if (!CLIENT_SORTS[sort]) sort = 'name';
  const clients = all('SELECT * FROM clients').map(c => ({
    ...c,
    run: latestRun(c.id),
    inv: get("SELECT COUNT(*) n FROM citations WHERE client_id = ? AND status = 'active'", [c.id]).n,
  }));
  clients.sort(CLIENT_SORTS[sort].cmp);
  const firstRun = !clients.length;
  const th = key => `<a href="/?sort=${key}" class="${sort === key ? 'sorted' : ''}">${CLIENT_SORTS[key].label}</a>`;
  // What is actually wrong for this client, from its latest audit: which directory,
  // which field, and whether a person still has to look at it.
  const inconsistencies = c => {
    if (!c.run?.finished_at) return '<span class="muted">not audited yet</span>';
    const rows = effectiveFindings(c.run.id).filter(r => r.effective_status === 'conflict');
    if (!rows.length) return `<span class="badge consistent">All matched</span>${c.run.unverified ? `<div class="small muted">${c.run.unverified} could not be read</div>` : ''}`;
    const byDir = new Map();
    for (const r of rows) { if (!byDir.has(r.directory)) byDir.set(r.directory, []); byDir.get(r.directory).push(fieldLabel(r.field).toLowerCase()); }
    const items = [...byDir].map(([d, fields]) => `${d}: ${fields.join(', ')}`);
    const pending = rows.filter(r => r.qa_open).length;
    return `<span class="badge conflict">${byDir.size} mismatched</span>
<div class="small" style="margin-top:4px">${esc(items.slice(0, 4).join('; '))}${items.length > 4 ? `; and ${items.length - 4} more` : ''}</div>
<div class="small muted">${pending ? `${pending} awaiting review. ` : ''}${link(`/run/${c.run.id}?filter=conflicts`, 'See details')}</div>`;
  };
  // Google Business Profile vs the client's own site: the first thing to know about a client.
  const gbpCell = c => {
    if (!GBP_READS) return '<span class="muted small">not connected</span>';
    const check = gbpCheck(c);
    if (!check) return `<span class="muted small">${c.gbp_url ? 'not read yet' : 'no profile linked'}</span>`;
    if (!check.site) return '<span class="muted small">website not read</span>';
    const bad = check.rows.filter(r => r.status === 'conflict');
    return bad.length ? `<span class="badge conflict">Mismatch</span><div class="small" style="margin-top:4px">${esc(bad.map(r => fieldLabel(r.field).toLowerCase()).join(', '))}</div>` : '<span class="badge consistent">Matches</span>';
  };
  const rows = clients.map(c => [
    link(`/client/${c.slug}`, c.name),
    c.website ? ext(c.website, c.website.replace(/^https?:\/\//, '')) : '',
    gbpCell(c),
    String(c.inv),
    c.run ? link(`/run/${c.run.id}`, c.run.started_at.slice(0, 10)) : '<span class="muted">never</span>',
    inconsistencies(c),
    `<a class="btn secondary small" href="/client/${c.slug}/delete">Delete</a>`,
  ]);
  return layout('Clients', `${firstRun ? '<div class="card"><b>First time here?</b> Run the <a href="/setup">setup check</a> to confirm your keys work, then add a client below.</div>' : ''}<h1>Clients</h1>
<h2>Add a client</h2><div class="card"><form method="post" action="/client/add"><div class="grid">
<div><label>Slug (short id)</label><input type="text" name="slug" required placeholder="anvilfence"></div>
<div><label>Business name</label><input type="text" name="name" required placeholder="Anvil Fence Company"></div>
<div><label>Website</label><input type="url" name="website" placeholder="https://anvilfence.com"></div>
<div><label>Google Business Profile</label><input type="text" name="gbp_url" placeholder="Paste the Google Maps link"></div>
</div><p class="actions"><button>Add client and run the first audit</button>
<label class="inline small muted" style="display:inline-flex; align-items:center; gap:6px"><input type="checkbox" name="autorun" value="1" checked style="width:auto"> run it now</label></p>
<p class="muted small">Running it reads the website for the source of truth, finds directory profiles, checks each one and builds the report. It takes a few minutes and costs a few cents. Untick to add the client and run it later.</p></form></div>
<h2>All clients</h2><div class="card">
${table([th('name'), 'Website', 'Google vs website', th('profiles'), th('recent'), th('conflicts'), ''], rows)}
${clients.length > 1 ? `<p class="muted small" style="margin:10px 0 0">Sorted by ${esc(CLIENT_SORTS[sort].label.toLowerCase())}. Click another heading to change it.</p>` : ''}</div>`);
}

// Everything that belongs to one client, newest dependants first so foreign keys hold.
function clientFootprint(clientId) {
  const n = (sql, p = [clientId]) => get(sql, p).n;
  return {
    citations: n("SELECT COUNT(*) n FROM citations WHERE client_id = ?"),
    runs: n("SELECT COUNT(*) n FROM audit_runs WHERE client_id = ?"),
    files: n("SELECT COUNT(*) n FROM report_files WHERE run_id IN (SELECT id FROM audit_runs WHERE client_id = ?)"),
    findings: n("SELECT COUNT(*) n FROM findings WHERE run_id IN (SELECT id FROM audit_runs WHERE client_id = ?)"),
    facts: n("SELECT COUNT(*) n FROM canonical_facts WHERE client_id = ?"),
  };
}

function deleteClientPage(slug) {
  const client = get('SELECT * FROM clients WHERE slug = ?', [slug]);
  if (!client) return null;
  const f = clientFootprint(client.id);
  return layout(`Delete ${client.name}`, `<h1>Delete ${esc(client.name)}?</h1>
<div class="card"><p>This removes the client and everything recorded for it. It cannot be undone.</p>
${table(['What', 'Count'], [
  ['Known profiles in the inventory', String(f.citations)],
  ['Audit runs and their evidence', String(f.runs)],
  ['Findings and QA decisions', String(f.findings)],
  ['Canonical facts', String(f.facts)],
  ['Downloadable report files', String(f.files)],
])}
<p class="muted small">Any report already written to Google Sheets or to the reports folder is left alone.</p>
<p class="actions"><form method="post" action="/client/${esc(slug)}/delete" class="inline"><input type="hidden" name="confirm" value="${esc(slug)}"><button class="danger">Delete ${esc(client.name)}</button></form>
<a class="btn secondary" href="/client/${esc(slug)}">Keep it</a></p></div>`);
}

function deleteClient(clientId) {
  return transaction(() => {
    const d = sql => getDb().prepare(sql).run(clientId);
    d('DELETE FROM qa_decisions WHERE finding_id IN (SELECT f.id FROM findings f JOIN audit_runs r ON r.id = f.run_id WHERE r.client_id = ?)');
    d('DELETE FROM report_files WHERE run_id IN (SELECT id FROM audit_runs WHERE client_id = ?)');
    d('DELETE FROM findings WHERE run_id IN (SELECT id FROM audit_runs WHERE client_id = ?)');
    d('DELETE FROM snapshots WHERE run_id IN (SELECT id FROM audit_runs WHERE client_id = ?)');
    d('DELETE FROM audit_runs WHERE client_id = ?');
    d('DELETE FROM citations WHERE client_id = ?');
    d('DELETE FROM canonical_facts WHERE client_id = ?');
    d('DELETE FROM gbp_profiles WHERE client_id = ?');
    d('DELETE FROM website_facts WHERE client_id = ?');
    d('DELETE FROM discovery_log WHERE client_id = ?');
    d('DELETE FROM clients WHERE id = ?');
  });
}

function canonicalTable(client, canon) {
  const fields = [...AUDIT_FIELDS, ...PHASE2_FIELDS];
  const hint = f => f === 'hours' ? 'Mon-Fri: 8am-5pm; Sat: Closed; Sun: Closed'
    : f === 'address' ? 'Street, City, ST 12345'
    : f === 'services' || f === 'categories' ? 'comma, separated'
    : f === 'phone' ? '(208) 555-0123'
    : f === 'year_founded' ? '1961'
    : f === 'website' ? 'https://example.com' : '';
  const head = ['Field', 'Value', 'Source', 'Captured', ''];
  const rows = fields.map(f => {
    const c = canon[f];
    const shown = displayCanonical(f, c?.value);
    const setId = `set-${f}`, clearId = `clear-${f}`;
    const value = `<span class="view wrap">${esc(shown) || '<span class="muted">Not set</span>'}</span>`
      + `<form class="edit" id="${setId}" method="post" action="/client/${client.slug}/canonical">`
      + `<input type="hidden" name="field" value="${f}">`
      + `<input type="text" name="value" value="${esc(shown)}" placeholder="${esc(hint(f))}" aria-label="${esc(fieldLabel(f))}">`
      + `</form>`;
    const actions = `<button type="button" class="secondary view js-edit">Edit</button>`
      + `<span class="edit actions">`
      + `<button form="${setId}">Save</button>`
      + `<button type="button" class="secondary js-cancel">Cancel</button>`
      + (c?.source === 'manual' ? `<button form="${clearId}" class="secondary" title="Remove this manual value">Clear</button>` : '')
      + `</span>`
      + (c?.source === 'manual' ? `<form id="${clearId}" method="post" action="/client/${client.slug}/canonical/clear"><input type="hidden" name="field" value="${f}"></form>` : '');
    return { f, cells: [fieldLabel(f), value, c ? (c.source_url ? ext(c.source_url, c.source) : esc(c.source)) : '', c ? `<span class="nowrap">${esc(c.captured_at.slice(0, 10))}</span>` : '', actions] };
  });
  return `<table class="canon"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r => `<tr data-field="${r.f}">${r.cells.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
    + `</tbody></table>`;
}

// One listener for the whole table: Edit reveals the input, Cancel restores the value.
const CANON_JS = `<script>
document.addEventListener('click', function (e) {
  var edit = e.target.closest('.js-edit'), cancel = e.target.closest('.js-cancel');
  if (!edit && !cancel) return;
  var row = e.target.closest('tr');
  if (!row) return;
  if (edit) {
    var open = row.closest('table').querySelector('tr.editing');
    if (open && open !== row) { open.classList.remove('editing'); open.querySelector('.edit input[name=\"value\"]').value = open.dataset.original || ''; }
    row.dataset.original = row.querySelector('.edit input[name=\"value\"]').value;
    row.classList.add('editing');
    var i = row.querySelector('.edit input[name=\"value\"]'); i.focus(); i.select();
  } else {
    row.querySelector('.edit input[name=\"value\"]').value = row.dataset.original || '';
    row.classList.remove('editing');
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var row = e.target.closest('tr.editing');
  if (!row) return;
  row.querySelector('.edit input[name=\"value\"]').value = row.dataset.original || '';
  row.classList.remove('editing');
  e.target.blur();
});
</script>`;

// Rendered on its own so a running job can refresh just this part of the page.
function inventoryHtml(client, inv, dis = '') {
  const active = inv.filter(c => c.status === 'active').length;
  // Findings from the latest finished audit, grouped per profile, so a row can explain itself.
  const run = latestRun(client.id);
  const byCitation = new Map();
  if (run?.finished_at) for (const f of effectiveFindings(run.id)) { if (!byCitation.has(f.citation_id)) byCitation.set(f.citation_id, []); byCitation.get(f.citation_id).push(f); }
  const explain = c => {
    const fs = byCitation.get(c.id) || [];
    if (!fs.length) return null;
    const did = `why-${c.id}`;
    const conflicts = fs.filter(f => f.effective_status === 'conflict');
    const problems = conflicts.length ? conflicts : fs.filter(f => f.effective_status === 'unable_to_verify');
    if (!problems.length) return null;
    const label = conflicts.length ? "What's wrong" : 'Why';
    const title = conflicts.length ? `${conflicts.length} field${conflicts.length === 1 ? '' : 's'} on ${c.directory} disagree${conflicts.length === 1 ? 's' : ''} with the source of truth` : `${c.directory} could not be verified`;
    const body = conflicts.length
      ? table(['Field', 'Listing says', 'Should be', 'Why it was flagged', ''], conflicts.map(f => [fieldLabel(f.field), `<span class="wrap">${esc(f.found || '')}</span>`, `<span class="wrap">${esc(f.expected || '')}</span>`, `<span class="small">${esc(f.reason || '')}</span>`, f.qa_open ? '<span class="badge unable_to_verify">awaiting review</span>' : '<span class="badge conflict">confirmed</span>']))
      : `<p>${esc(problems[0].reason || 'No reason recorded')}</p>`;
    return { button: ` <button type="button" class="secondary small" onclick="document.getElementById('${did}').showModal()">${label}</button>`, dialog: `<dialog id="${did}" class="why"><div class="why-head"><b>${esc(title)}</b><form method="dialog"><button class="secondary small">Close</button></form></div>
<div class="why-body"><p class="small muted" style="margin:0 0 10px">${ext(c.url)}</p>${body}
<p class="small" style="margin:12px 0 0">${link(`/citation/${c.id}?run=${run.id}`, 'See the evidence')} for this profile, or ${link(`/run/${run.id}?filter=${conflicts.length ? 'conflicts' : 'all'}`, 'open the audit')}${conflicts.some(f => f.qa_open) ? ' to review it' : ''}.</p></div></dialog>` };
  };
  const rows = inv.map(c => [
    `<a href="${esc(c.url)}" target="_blank" rel="noopener" style="text-decoration:none"><b>${esc(c.directory)}</b></a>`,
    `<span class="wrap">${ext(c.url)}</span>${c.notes ? `<div class="muted small">${esc(c.notes)}</div>` : ''}`,
    `<a class="btn secondary small" href="${esc(c.url)}" target="_blank" rel="noopener">Open</a>`,
    badge(c.status),
    c.last_result ? (x => `<span class="nowrap"><span class="badge ${esc(c.last_result)}">${esc({ consistent: 'Matched', conflict: 'Mismatched', unable_to_verify: 'Unable to verify' }[c.last_result] || c.last_result)}</span>${x ? x.button : ''}</span>${x ? x.dialog : ''}`)(explain(c)) : '',
    `<span class="nowrap">${esc((c.last_audited_at || '').slice(0, 10))}</span>`,
    `<span class="nowrap">${esc(c.discovered_via)}</span> <span class="muted nowrap">${esc(c.discovered_at.slice(0, 10))}</span>`,
    `<form method="post" action="/citation/${c.id}/status" class="inline"><select name="status" onchange="this.form.submit()"><option ${c.status === 'active' ? 'selected' : ''} value="active">active</option><option ${c.status === 'ignored' ? 'selected' : ''} value="ignored">ignore</option><option ${c.status === 'not_client' ? 'selected' : ''} value="not_client">not this business</option><option ${c.status === 'dead' ? 'selected' : ''} value="dead">dead link</option></select></form>`,
  ]);
  return `<div id="inventory" data-stamp="${inv.length}"><h2>Citation inventory${inv.length ? ` <span class="muted small">${inv.length} known, ${active} active, re-used on every run</span>` : ''}</h2><div class="card">${inv.length
    ? table(['Directory', 'Profile URL', '', 'Status', 'Result', 'Last audited', 'Found via', ''], rows)
    : `<p class="muted small" style="margin:0 0 10px">No profiles stored yet. "Discover profiles" searches for them, or paste one below.</p>`}
<form method="post" action="/client/${client.slug}/citation/add" class="actions"><input type="url" name="url" placeholder="Add a profile URL manually (https://www.yelp.com/biz/…)" style="width:480px" required><button class="secondary" ${dis}>Add</button></form></div></div>`;
}

// Rendered on their own so a running job can refresh just these parts of the page.
function canonicalHtml(client, canon) {
  const stamp = Object.values(canon).map(c => c.captured_at).sort().pop() || 'none';
  return `<div id="canonical" data-stamp="${esc(`${Object.keys(canon).length}|${stamp}`)}"><h2>Source of truth</h2><div class="card">${canonicalTable(client, canon)}<p class="muted small" style="margin:12px 0 0">Google Business Profile and the website fill this in. Anything you edit by hand wins and is never overwritten by a refresh.</p></div></div>`;
}
// The client's own Google Business Profile, as stored, set against what their website says.
function gbpHtml(client) {
  const check = GBP_READS ? gbpCheck(client) : null;
  const wrap = (stamp, body) => `<div id="gbp" data-stamp="${esc(stamp)}"><h2>Google Business Profile vs website <span class="muted small">name, address, phone</span></h2><div class="card">${body}</div></div>`;
  if (!GBP_READS) return wrap('off', `<p class="muted small" style="margin:0">Not connected. Reading the profile needs <code>GOOGLE_PLACES_API_KEY</code> (Places API (New) on a Google Cloud project with billing). Once it is set, this section shows the profile and flags anything that disagrees with the website.</p>`);
  if (!check) return wrap('none', `<p class="muted small" style="margin:0">${client.gbp_url ? 'Linked but not read yet. Press <b>Refresh canonical facts</b>.' : 'No profile linked. Paste the Google Maps link in the Google Business Profile box below, press Save, then <b>Refresh canonical facts</b>.'}</p>`);
  const { gbp, site, rows } = check, g = gbp.facts;
  const bad = rows.filter(r => r.status === 'conflict');
  const closed = g.status && g.status !== 'OPERATIONAL';
  const head = `<p class="small" style="margin:0 0 10px"><b>${esc(g.name)}</b> · ${g.maps_url ? ext(g.maps_url, 'Open on Google Maps') : ''} · <span class="muted">read ${esc(gbp.fetched_at.slice(0, 10))}${site ? `, website read ${esc(site.fetched_at.slice(0, 10))}` : ''}</span></p>`
    + (closed ? `<div class="notice error"><b>Google lists this business as ${esc(g.status.replace(/_/g, ' ').toLowerCase())}</b></div>` : '')
    + (!site ? `<div class="notice warn"><b>The website has not been read yet, so nothing was compared</b><div class="detail">Add the website below and press Refresh canonical facts.</div></div>`
      : bad.length ? `<div class="notice error"><b>The profile and the website disagree on ${bad.map(r => fieldLabel(r.field).toLowerCase()).join(', ')}</b><div class="detail">Customers who find the business on Google see different details from the ones on the site.</div></div>`
      : `<div class="notice ok"><b>The profile matches the website</b></div>`);
  const body = table(['Field', 'Google Business Profile', 'Website', 'Result', 'Why'], rows.map(r => [fieldLabel(r.field), `<span class="wrap">${esc(r.gbp)}</span>`, `<span class="wrap">${esc(r.website)}</span>`, badge(r.status), `<span class="small">${esc(r.reason)}${r.needs_qa ? ' <span class="muted">(low confidence, check by eye)</span>' : ''}</span>`]));
  const extra = [g.categories?.length ? `Categories: ${g.categories.join(', ')}` : '', g.formatted_address ? `Full address on Google: ${g.formatted_address}` : ''].filter(Boolean);
  return wrap(`${gbp.fetched_at}|${site?.fetched_at || ''}`, head + body + (extra.length ? `<p class="muted small" style="margin:12px 0 0">${esc(extra.join(' · '))}</p>` : ''));
}

function runsHtml(runs, dis = '') {
  const stamp = runs.map(r => `${r.id}:${r.finished_at || ''}:${r.sheet_url || ''}`).join(',') || 'none';
  return `<div id="runs" data-stamp="${esc(stamp)}">${runs.length ? `<h2>Audit runs</h2><div class="card">${table(['Started', 'Mode', 'Profiles', 'Consistent', 'Conflicts', 'Unverified', 'Report'], runs.map(r => [link(`/run/${r.id}`, r.started_at.replace('T', ' ').slice(0, 16)), esc(r.mode), String(r.citations_total), String(r.consistent), String(r.conflicts), String(r.unverified), r.sheet_url && r.sheet_url.startsWith('http') ? ext(r.sheet_url, 'Google Sheet') : reportFiles(r.id).length ? link(`/run/${r.id}`, 'Download') : (r.finished_at ? `<form method="post" action="/run/${r.id}/report" class="inline"><button class="secondary" ${dis}>Generate</button></form>` : '<span class="badge working">running</span>')]))}</div>` : ''}</div>`;
}

function clientPage(slug, watching = null) {
  const client = getClient(slug);
  const live = [...jobs.values()].filter(j => j.slug === slug && !j.done);
  // After an audit, say plainly whether the listings agree with the source of truth.
  const lastRun = latestRun(client.id);
  let verdict = '';
  if (!live.length && lastRun?.finished_at) {
    const rows = effectiveFindings(lastRun.id).filter(r => r.effective_status === 'conflict');
    const profiles = new Set(rows.map(r => r.citation_id)).size;
    const pending = rows.filter(r => r.qa_open).length;
    if (rows.length) {
      const shown = rows.slice(0, 8).map(r => `${r.directory}: ${fieldLabel(r.field).toLowerCase()} is "${r.found}", should be "${r.expected}"${r.qa_open ? ' (awaiting review)' : ''}`);
      verdict = `<div class="notice error"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>Inconsistencies found: ${profiles} of ${lastRun.citations_total} profiles disagree with the source of truth</b><div class="detail">${esc(shown.join('\n'))}${rows.length > 8 ? `\nand ${rows.length - 8} more` : ''}</div><div class="small" style="margin-top:8px">${pending ? `${pending} of these still need a review before they reach the client. ` : ''}${link(`/run/${lastRun.id}?filter=conflicts`, 'See every conflict')}</div></div>`;
    } else if (lastRun.citations_total) {
      verdict = `<div class="notice ok"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>No inconsistencies: all ${lastRun.citations_total} profiles agree with the source of truth</b><div class="small muted" style="margin-top:4px">${lastRun.unverified ? `${lastRun.unverified} could not be read and were not compared. ` : ''}Last checked ${esc(lastRun.started_at.slice(0, 10))}. ${link(`/run/${lastRun.id}`, 'Open the run')}</div></div>`;
    }
  }
  const liveBanner = live.length
    ? `<div class="notice warn" id="livejob"><b><span class="badge working">working</span> ${esc({ canonical: 'Reading the source of truth', discover: 'Finding profiles', audit: 'Auditing profiles', report: 'Building the report', firstrun: 'Setting up this client' }[live[0].kind] || live[0].kind)}</b><div class="detail" id="livejob-last">${esc(live[0].log.slice(-1)[0] || 'Starting')}</div><div class="small muted" style="margin-top:6px">Updates on its own and reloads when finished. ${link(`/job/${live[0].id}`, 'Full log')}</div></div>
<script>
(function () {
  var last = document.getElementById('livejob-last');
  var t = setInterval(function () {
    fetch('/job/${live[0].id}/log').then(function (r) { return r.json(); }).then(function (j) {
      if (j.log && j.log.length) last.textContent = j.log[j.log.length - 1];
      if (j.done) { clearInterval(t); location.href = j.next || '/client/${esc(slug)}?watching=${live[0].id}'; return; }
      // Facts, runs and profiles all change while a job runs. Each block carries a stamp
      // and is swapped only when the stamp differs, so typing into the add box or an
      // open edit row is never wiped mid-keystroke.
      return Promise.all(['gbp', 'canonical', 'runs', 'inventory'].map(function (part) {
        var cur = document.getElementById(part);
        if (!cur || cur.querySelector('tr.editing')) return;
        return fetch('/client/${esc(slug)}/' + part).then(function (r) { return r.text(); }).then(function (html) {
          var tmp = document.createElement('div'); tmp.innerHTML = html;
          var next = tmp.firstElementChild;
          if (next && next.dataset.stamp !== cur.dataset.stamp) cur.replaceWith(next);
        });
      }));
    }).catch(function () {});
  }, 2000);
})();
</script>`
    : watching && jobs.get(watching)?.done
      ? (jobs.get(watching).error
        ? `<div class="notice error"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${esc(friendlyJobError(jobs.get(watching)))}</b><div class="detail">${esc(jobs.get(watching).error)}</div><div class="small muted" style="margin-top:6px">${link(`/job/${watching}`, 'Full log')}</div></div>`
        : `<div class="notice ok"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>Finished</b><div class="detail">${esc(jobs.get(watching).log.slice(-1)[0] || '')}</div></div>`)
      : '';
  const canon = getCanonical(client.id);
  const inv = inventory(client.id);
  const runs = all('SELECT * FROM audit_runs WHERE client_id = ? ORDER BY started_at DESC', [client.id]);
  const log = all('SELECT * FROM discovery_log WHERE client_id = ? ORDER BY ran_at DESC LIMIT 30', [client.id]);
  const isBusy = busy(slug);
  const active = inv.filter(c => c.status === 'active').length;
  const dis = isBusy ? 'disabled' : '';
  return layout(client.name, `${liveBanner}<p class="crumb"><a href="/">Clients</a> / ${esc(client.name)}</p><h1>${esc(client.name)} <span class="muted small">${esc(slug)}</span></h1>
${gbpHtml(client)}
${verdict}
<div class="card"><div class="actions">
<form method="post" action="/client/${slug}/canonical/refresh" class="inline"><button ${dis} class="secondary">Refresh canonical facts</button></form>
<form method="post" action="/client/${slug}/discover" class="inline"><button ${dis} class="secondary">Discover profiles</button></form>
<form method="post" action="/client/${slug}/audit" class="inline"><button ${dis}>Run audit${active ? ` (${active} stored profiles)` : ' (will discover first)'}</button> <label class="inline small" style="display:inline"><input type="checkbox" name="rediscover" value="1"> also re-discover</label> <input type="number" name="limit" placeholder="limit" style="width:70px"></form>
</div>
<form method="post" action="/client/${slug}/set" class="fields">
<div><label>Website${client.website ? ` <span class="muted">(${ext(client.website, 'open')})</span>` : ''}</label><input type="url" name="website" placeholder="https://example.com" value="${esc(client.website || '')}"></div>
<div><label>Google Business Profile${client.gbp_url ? ` <span class="muted">(${ext(client.gbp_url, 'open')})</span>` : ''}${client.place_id ? ' <span class="muted">linked</span>' : ''}</label><span class="offfield"><input type="text" name="gbp_url" placeholder="Paste the Google Maps link" value="${esc(client.gbp_url || '')}">${GBP_READS ? '' : `<span class="info" tabindex="0" role="note" aria-label="About this field" title="Saved and kept here for reference. Pulling the name, address, phone and hours out of the profile needs a Google Places API key, which requires Google Cloud billing. Until then, Refresh canonical facts reads the client website instead.">i</span>`}</span></div>
<div class="fields-previous"><label>Previous addresses and phones <span class="muted">(one per line) Discovery also searches for these, and a listing that still shows one is reported as old info for this business.</span></label><textarea name="previous" placeholder="1304 Holtwood Rd, Holtwood, PA 17532&#10;(717) 501-1712">${esc((() => { const p = getPrevious(client); return [...p.addresses, ...p.phones].join('\n'); })())}</textarea></div>
<div class="fields-save"><button class="secondary">Save</button>${client.sheet_id ? `<span class="small">${ext(`https://docs.google.com/spreadsheets/d/${client.sheet_id}`, 'Google Sheet')}</span>` : ''}</div>
</form></div>

${canonicalHtml(client, canon)}${CANON_JS}

${runsHtml(runs, dis)}

${inventoryHtml(client, inv, dis)}

${log.length ? `<details class="fold"><summary>Discovery log <span class="muted">${log.length} search${log.length === 1 ? '' : 'es'} run for this client. Each row is one Google query, how many results came back, and how many were new profiles.</span></summary><div class="card">${table(['When', 'Provider', 'Query', 'Results', 'New'], log.map(l => [esc(l.ran_at.replace('T', ' ').slice(0, 16)), esc(l.provider), esc(l.query), String(l.results_count), String(l.new_citations)]))}</div></details>` : ''}`);
}

const PDF_JS = `<script>
function caLoad(src){return new Promise(function(res,rej){if(document.querySelector('script[src="'+src+'"]'))return res();var s=document.createElement('script');s.src=src;s.onload=res;s.onerror=function(){rej(new Error('could not load '+src))};document.head.appendChild(s)})}
function caCellText(td){var c=td.cloneNode(true);c.querySelectorAll('.no-print,.qa,form,button,select,input').forEach(function(n){n.remove()});c.querySelectorAll('div,br,p').forEach(function(n){n.insertAdjacentText('beforebegin','\\n')});return c.textContent.split('\\n').map(function(l){return l.replace(/\\s+/g,' ').trim()}).filter(Boolean).join('\\n')}
async function caDownloadPdf(btn){var label=btn.textContent;btn.disabled=true;btn.textContent='Preparing...';try{
await caLoad('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
await caLoad('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js');
var d=btn.dataset,doc=new window.jspdf.jsPDF({orientation:'landscape',unit:'pt',format:'letter'});
var tbl=document.querySelector('table.findings-table'),drop=d.droplast==='1';
var head=[].map.call(tbl.querySelectorAll('thead th'),function(th){return th.textContent.trim()});
var body=[].map.call(tbl.querySelectorAll('tbody tr'),function(tr){return [].map.call(tr.children,caCellText)});
if(drop){head=head.slice(0,-1);body=body.map(function(r){return r.length>1?r.slice(0,-1):r})}
doc.setFontSize(15);doc.setTextColor(20);doc.text(d.client,40,42);
doc.setFontSize(9);doc.setTextColor(95);doc.text(d.sub,40,58);doc.text(d.stats,40,71);
doc.autoTable({head:[head],body:body,startY:84,theme:'grid',styles:{fontSize:7.5,cellPadding:4,overflow:'linebreak',valign:'top',textColor:30,lineColor:[220,224,230]},headStyles:{fillColor:[238,241,245],textColor:20,fontStyle:'bold'},margin:{left:40,right:40},
didDrawPage:function(){var n=doc.internal.getNumberOfPages(),h=doc.internal.pageSize.getHeight(),w=doc.internal.pageSize.getWidth();doc.setFontSize(8);doc.setTextColor(140);doc.text(d.client+' - Citation Audit',40,h-20);doc.text('Page '+n,w-40,h-20,{align:'right'})}});
doc.save(d.title+'.pdf');
}catch(e){alert('The PDF could not be created: '+e.message)}finally{btn.disabled=false;btn.textContent=label}}
</script>`;

function runPage(id, filter = 'qa') {
  const run = runById(id);
  if (!run) return null;
  const client = get('SELECT * FROM clients WHERE id = ?', [run.client_id]);
  const rows = effectiveFindings(id);
  // Google vs website mismatches lead the client's fixes here, as they do in the report file.
  const gbp = GBP_READS ? gbpCheck(client) : null;
  const gbpFixes = (gbp?.rows || []).filter(r => r.status === 'conflict' && !r.needs_qa);
  const open = rows.filter(r => r.qa_open).length, conflicts = rows.filter(r => r.effective_status === 'conflict' && !r.qa_open).length + gbpFixes.length;
  const shown = filter === 'qa' ? rows.filter(r => r.qa_open) : filter === 'conflicts' ? rows.filter(r => r.effective_status === 'conflict') : filter === 'action' ? rows.filter(r => r.effective_status === 'conflict' && !r.qa_open) : rows;
  const tab = (k, t) => `<a href="/run/${id}?filter=${k}" class="${filter === k ? 'on' : ''}">${t}</a>`;
  const files = reportFiles(id);
  const skipped = [...new Set(rows.filter(r => /No canonical .* on file/i.test(r.reason || '')).map(r => fieldLabel(r.field)))];
  const skippedNote = skipped.length
    ? `<div class="notice warn"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${skipped.length} field${skipped.length > 1 ? 's were' : ' was'} not checked on any profile</b><div class="detail">${esc(skipped.join(', '))} ${skipped.length > 1 ? 'have' : 'has'} no canonical value set, so there was nothing to compare against. Set ${skipped.length > 1 ? 'them' : 'it'} on ${client.name}'s page and run the audit again.</div></div>` : '';
  const qaForm = r => `<div class="qa"><form method="post" action="/finding/${r.id}/qa"><select name="decision"><option value="confirm">Confirm as-is</option><option value="dismiss">Dismiss (not a real issue)</option><option value="correct">Correct status to</option></select><select name="corrected_status"><option value="conflict">conflict</option><option value="consistent">consistent</option><option value="unable_to_verify">unable to verify</option></select><input type="text" name="note" placeholder="note" style="width:140px"><button>Save</button></form>${r.decision ? `<div class="small muted">QA: ${esc(r.decision)}${r.corrected_status ? ` → ${esc(r.corrected_status)}` : ''}${r.qa_note ? ` — ${esc(r.qa_note)}` : ''}</div>` : ''}</div>`;
  return layout(`Run ${id.slice(0, 8)}`, `${skippedNote}<p class="crumb"><a href="/">Clients</a> / ${link(`/client/${client.slug}`, client.name)} / Audit ${esc(run.started_at.slice(0, 10))}</p><p class="print-only"><b>${esc(client.name)}</b> · Citation audit · printed ${esc(now().slice(0, 10))}</p><h1>Audit of ${esc(run.started_at.replace('T', ' ').slice(0, 16))} <span class="badge">${esc(run.mode)}</span></h1>
${gbpHtml(client)}
<h2>Directory listings</h2>
<div class="card"><div class="grid readout"><div class="stat">${run.citations_total}<small>profiles audited</small></div><div class="stat" style="color:var(--ok)">${run.consistent}<small>consistent</small></div><div class="stat" style="color:var(--bad)">${run.conflicts}<small>with conflicts</small></div><div class="stat" style="color:var(--warn)">${run.unverified}<small>unable to verify</small></div><div class="stat">${open}<small>findings awaiting QA</small></div></div>
<p class="actions no-print">${run.sheet_url && run.sheet_url.startsWith('http') ? ext(run.sheet_url, 'Open Google Sheet') : ''} <form method="post" action="/run/${id}/report" class="inline"><button ${busy(client.slug) ? 'disabled' : ''}>${files.length ? 'Regenerate report' : 'Generate report'}</button></form> <span class="muted small no-print">Client Action tab = ${conflicts} confirmed conflict(s). Findings still in QA are held back from the client tab.</span></p></div>
${files.length ? `<h2 class="no-print">Report files</h2><div class="card no-print">${table(['File', 'What it holds', 'Size', ''], files.map(f => [
  `<span class="mono">${esc(f.name)}</span>`,
  esc({ 'client-action.csv': 'Confirmed conflicts and the correction to make. This is the tab the client reads.',
        'citation-inventory.csv': 'Every stored profile with its status and coverage.',
        'internal-qa.csv': 'Every finding with evidence, confidence and errors.',
        'README.txt': 'Run summary and anything that was skipped.' }[f.name] || ''),
  `${(f.bytes / 1024).toFixed(1)} KB`,
  `<a class="btn secondary small" href="/run/${id}/file/${esc(f.name)}">Download</a>`,
]))}<p class="muted small" style="margin:10px 0 0">Kept in the database, so they survive a restart and ride the same backup.</p></div>` : ''}
<p class="tabs">${tab('qa', `QA queue (${open})`)}${tab('action', `Client action (${conflicts})`)}${tab('conflicts', 'All conflicts')}${tab('all', `All findings (${rows.length})`)}<button type="button" class="secondary small pdf-btn" data-title="${esc(`${client.name} - Citation Audit - ${({ qa: 'QA queue', action: 'Client action', conflicts: 'All conflicts', all: 'All findings' })[filter] || 'Findings'} - ${run.started_at.slice(0, 10)}`)}" data-client="${esc(client.name)}" data-sub="${esc(`Citation audit ${run.started_at.replace('T', ' ').slice(0, 16)} UTC - ${({ qa: 'QA queue', action: 'Client action', conflicts: 'All conflicts', all: 'All findings' })[filter] || 'Findings'} - downloaded ${now().slice(0, 10)}`)}" data-stats="${esc(`${run.citations_total} profiles audited: ${run.consistent} consistent, ${run.conflicts} with conflicts, ${run.unverified} unable to verify`)}" data-droplast="${filter === 'action' ? '0' : '1'}" onclick="caDownloadPdf(this)">Download PDF</button></p>
${PDF_JS}<div class="card">${table(['Directory / URL', 'Field', 'Status', 'Conf.', 'Canonical', 'Found on profile', 'Reason', filter === 'action' ? 'Suggested correction' : 'QA'], [...(filter === 'action' ? gbpFixes.map(r => [`Google Business Profile<div class="small wrap">${gbp.gbp.facts.maps_url ? ext(gbp.gbp.facts.maps_url, 'Open on Google Maps') : ''}</div><div class="small muted">vs the client website</div>`, fieldLabel(r.field), badge(r.status), String(r.confidence), `<span class="wrap">${esc(r.website)}</span>`, `<span class="wrap">${esc(r.gbp)}</span>`, `<span class="small">${esc(r.reason || '')}</span>`, esc(gbpSuggestion(r))]) : []), ...shown.map(r => [`${esc(r.directory)}<div class="small wrap">${ext(r.url, r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</div><div class="small no-print">${link(`/citation/${r.citation_id}?run=${id}`, 'evidence')} <span class="muted">${esc(r.fetch_method || '')}${r.http_status ? ` ${r.http_status}` : ''}</span></div>`, fieldLabel(r.field), `${badge(r.effective_status)}${r.effective_status !== r.status ? `<div class="small muted">raw: ${esc(r.status)}</div>` : ''}`, String(r.confidence), `<span class="wrap">${esc(r.expected)}</span>`, `<span class="wrap">${esc(r.found)}</span>`, `<span class="small">${esc(r.reason || '')}</span>`, filter === 'action' ? esc(suggestion(r)) : qaForm(r)])], 'findings-table')}</div>`);
}

function citationPage(id, runId) {
  const c = get('SELECT * FROM citations WHERE id = ?', [id]);
  if (!c) return null;
  const snap = runId ? get('SELECT * FROM snapshots WHERE citation_id = ? AND run_id = ?', [id, runId]) : get('SELECT * FROM snapshots WHERE citation_id = ? ORDER BY fetched_at DESC LIMIT 1', [id]);
  const client = get('SELECT * FROM clients WHERE id = ?', [c.client_id]);
  const extracted = snap?.extracted_json ? JSON.parse(snap.extracted_json) : null;
  return layout('Evidence', `<h1>Evidence from ${esc(c.directory)}</h1><div class="card"><p>${ext(c.url)}<br><span class="muted small">${link(`/client/${client.slug}`, client.name)} · discovered ${esc(c.discovered_at.slice(0, 10))} via ${esc(c.discovered_via)}${runId ? ` &mdash; ${link(`/run/${runId}`, 'back to run')}` : ''}</span></p>
${snap ? `<p class="small">Fetched ${esc(snap.fetched_at)}<br>method <b>${esc(snap.fetch_method)}</b>, HTTP ${esc(snap.http_status ?? 'n/a')}, extraction confidence ${esc(snap.extraction_confidence ?? 'n/a')}${snap.error ? ` · <span style="color:var(--bad)">${esc(snap.error)}</span>` : ''}</p>` : '<p class="muted">No snapshot yet.</p>'}</div>
${extracted ? `<h2>Extracted by Claude</h2><div class="card"><pre class="log">${esc(JSON.stringify(extracted, null, 2))}</pre></div>` : ''}
${snap?.text_excerpt ? `<h2>Page text excerpt</h2><div class="card"><pre class="log">${esc(snap.text_excerpt)}</pre></div>` : ''}`);
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
  if (/found no business|found nothing/i.test(m)) return 'Google could not find that business. Open it in Google Maps and paste the address bar.';
  if (/does not contain a business/i.test(m)) return 'That Google link has no business in it. Open the business in Google Maps and copy the address bar.';
  if (/Could not fetch/i.test(m)) return 'The website could not be read. Check the address, or enter the facts by hand.';
  if (/discovery provider/i.test(m)) return 'The search provider failed. Add GOOGLE_CSE_KEY and GOOGLE_CSE_CX for reliable discovery.';
  if (/Canonical facts incomplete/i.test(m)) return 'Set the canonical name and phone before running an audit.';
  if (/No profiles to audit/i.test(m)) return 'There are no profiles to check yet. Paste a few profile URLs into the box under the citation inventory, or add a Google search key so discovery can find them.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(m)) return 'A network request failed. Check the address and try again.';
  return 'The job failed. The technical detail is below.';
}

// Where a finished job should land. Audits go to their run so the QA queue is one
// step away; everything else returns to the client with a finished notice.
function jobDestination(j) {
  if (!j.done || j.error) return null;
  if (j.kind === 'audit' && j.result?.id) return `/run/${j.result.id}`;
  if (j.kind === 'firstrun' && j.result?.runId) return `/run/${j.result.runId}`;
  if (j.kind === 'report' && j.result?.kind === 'google-sheet') return j.result.location;
  if (j.kind === 'report') return `/run/${j.runId}`;
  return `/client/${j.slug}?watching=${j.id}`;
}

function jobPage(id) {
  const j = jobs.get(id);
  if (!j) return null;
  // Where a finished job should land. Success sends you straight there instead of
  // parking on a log you have to read and dismiss yourself.
  const destination = jobDestination(j);
  const manual = j.done && !j.error && destination
    ? `<p><a class="btn" href="${esc(destination)}">Continue</a> <span class="muted small">Taking you there now.</span></p>` : '';
  const errBox = j.error
    ? `<div class="notice error"><button class="x" onclick="this.parentNode.remove()" title="Dismiss" aria-label="Dismiss">&times;</button><b>${esc(friendlyJobError(j))}</b><div class="detail">${esc(j.error)}</div></div>`
      + `<p><a class="btn secondary" href="/client/${j.slug}">Back to ${esc(j.slug)}</a></p>`
    : '';
  const running = !j.done;
  return layout(`${j.kind} job`, `${errBox}<h1>${esc(j.kind === 'canonical' ? 'Reading the source of truth' : j.kind === 'discover' ? 'Finding profiles' : j.kind === 'audit' ? 'Auditing profiles' : j.kind === 'firstrun' ? 'Setting up' : 'Building the report')} for ${link(`/client/${j.slug}`, j.slug)} ${j.done ? (j.error ? '<span class="badge conflict">failed</span>' : '<span class="badge consistent">done</span>') : '<span class="badge working">working <span id="elapsed"></span></span>'}</h1>
${running ? `<p class="muted small">Reading a page with Claude takes 10 to 30 seconds each. This keeps running if you leave. ${link(`/client/${j.slug}?watching=${id}`, `Back to ${j.slug}`)}, which follows it too.</p>` : ''}
<pre class="log${running ? ' live' : ''}" id="log">${esc(j.log.join('\n'))}</pre>${manual}
<script>
(function () {
  var done = ${j.done}, dest = ${destination ? JSON.stringify(destination) : 'null'};
  if (done) { if (dest) setTimeout(function () { location.href = dest; }, 700); return; }
  var log = document.getElementById('log'), el = document.getElementById('elapsed');
  var started = ${JSON.stringify(j.started)};
  var t0 = Date.parse(started) || Date.now();
  setInterval(function () {
    var s = Math.max(0, Math.round((Date.now() - t0) / 1000));
    if (el) el.textContent = s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }, 1000);
  var t = setInterval(function () {
    fetch('/job/${id}/log').then(function (r) { return r.json(); }).then(function (j) {
      log.textContent = j.log.join('\n');
      log.scrollTop = log.scrollHeight;
      if (j.done) { clearInterval(t); location.reload(); }
    }).catch(function () {});
  }, 1200);
})();
</script>`);
}


function setupPage(result) {
  const icon = { ok: '<span class="badge consistent">OK</span>', warn: '<span class="badge unable_to_verify">Optional</span>', fail: '<span class="badge conflict">Blocking</span>' };
  const rows = (result?.checks || []).map(c => [icon[c.status], `<b>${esc(c.name)}</b>`, `<span class="wrap">${esc(c.detail)}</span>${c.fix ? `<div class="small muted">${esc(c.fix)}</div>` : ''}`]);
  const u = usageToday();
  const pu = proxyUsage();
  const nextAt = nextResetAt();
  return layout('Setup check', `<h1>Setup check</h1>
<div class="card"><p class="muted small">Confirms each key actually works, including one real (about $0.001) Claude call. Run it after changing anything in Render → Environment.</p>
<p class="actions"><form method="post" action="/setup/run" class="inline"><button>Run the check</button></form> <a class="btn secondary" href="/">Back to clients</a></p></div>
<h2>Today's usage</h2><div class="card"><p>${u.calls} of ${u.calls_limit} Claude calls (${esc(config.model)}) and $${u.cost.toFixed(3)} of $${u.cost_limit.toFixed(2)} used${u.reset_at ? ` since the counter was reset at ${esc(u.reset_at.replace('T', ' ').slice(0, 16))} UTC` : ' since midnight UTC'}.</p>
${proxyEnabled() ? (pu ? `<p>ScraperAPI: <b>${pu.left.toLocaleString()}</b> of ${pu.limit.toLocaleString()} credits left this month, renewing ${esc(pu.renews)}. Yelp costs about 10 credits a page, most directories 1, and Google searches have registered 0. <span class="muted small">Checked ${esc(pu.at.replace('T', ' ').slice(0, 16))} UTC.</span></p>` : '<p class="muted">ScraperAPI credits: not fetched yet. Run the check to load them.</p>') : ''}
<p class="muted small">This is the app's own tally for the daily cap. Resetting it lets audits continue today; it does not change what Anthropic bills, and the history is kept.</p>
<p class="actions"><form method="post" action="/setup/reset-usage" class="inline"><button class="secondary" ${nextAt ? 'disabled' : ''}>Reset today's counter</button></form>${nextAt ? `<span class="muted small">Once every 24 hours. Available again ${esc(fmtWhen(nextAt))}.</span>` : '<span class="muted small">Once every 24 hours.</span>'}</p></div>
${result ? `<div class="card">${table(['', 'Check', 'Result'], rows)}
<p class="small muted">${result.blocking ? `<b style="color:var(--bad)">${result.blocking} blocking problem(s).</b> Items marked Optional can be left as they are.` : 'No blocking problems. You can add a client and run an audit.'}</p></div>` : ''}`);
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

// "in 3 hours (2026-09-19 14:58 UTC)" — relative so it reads at a glance, absolute so it is unambiguous.
function fmtWhen(iso) {
  const ms = Date.parse(iso) - Date.now();
  const total = Math.round(ms / 60_000), h = Math.floor(total / 60), m = total % 60;
  const rel = ms <= 0 ? 'now' : h >= 1 ? `in ${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} min` : ''}` : `in ${Math.max(1, m)} min`;
  return `${rel} (${iso.replace('T', ' ').slice(0, 16)} UTC)`;
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
    if (p === '/') return html(homePage(url.searchParams.get('sort') || 'name'));
    if ((mm = p.match(/^\/client\/([\w-]+)\/delete$/))) {
      const pg = deleteClientPage(mm[1]);
      return pg ? html(pg) : html(notFoundPage(`There is no client called "${mm[1]}".`), 404);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/canonical$/))) {
      const client = get('SELECT * FROM clients WHERE slug = ?', [mm[1]]);
      if (!client) return html('', 404);
      return html(canonicalHtml(client, getCanonical(client.id)));
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/gbp$/))) {
      const client = get('SELECT * FROM clients WHERE slug = ?', [mm[1]]);
      if (!client) return html('', 404);
      return html(gbpHtml(client));
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/runs$/))) {
      const client = get('SELECT * FROM clients WHERE slug = ?', [mm[1]]);
      if (!client) return html('', 404);
      return html(runsHtml(all('SELECT * FROM audit_runs WHERE client_id = ? ORDER BY started_at DESC', [client.id]), busy(client.slug) ? 'disabled' : ''));
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/inventory$/))) {
      const client = get('SELECT * FROM clients WHERE slug = ?', [mm[1]]);
      if (!client) return html('', 404);
      return html(inventoryHtml(client, inventory(client.id), busy(client.slug) ? 'disabled' : ''));
    }
    if ((mm = p.match(/^\/client\/([\w-]+)$/))) {
      if (!get('SELECT id FROM clients WHERE slug = ?', [mm[1]])) return html(notFoundPage(`There is no client called "${mm[1]}".`), 404);
      return html(clientPage(mm[1], url.searchParams.get('watching')));
    }
    if ((mm = p.match(/^\/run\/([\w-]+)$/))) { const pg = runPage(mm[1], url.searchParams.get('filter') || 'qa'); return pg ? html(pg) : html(notFoundPage('That audit run no longer exists.'), 404); }
    if ((mm = p.match(/^\/citation\/([\w-]+)$/))) { const pg = citationPage(mm[1], url.searchParams.get('run')); return pg ? html(pg) : html(notFoundPage('That profile is no longer in the inventory.'), 404); }
    if ((mm = p.match(/^\/job\/([\w-]+)\/log$/))) { const j = jobs.get(mm[1]); return j ? json({ log: j.log, done: j.done, error: j.error, next: jobDestination(j) }) : json({ log: ['unknown job'], done: true, next: null }); }
    if ((mm = p.match(/^\/job\/([\w-]+)$/))) { const pg = jobPage(mm[1]); return pg ? html(pg) : html(notFoundPage('That job is no longer in memory, which usually means the server restarted.'), 404); }
    if (p === '/db/download') { getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)'); res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="citation-audit.sqlite"' }); return res.end(readFileSync(config.dbPath)); }
    // Booleans only, never values: this endpoint is public so the health check can reach it.
    if (p === '/health') return json({
      ok: true,
      commit: (process.env.RENDER_GIT_COMMIT || 'local').slice(0, 7),
      model: config.model,
      started: STARTED,
      configured: {
        claude: Boolean(config.anthropicKey),
        // Discovery is on if any provider that actually returns results is configured.
        search: (config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key)) || Boolean(config.googleCse.key && config.googleCse.cx) || Boolean(config.serpapiKey),
        proxy: Boolean(config.fetchProxy.provider && config.fetchProxy.key),
        places: Boolean(config.placesKey),
        sheets: Boolean(config.serviceAccountJson),
        backup: persistEnabled,
        password: Boolean(PASSWORD),
      },
    });
    if (p === '/setup') return html(setupPage(null));
    if ((mm = p.match(/^\/run\/([\w-]+)\/file\/([\w.-]+)$/))) {
      const f = reportFile(mm[1], mm[2]);
      if (!f) return html(notFoundPage('That report file no longer exists. Generate the report again from the run page.'), 404);
      const type = f.name.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8';
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${f.name}"` });
      return res.end(f.content);
    }
    if ((mm = p.match(/^\/run\/([\w-]+)\/files$/))) {
      const run = runById(mm[1]);
      if (!run) return html(notFoundPage('That audit run no longer exists.'), 404);
      return redirect(`/run/${run.id}`);
    }
    return html(notFoundPage(`No page at ${p}.`), 404);
  }

  if (m === 'POST') {
    let f;
    try { f = Object.fromEntries(new URLSearchParams(body)); }
    catch { return bounce('/', 'error', 'That form could not be read', 'Please try again.'); }
    if (p === '/setup/reset-usage') {
      const r = resetUsageToday();
      if (!r.ok) return bounce('/setup', 'warn', 'The counter can only be reset once every 24 hours', `Available again ${fmtWhen(r.nextAt)}.`);
      schedulePersist();
      return bounce('/setup', 'ok', 'Counter reset', `It was at ${r.before.calls} calls and $${r.before.cost.toFixed(3)}. Both now read zero, and the next reset is available ${fmtWhen(new Date(Date.now() + 24 * 60 * 60_000).toISOString())}.`);
    }
    if (p === '/setup/run') {
      try {
        const result = await diagnose();
        return html(setupPage(result));
      } catch (e) {
        setNotice({ kind: 'error', title: 'The setup check itself failed', detail: e.stack || e.message });
        return html(setupPage(null));
      }
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/delete$/))) {
      const client = get('SELECT * FROM clients WHERE slug = ?', [mm[1]]);
      if (!client) return html(notFoundPage('That client no longer exists.'), 404);
      if (f.confirm !== client.slug) return bounce(`/client/${client.slug}`, 'error', 'Delete was not confirmed', 'Nothing was removed.');
      if (busy(client.slug)) return bounce(`/client/${client.slug}`, 'warn', 'Something is still running for this client', 'Wait for it to finish, then delete.');
      deleteClient(client.id);
      schedulePersist();
      return bounce('/', 'ok', `Deleted ${client.name}`, 'The client and all of its audit history are gone.');
    }
    if (p === '/client/add') {
      const rawSlug = (f.slug || '').trim();
      const slug = rawSlug.toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!f.name?.trim()) return bounce('/', 'error', 'Business name is required', 'Enter the name exactly as it should appear on directories, for example "Anvil Fence Company".');
      if (!slug) return bounce('/', 'error', 'A slug is required', rawSlug ? `"${rawSlug}" has no letters or numbers to use. A slug is a short id like "anvilfence".` : 'A slug is a short id like "anvilfence". It is only used in the URL.');
      if (get('SELECT id FROM clients WHERE slug = ?', [slug])) return bounce('/', 'error', `The slug "${slug}" is already taken`, 'Pick a different short id, or open the existing client from the list above.');
      if (f.website?.trim() && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(f.website.trim())) return bounce('/', 'error', 'That website address does not look valid', `Received "${f.website.trim()}". Include the full address, for example https://anvilfence.com`);
      insert('clients', { id: uuid(), slug, name: f.name.trim(), website: f.website?.trim() || null, place_id: null, gbp_url: f.gbp_url?.trim() || null, sheet_id: null, created_at: now(), updated_at: now() });
      schedulePersist();
      if (f.autorun === '1' && f.website?.trim()) {
        if (!config.anthropicKey) return bounce(`/client/${slug}`, 'error', `Added ${f.name.trim()}, but the audit cannot run`, 'ANTHROPIC_API_KEY is not set, so nothing can be read. Add it in your host\u2019s environment settings and run the setup check.');
        const j = startJob('firstrun', slug, log => firstRun(slug, log));
        return redirect(`/client/${slug}?watching=${j.id}`);
      }
      return bounce(`/client/${slug}`, 'ok', `Added ${f.name.trim()}`, f.website?.trim()
        ? 'Click "Refresh canonical facts" to read the website, then run the audit.'
        : 'Add the website on the client page, then click "Refresh canonical facts".');
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/set$/))) {
      const client = getClient(mm[1]);
      if (f.website?.trim() && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(f.website.trim())) return bounce(`/client/${client.slug}`, 'error', 'That website address does not look valid', `Received "${f.website.trim()}". Include the full address, for example https://anvilfence.com`);
      const gbp = (f.gbp_url || '').trim();
      if (gbp && !/^https?:\/\//i.test(gbp) && !/^[A-Za-z0-9_-]{25,}$/.test(gbp)) {
        return bounce(`/client/${client.slug}`, 'error', 'That Google Business Profile link does not look valid', `Received "${gbp}". Open the business in Google Maps and paste the address bar.`);
      }
      const changed = gbp !== (client.gbp_url || '');
      const patch = { website: f.website?.trim() || null, gbp_url: gbp || null, updated_at: now() };
      if (f.previous !== undefined) { const prev = parsePreviousInput(f.previous); patch.previous_json = prev.addresses.length || prev.phones.length ? JSON.stringify(prev) : null; }
      update('clients', client.id, patch);
      if (changed) { update('clients', client.id, { place_id: null, updated_at: now() }); getDb().prepare('DELETE FROM gbp_profiles WHERE client_id = ?').run(client.id); }
      schedulePersist();
      if (gbp && changed && config.placesKey) {
        const j = startJob('canonical', client.slug, log => refreshCanonical(getClient(client.slug), { log, lookup: gbp }));
        return redirect(`/client/${client.slug}?watching=${j.id}`);
      }
      return bounce(`/client/${client.slug}`, 'ok', 'Saved', gbp && !config.placesKey
        ? 'The Google link is stored. Reading facts from it needs a Places API key; until then use "Refresh canonical facts" to read the website.'
        : '');
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
      if (!client.place_id && !client.website && !client.gbp_url) return bounce(`/client/${client.slug}`, 'error', 'Add the website first', 'Put the client\u2019s website in the box below and press Save. The refresh reads that site to fill in every field.');
      if (!config.anthropicKey && client.website) return bounce(`/client/${client.slug}`, 'error', 'Claude API key is not set', 'Reading the website needs ANTHROPIC_API_KEY. Add it in your host\u2019s environment settings, then run the setup check.');
      const j = startJob('canonical', client.slug, log => refreshCanonical(client, { log, lookup: config.placesKey ? client.gbp_url : null }));
      return redirect(`/client/${client.slug}?watching=${j.id}`);
    }
    if ((mm = p.match(/^\/client\/([\w-]+)\/discover$/))) {
      const client = getClient(mm[1]);
      if (busy(client.slug)) return bounce(`/client/${client.slug}`, 'warn', 'Something is already running for this client', 'Wait for it to finish, then try again.');
      if (!getCanonical(client.id).name) return bounce(`/client/${client.slug}`, 'error', 'Set the business name first', 'Discovery searches for the canonical business name. Set it in the table below, then try again.');
      const j = startJob('discover', client.slug, async log => { const canon = getCanonical(client.id); if (!canon.name) log('No canonical name yet — using client name only. Refresh canonical facts first for better queries.'); const r = await discover(client, canon, { log }); log(`Discovery done: ${r.queries} queries, ${r.seen} results, ${r.added} new profiles`); return r; });
      return redirect(`/client/${client.slug}?watching=${j.id}`);
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
      return redirect(`/client/${client.slug}?watching=${j.id}`);
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
      const j = startJob('report', client.slug, async log => {
        log(`Building the three report tabs for run ${run.id}\u2026`);
        const r = await writeReport(run, client);
        log(r.kind === 'google-sheet' ? `Google Sheet: ${r.location}` : 'Stored in the database and ready to download.');
        await persistNow();
        return r;
      });
      j.runId = run.id;
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
refreshProxyUsage();
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
