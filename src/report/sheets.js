import { createSign } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { get, all, update, now, uuid, getDb } from '../db.js';
import { effectiveFindings, suggestion, gbpCheck, gbpSuggestion } from '../audit.js';

const TABS = ['Client Action', 'Citation Inventory', 'Internal QA'];
const label = s => ({ consistent: 'Consistent', conflict: 'Conflict', needs_review: 'Needs Review', unable_to_verify: 'Unable to Verify', dismissed: 'Dismissed (QA)' }[s] || s);
const fieldLabel = f => ({ name: 'Business Name', address: 'Address', phone: 'Phone', website: 'Website', hours: 'Hours', year_founded: 'Year Founded', services: 'Services', categories: 'Categories', email: 'Email' }[f] || f);

function buildTabs(run, client) {
  const rows = effectiveFindings(run.id);
  const byCitation = new Map();
  for (const r of rows) { if (!byCitation.has(r.citation_id)) byCitation.set(r.citation_id, []); byCitation.get(r.citation_id).push(r); }

  const action = [['Directory', 'Profile URL', 'Field', 'Currently Listed', 'Should Be', 'Suggested Correction']];
  // The profile vs the client's own site leads: those are the listings customers see first.
  const gbp = gbpCheck(client);
  const GBP_DIR = 'Google Business Profile (vs website)';
  for (const r of gbp?.rows || []) if (r.status === 'conflict' && !r.needs_qa) action.push([GBP_DIR, gbp.gbp.facts.maps_url || '', fieldLabel(r.field), r.gbp, r.website, gbpSuggestion(r)]);
  for (const r of rows) if (r.effective_status === 'conflict' && !r.qa_open) action.push([r.directory, r.url, fieldLabel(r.field), r.found, r.expected, suggestion(r)]);

  const inv = [['Directory', 'Profile URL', 'Status', 'Conflicting Fields', 'Pending Review', 'Last Checked', 'Discovered Via', 'Discovered On']];
  for (const [, fs] of byCitation) {
    const c = fs[0];
    const conflicts = fs.filter(f => f.effective_status === 'conflict' && !f.qa_open).map(f => fieldLabel(f.field));
    const pendingConflicts = fs.filter(f => f.effective_status === 'conflict' && f.qa_open).map(f => fieldLabel(f.field));
    const pending = fs.filter(f => f.qa_open).length;
    // A profile with unreviewed conflicts is not "Consistent". Saying so in a
    // client-facing tab understates the problem and undermines the whole report.
    const status = conflicts.length ? 'conflict'
      : pendingConflicts.length ? 'needs_review'
      : fs.every(f => f.effective_status === 'unable_to_verify') ? 'unable_to_verify'
      : 'consistent';
    const fields = [...conflicts, ...pendingConflicts.map(f => `${f} (in review)`)].join(', ');
    inv.push([c.directory, c.url, label(status), fields, pending ? `${pending} finding(s) in QA` : '', (c.last_audited_at || '').slice(0, 10), c.discovered_via, (c.discovered_at || '').slice(0, 10)]);
  }

  const qa = [['Directory', 'Profile URL', 'Field', 'Raw Status', 'Effective Status', 'Confidence', 'Needs QA', 'QA Decision', 'QA Note', 'Expected (canonical)', 'Found (cited)', 'Reason', 'Fetch Method', 'HTTP', 'Extraction Confidence', 'Fetch/Extract Error', 'Finding ID']];
  for (const r of gbp?.rows || []) qa.push([GBP_DIR, gbp.gbp.facts.maps_url || '', fieldLabel(r.field), label(r.status), label(r.status), r.confidence, r.needs_qa ? 'YES' : '', '', '', r.website, r.gbp, r.reason, `Places API ${gbp.gbp.fetched_at.slice(0, 10)}`, '', '', '', '']);
  for (const r of rows) qa.push([r.directory, r.url, fieldLabel(r.field), label(r.status), label(r.effective_status), r.confidence, r.qa_open ? 'YES' : '', r.decision || '', r.qa_note || '', r.expected, r.found, r.reason || '', r.fetch_method || '', r.http_status ?? '', r.extraction_confidence ?? '', r.snapshot_error || '', r.id]);

  const oldInfo = new Set(rows.filter(r => r.effective_status === 'conflict' && (r.reason || '').startsWith('Still shows the previous')).map(r => r.url));
  const skipped = [...new Set(rows.filter(r => /No canonical .* on file/i.test(r.reason || '')).map(r => fieldLabel(r.field)))];
  const meta = [`${client.name} — Citation Audit`, `Run ${run.id} (${run.mode}) started ${run.started_at}`, `${run.citations_total} profiles: ${run.consistent} consistent, ${run.conflicts} conflict, ${run.unverified} unable to verify`,
    ...(oldInfo.size ? [`Still showing old address or phone: ${oldInfo.size} listing(s)`] : []),
    gbp ? `Google Business Profile vs website: ${gbp.rows.filter(r => r.status === 'conflict').length} mismatch(es), profile read ${gbp.gbp.fetched_at.slice(0, 10)}` : 'Google Business Profile not checked (no profile linked, or the Places API key is not set)',
    ...(skipped.length ? [`Not checked anywhere because no canonical value is set: ${skipped.join(', ')}. Set them on the client page and re-run.`] : [])];
  return { tabs: { [TABS[0]]: action, [TABS[1]]: inv, [TABS[2]]: qa }, meta, skipped };
}

// ---- Google auth (service account, no googleapis dependency) ----
let tokenCache = { token: null, exp: 0 };
async function accessToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const sa = JSON.parse(readFileSync(config.serviceAccountJson, 'utf8'));
  const iat = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive', aud: sa.token_uri, iat, exp: iat + 3600 })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const res = await fetch(sa.token_uri, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${unsigned}.${sig}` });
  const j = await res.json();
  if (!res.ok) throw new Error(`Google token: ${j.error_description || j.error}`);
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function gapi(url, method = 'GET', body) {
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${j.error?.message || JSON.stringify(j)}`);
  return j;
}
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

async function ensureSpreadsheet(client) {
  if (client.sheet_id) {
    try { return await gapi(`${SHEETS}/${client.sheet_id}?fields=spreadsheetId,spreadsheetUrl,sheets.properties`); }
    catch (e) { if (!/404/.test(e.message)) throw e; }
  }
  const ss = await gapi(SHEETS, 'POST', { properties: { title: `${client.name} — Citation Audit` }, sheets: TABS.map((t, i) => ({ properties: { title: t, index: i, gridProperties: { frozenRowCount: 1 } } })) });
  for (const email of config.shareWith) {
    await gapi(`https://www.googleapis.com/drive/v3/files/${ss.spreadsheetId}/permissions?sendNotificationEmail=false`, 'POST', { role: 'writer', type: 'user', emailAddress: email });
  }
  update('clients', client.id, { sheet_id: ss.spreadsheetId, updated_at: now() });
  return ss;
}

async function writeGoogleSheet(run, client) {
  const { tabs } = buildTabs(run, client);
  const ss = await ensureSpreadsheet(client);
  const props = Object.fromEntries(ss.sheets.map(s => [s.properties.title, s.properties]));
  const requests = [];
  for (const t of TABS) if (!props[t]) requests.push({ addSheet: { properties: { title: t, gridProperties: { frozenRowCount: 1 } } } });
  if (requests.length) { await gapi(`${SHEETS}/${ss.spreadsheetId}:batchUpdate`, 'POST', { requests }); return writeGoogleSheet(run, client); }
  await gapi(`${SHEETS}/${ss.spreadsheetId}/values:batchClear`, 'POST', { ranges: TABS.map(t => `'${t}'!A:Z`) });
  await gapi(`${SHEETS}/${ss.spreadsheetId}/values:batchUpdate`, 'POST', { valueInputOption: 'RAW', data: TABS.map(t => ({ range: `'${t}'!A1`, values: tabs[t].map(r => r.map(v => v ?? '')) })) });
  const fmt = [];
  for (const t of TABS) {
    const sid = props[t].sheetId, cols = tabs[t][0].length;
    fmt.push(
      { repeatCell: { range: { sheetId: sid, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true }, backgroundColor: { red: 0.93, green: 0.93, blue: 0.93 } } }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } },
      { updateSheetProperties: { properties: { sheetId: sid, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
      { autoResizeDimensions: { dimensions: { sheetId: sid, dimension: 'COLUMNS', startIndex: 0, endIndex: cols } } },
      { repeatCell: { range: { sheetId: sid, startRowIndex: 1 }, cell: { userEnteredFormat: { wrapStrategy: 'WRAP', verticalAlignment: 'TOP' } }, fields: 'userEnteredFormat(wrapStrategy,verticalAlignment)' } },
    );
  }
  const statusCol = 2;
  for (const [color, text] of [[{ red: 0.99, green: 0.85, blue: 0.85 }, 'Conflict'], [{ red: 0.85, green: 0.95, blue: 0.85 }, 'Consistent'], [{ red: 1, green: 0.95, blue: 0.8 }, 'Unable to Verify'], [{ red: 0.9, green: 0.92, blue: 1 }, 'Needs Review']]) {
    fmt.push({ addConditionalFormatRule: { rule: { ranges: [{ sheetId: props[TABS[1]].sheetId, startRowIndex: 1, startColumnIndex: statusCol, endColumnIndex: statusCol + 1 }], booleanRule: { condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: text }] }, format: { backgroundColor: color } } }, index: 0 } });
  }
  await gapi(`${SHEETS}/${ss.spreadsheetId}:batchUpdate`, 'POST', { requests: fmt });
  update('audit_runs', run.id, { sheet_url: ss.spreadsheetUrl });
  return ss.spreadsheetUrl;
}

// ---- CSV fallback (no Google credentials) ----
const csv = rows => rows.map(r => r.map(v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n') + '\n';

const fileName = tab => `${tab.toLowerCase().replace(/[^a-z]+/g, '-')}.csv`;

// Kept in the database, not only on disk: a free host wipes the disk on every
// restart, and the database is what gets backed up.
function writeCsvReport(run, client) {
  const { tabs, meta } = buildTabs(run, client);
  const stamp = run.started_at.slice(0, 19).replace(/[:T]/g, '-');
  const files = TABS.map(t => ({ name: fileName(t), content: csv(tabs[t]) }));
  files.push({ name: 'README.txt', content: meta.join('\n') + '\n\nImport each CSV as a tab in Google Sheets (File \u2192 Import \u2192 Append/Replace).\n' });

  const db = getDb();
  for (const f of files) {
    db.prepare('DELETE FROM report_files WHERE run_id = ? AND name = ?').run(run.id, f.name);
    db.prepare('INSERT INTO report_files (id, run_id, name, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(uuid(), run.id, f.name, f.content, Buffer.byteLength(f.content), now());
  }

  // A local copy as well, handy when running the CLI on your own machine.
  let dir = null;
  try {
    dir = join(config.reportsDir, client.slug, stamp);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f.name), f.content);
  } catch { dir = null; }

  update('audit_runs', run.id, { sheet_url: `/run/${run.id}/files` });
  return dir || `${files.length} files stored in the database`;
}

export function reportFiles(runId) {
  return all('SELECT name, bytes, created_at FROM report_files WHERE run_id = ? ORDER BY name', [runId]);
}
export function reportFile(runId, name) {
  return get('SELECT name, content FROM report_files WHERE run_id = ? AND name = ?', [runId, name]);
}

export async function writeReport(run, client) {
  if (config.serviceAccountJson) return { kind: 'google-sheet', location: await writeGoogleSheet(run, client) };
  return { kind: 'csv', location: writeCsvReport(run, client) };
}

export function runById(id) { return get('SELECT * FROM audit_runs WHERE id = ?', [id]); }
