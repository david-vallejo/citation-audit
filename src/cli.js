#!/usr/bin/env node
// CLI mirror of the web UI. Usage: node src/cli.js <command> [args]
import { all, get, insert, update, uuid, now, getClient, getCanonical, setCanonical } from './db.js';
import { refreshCanonical, runAudit, effectiveFindings, latestRun, displayCanonical } from './audit.js';
import { discover, addCitation, inventory } from './discovery/index.js';
import { classifyUrl } from './discovery/directories.js';
import { writeReport, runById } from './report/sheets.js';
import { parseAddress, normHours, normServices } from './compare/normalize.js';
import { AUDIT_FIELDS, PHASE2_FIELDS } from './config.js';
import { diagnose } from './diagnose.js';

const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; flags[k] = v; }
  else pos.push(argv[i]);
}
const [cmd, ...rest] = pos;
const log = m => console.log(m);

const HELP = `
citation-audit — commands
  client add <slug> --name "Biz Name" [--website https://…] [--place-id ChIJ…] [--lookup "Name City ST"]
  client list
  canonical <slug> [--refresh] [--lookup "Name City ST"] [--no-website]
  canonical set <slug> <field> "<value>"         (manual override; sticky)
  discover <slug> [--provider ddg|google-cse|serpapi]
  citations <slug> [add <url>] [set <url> active|ignored|not_client|dead]
  audit <slug> [--rediscover] [--limit N] [--provider …] [--dry-run]
  findings <run-id|slug> [--qa|--conflicts]
  qa <finding-id> confirm|dismiss|correct [--status conflict|consistent|unable_to_verify] [--note "…"]
  report <slug|run-id>
  run <slug>                                     canonical (if missing) → discover (if empty) → audit → report
  serve                                          start the web UI
  check                                          verify every key works (makes one ~\$0.001 Claude call)
`;

function parseValue(field, v) {
  switch (field) {
    case 'address': return parseAddress(v);
    case 'hours': return normHours(v) || v;
    case 'services': case 'categories': return normServices(v);
    case 'year_founded': return parseInt(v, 10);
    default: return v;
  }
}
function printCanonical(canon) {
  for (const f of [...AUDIT_FIELDS, ...PHASE2_FIELDS]) { const c = canon[f]; console.log(`  ${f.padEnd(13)} ${(displayCanonical(f, c?.value) || '—').slice(0, 110).padEnd(110)} ${c ? `[${c.source}]` : ''}`); }
}

try {
  switch (cmd) {
    case 'client': {
      if (rest[0] === 'list') { console.table(all('SELECT slug, name, website, place_id, sheet_id FROM clients ORDER BY name')); break; }
      if (rest[0] === 'add') {
        const slug = rest[1]; if (!slug || !flags.name) throw new Error('client add <slug> --name "…"');
        insert('clients', { id: uuid(), slug, name: flags.name, website: flags.website || null, place_id: flags['place-id'] || null, sheet_id: null, created_at: now(), updated_at: now() });
        log(`added ${slug}`);
        if (flags.lookup) { const c = await refreshCanonical(getClient(slug), { log, lookup: flags.lookup, skipWebsite: true }); printCanonical(c); }
        break;
      }
      throw new Error(HELP);
    }
    case 'canonical': {
      if (rest[0] === 'set') { const client = getClient(rest[1]); setCanonical(client.id, rest[2], parseValue(rest[2], rest[3]), 'manual', null, { force: true }); printCanonical(getCanonical(client.id)); break; }
      const client = getClient(rest[0]);
      let canon = getCanonical(client.id);
      if (flags.refresh || flags.lookup || !canon.name) canon = await refreshCanonical(client, { log, lookup: flags.lookup || null, skipWebsite: Boolean(flags['no-website']) });
      printCanonical(canon);
      break;
    }
    case 'discover': { const client = getClient(rest[0]); const r = await discover(client, getCanonical(client.id), { log, provider: flags.provider }); log(`${r.queries} queries, ${r.seen} results, ${r.added} new`); break; }
    case 'citations': {
      const client = getClient(rest[0]);
      if (rest[1] === 'add') { const c = classifyUrl(rest[2], null); const r = addCitation(client.id, rest[2], c?.directory || c?.host || 'manual', 'manual'); log(r.created ? 'added' : 'already known'); }
      if (rest[1] === 'set') { const c = get('SELECT * FROM citations WHERE client_id = ? AND url LIKE ?', [client.id, `%${rest[2].replace(/^https?:\/\/(www\.)?/, '')}%`]); if (!c) throw new Error('no such citation'); update('citations', c.id, { status: rest[3] }); }
      console.table(inventory(client.id).map(c => ({ directory: c.directory, url: c.url, status: c.status, last_result: c.last_result, last_audited: (c.last_audited_at || '').slice(0, 10), via: c.discovered_via })));
      break;
    }
    case 'audit': {
      const client = getClient(rest[0]);
      const r = await runAudit(client, { log, rediscover: Boolean(flags.rediscover), limit: flags.limit ? parseInt(flags.limit, 10) : Infinity, provider: flags.provider, dryRun: Boolean(flags['dry-run']) });
      if (flags['dry-run']) { log(`mode=${r.mode}; would audit ${r.citations.length} citations`); break; }
      log(`run id: ${r.id}`);
      break;
    }
    case 'findings': {
      const run = runById(rest[0]) || latestRun(getClient(rest[0]).id);
      if (!run) throw new Error('no runs yet');
      let rows = effectiveFindings(run.id);
      if (flags.qa) rows = rows.filter(r => r.qa_open);
      if (flags.conflicts) rows = rows.filter(r => r.effective_status === 'conflict');
      console.table(rows.map(r => ({ id: r.id.slice(0, 8), directory: r.directory, field: r.field, status: r.effective_status, conf: r.confidence, qa: r.qa_open ? 'OPEN' : (r.decision || ''), expected: (r.expected || '').slice(0, 40), found: (r.found || '').slice(0, 40), reason: (r.reason || '').slice(0, 50) })));
      break;
    }
    case 'qa': {
      const fi = get('SELECT * FROM findings WHERE id LIKE ?', [`${rest[0]}%`]);
      if (!fi) throw new Error('no such finding');
      const row = { decision: rest[1], corrected_status: rest[1] === 'correct' ? flags.status : null, reviewer: 'cli', note: flags.note || null, decided_at: now() };
      const ex = get('SELECT id FROM qa_decisions WHERE finding_id = ?', [fi.id]);
      if (ex) update('qa_decisions', ex.id, row); else insert('qa_decisions', { id: uuid(), finding_id: fi.id, ...row });
      log('saved');
      break;
    }
    case 'report': {
      const run = runById(rest[0]) || latestRun(getClient(rest[0]).id);
      if (!run) throw new Error('no runs yet');
      const client = get('SELECT * FROM clients WHERE id = ?', [run.client_id]);
      const r = await writeReport(run, client);
      log(`${r.kind}: ${r.location}`);
      break;
    }
    case 'run': {
      const client = getClient(rest[0]);
      let canon = getCanonical(client.id);
      if (!canon.name || !canon.phone) { log('Canonical facts missing — refreshing…'); canon = await refreshCanonical(client, { log }); }
      const r = await runAudit(client, { log, rediscover: Boolean(flags.rediscover), limit: flags.limit ? parseInt(flags.limit, 10) : Infinity });
      const rep = await writeReport(r, client);
      log(`${rep.kind}: ${rep.location}`);
      if (r.qa_pending) log(`${r.qa_pending} findings need QA — review at the web UI (node src/cli.js serve) then regenerate the report.`);
      break;
    }
    case 'check': {
      const r = await diagnose();
      for (const c of r.checks) console.log(`  ${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(22)} ${c.detail}${c.fix ? `\n       → ${c.fix}` : ''}`);
      console.log(r.blocking ? `\n${r.blocking} blocking problem(s).` : '\nNo blocking problems.');
      break;
    }
    case 'serve': await import('./server.js'); break;
    default: console.log(HELP);
  }
} catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
if (cmd !== 'serve') process.exit(0);
