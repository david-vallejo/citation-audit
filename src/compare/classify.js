import { config, AUDIT_FIELDS, PHASE2_FIELDS } from '../config.js';
import * as N from './normalize.js';

const CONSISTENT = 'consistent', CONFLICT = 'conflict', UNVERIFIED = 'unable_to_verify';

function finding(field, status, confidence, expected, found, reason) {
  return { field, status, confidence, expected: expected ?? '', found: found ?? '', reason, needs_qa: status !== UNVERIFIED && confidence < config.qaThreshold ? 1 : 0 };
}
const missing = (field, expected, why = 'Not listed on this profile') => finding(field, UNVERIFIED, 1, expected, '', why);

export function compareName(canon, cited) {
  if (!cited) return missing('name', canon);
  if (N.normName(canon) === N.normName(cited)) return finding('name', CONSISTENT, 0.98, canon, cited, 'Exact match');
  if (N.normNameLoose(canon) === N.normNameLoose(cited)) return finding('name', CONSISTENT, 0.75, canon, cited, 'Matches ignoring legal suffix / punctuation; confirm preferred spelling');
  const sim = N.similarity(N.normNameLoose(canon), N.normNameLoose(cited));
  if (sim >= 0.5) return finding('name', CONFLICT, 0.75, canon, cited, 'Name variant; confirm it is the same business and which spelling the client wants');
  return finding('name', CONFLICT, 0.55, canon, cited, 'Name differs substantially; this profile may belong to a different business');
}

export function compareAddress(canon, cited) {
  const c = N.parseAddress(canon), x = N.parseAddress(cited);
  if (!x || !(x.street || x.city || x.zip)) return missing('address', N.fmtAddress(canon));
  if (!c) return finding('address', UNVERIFIED, 1, '', N.fmtAddress(cited), 'No canonical address on file');
  const cs = N.splitStreet(c.street), xs = N.splitStreet(x.street);
  const reasons = [];
  let status = CONSISTENT, confidence = 0.95;
  if (cs.base && xs.base && cs.base !== xs.base) {
    const sim = N.similarity(cs.base, xs.base);
    reasons.push('Street differs'); status = CONFLICT; confidence = sim > 0.6 ? 0.7 : 0.95;
  } else if (!xs.base && cs.base) { reasons.push('Street missing'); status = CONFLICT; confidence = 0.7; }
  if (cs.unit !== xs.unit) {
    if (!xs.unit) { reasons.push('Suite/unit omitted'); if (status === CONSISTENT) { status = CONFLICT; confidence = 0.65; } }
    else if (!cs.unit) { reasons.push('Extra suite/unit listed'); if (status === CONSISTENT) { status = CONFLICT; confidence = 0.6; } }
    else { reasons.push('Suite/unit differs'); status = CONFLICT; confidence = Math.min(confidence, 0.9); }
  }
  if (c.city && x.city && N.clean(c.city) !== N.clean(x.city)) { reasons.push('City differs'); status = CONFLICT; confidence = Math.min(confidence, 0.85); }
  if (c.state && x.state && N.normState(c.state) !== N.normState(x.state)) { reasons.push('State differs'); status = CONFLICT; confidence = 0.95; }
  if (N.normZip(c.zip) && N.normZip(x.zip) && N.normZip(c.zip) !== N.normZip(x.zip)) { reasons.push('ZIP differs'); status = CONFLICT; confidence = Math.min(confidence, 0.9); }
  return finding('address', status, confidence, N.fmtAddress(canon), N.fmtAddress(cited), reasons.join('; ') || 'Match after normalization');
}

function comparePhone(canon, cited) {
  const c = N.normPhone(canon), x = N.normPhone(cited);
  if (!x) return missing('phone', N.fmtPhone(canon));
  if (!c) return finding('phone', UNVERIFIED, 1, '', N.fmtPhone(cited), 'No canonical phone on file');
  if (c === x) return finding('phone', CONSISTENT, 0.99, N.fmtPhone(canon), N.fmtPhone(cited), 'Match');
  if (x.length !== 10) return finding('phone', CONFLICT, 0.6, N.fmtPhone(canon), cited, 'Cited phone is malformed');
  return finding('phone', CONFLICT, 0.97, N.fmtPhone(canon), N.fmtPhone(cited), 'Different number');
}

function compareWebsite(canon, cited) {
  const c = N.normUrlHost(canon), x = N.normUrlHost(cited);
  if (!x) return missing('website', canon);
  if (!c) return finding('website', UNVERIFIED, 1, '', cited, 'No canonical website on file');
  if (c === x) return finding('website', CONSISTENT, 0.98, canon, cited, 'Same domain');
  if (x.endsWith('.' + c) || c.endsWith('.' + x)) return finding('website', CONSISTENT, 0.8, canon, cited, 'Subdomain of canonical domain');
  return finding('website', CONFLICT, 0.95, canon, cited, 'Points to a different domain');
}

export function compareHours(canon, cited) {
  const c = N.normHours(canon), x = N.normHours(cited);
  if (!x) return cited ? finding('hours', UNVERIFIED, 0.5, N.fmtHours(c), String(cited), 'Could not parse listed hours') : missing('hours', N.fmtHours(c));
  if (!c) return finding('hours', UNVERIFIED, 1, '', N.fmtHours(x), 'No canonical hours on file');
  const diffs = [];
  let unparsed = 0;
  for (const d of N.DAYS) {
    const a = c[d], b = x[d];
    if (b === undefined) continue;
    if (b === null) { unparsed++; continue; }
    const same = JSON.stringify(a ?? 'closed') === JSON.stringify(b ?? 'closed');
    if (!same) diffs.push(d);
  }
  if (diffs.length) return finding('hours', CONFLICT, diffs.length >= 2 ? 0.9 : 0.75, N.fmtHours(c), N.fmtHours(x), `Differs on ${diffs.join(', ')}`);
  if (unparsed) return finding('hours', UNVERIFIED, 0.5, N.fmtHours(c), N.fmtHours(x), 'Some days could not be parsed');
  const coverage = N.DAYS.filter(d => x[d] !== undefined).length;
  return finding('hours', CONSISTENT, coverage === 7 ? 0.95 : 0.8, N.fmtHours(c), N.fmtHours(x), coverage === 7 ? 'All days match' : `${coverage} listed days match`);
}

function compareYear(canon, cited) {
  const c = N.normYear(canon), x = N.normYear(cited);
  if (!x) return missing('year_founded', c == null ? '' : String(c));
  if (!c) return finding('year_founded', UNVERIFIED, 1, '', String(x), 'No canonical founding year on file');
  if (c === x) return finding('year_founded', CONSISTENT, 0.98, String(c), String(x), 'Match');
  return finding('year_founded', CONFLICT, Math.abs(c - x) <= 1 ? 0.7 : 0.9, String(c), String(x), 'Different founding year');
}

function compareServices(canon, cited) {
  const c = N.normServices(canon), x = N.normServices(cited);
  if (!x.length) return missing('services', c.join(', '));
  if (!c.length) return finding('services', UNVERIFIED, 1, '', x.join(', '), 'No canonical services on file');
  const cn = c.map(N.normService);
  const extra = x.filter(s => { const n = N.normService(s); return n && !cn.some(k => k === n || k.includes(n) || n.includes(k)); });
  if (!extra.length) return finding('services', CONSISTENT, 0.9, c.join(', '), x.join(', '), 'All listed services are offered');
  return finding('services', CONFLICT, extra.length > 2 ? 0.7 : 0.6, c.join(', '), x.join(', '), `Lists services not in canonical set: ${extra.join(', ')}`);
}

function compareList(field, canon, cited) {
  const c = N.normServices(canon), x = N.normServices(cited);
  if (!x.length) return missing(field, c.join(', '));
  if (!c.length) return finding(field, UNVERIFIED, 1, '', x.join(', '), 'No canonical value on file');
  const cn = new Set(c.map(N.clean)), extra = x.filter(v => !cn.has(N.clean(v)));
  return extra.length ? finding(field, CONFLICT, 0.6, c.join(', '), x.join(', '), `Not in canonical set: ${extra.join(', ')}`) : finding(field, CONSISTENT, 0.9, c.join(', '), x.join(', '), 'Match');
}

function compareEmail(canon, cited) {
  const c = N.clean(canon).replace(/\s/g, ''), x = N.clean(cited).replace(/\s/g, '');
  if (!x) return missing('email', canon);
  if (!c) return finding('email', UNVERIFIED, 1, '', cited, 'No canonical email on file');
  return c === x ? finding('email', CONSISTENT, 0.98, canon, cited, 'Match') : finding('email', CONFLICT, 0.9, canon, cited, 'Different email');
}

const COMPARATORS = {
  name: compareName, address: compareAddress, phone: comparePhone, website: compareWebsite,
  hours: compareHours, year_founded: compareYear, services: compareServices,
  categories: (c, x) => compareList('categories', c, x), email: compareEmail,
};

export function classify(canonical, extracted, { extractionConfidence = 1, phase2 = false } = {}) {
  const fields = phase2 ? [...AUDIT_FIELDS, ...PHASE2_FIELDS] : AUDIT_FIELDS;
  const out = [];
  for (const field of fields) {
    const canon = canonical[field]?.value;
    if (canon == null && !phase2 && PHASE2_FIELDS.includes(field)) continue;
    const f = COMPARATORS[field](canon, extracted?.[field]);
    f.confidence = Math.round(Math.min(f.confidence, Math.max(extractionConfidence, 0.3)) * 100) / 100;
    if (f.status !== UNVERIFIED && f.confidence < config.qaThreshold) f.needs_qa = 1;
    out.push(f);
  }
  return out;
}

export function unverifiedAll(reason, canonical) {
  return AUDIT_FIELDS.map(field => ({ field, status: UNVERIFIED, confidence: 0, expected: displayCanonical(field, canonical[field]?.value), found: '', reason, needs_qa: 1 }));
}

export function displayCanonical(field, v) {
  if (v == null) return '';
  switch (field) {
    case 'address': return N.fmtAddress(v);
    case 'phone': return N.fmtPhone(v);
    case 'hours': return N.fmtHours(N.normHours(v));
    case 'services': case 'categories': return N.normServices(v).join(', ');
    default: return String(v);
  }
}

export { CONSISTENT, CONFLICT, UNVERIFIED };
