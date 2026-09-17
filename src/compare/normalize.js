const SUFFIXES = /\b(llc|l\.l\.c\.|inc|inc\.|incorporated|co|co\.|company|corp|corp\.|corporation|ltd|ltd\.|limited|llp|pllc)\b/g;

const STREET_ABBR = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', boulevard: 'blvd', lane: 'ln', court: 'ct',
  circle: 'cir', place: 'pl', parkway: 'pkwy', highway: 'hwy', terrace: 'ter', trail: 'trl', way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  suite: 'ste', apartment: 'apt', building: 'bldg', floor: 'fl', unit: 'unit', route: 'rte', expressway: 'expy',
};

const STATES = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY',
  louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA',
  washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC',
};

export const clean = s => (s ?? '').toString().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

export function normName(s) { return clean(s); }
export function normNameLoose(s) { return clean(s).replace(SUFFIXES, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim(); }

export function normPhone(s) {
  let d = (s ?? '').toString().replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length === 10 ? d : (d || null);
}
export function fmtPhone(s) {
  const d = normPhone(s);
  return d && d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : (s ?? '');
}

export function normStreet(s) {
  const tokens = clean(s).split(' ').filter(Boolean).map(t => STREET_ABBR[t] ?? t);
  return tokens.join(' ');
}
export function normState(s) {
  const c = clean(s);
  if (STATES[c]) return STATES[c];
  return c.toUpperCase().slice(0, 2);
}
export function normZip(s) { return ((s ?? '').toString().match(/\d{5}/) || [''])[0]; }

export function splitStreet(street) {
  const n = normStreet(street);
  const m = n.match(/^(.*?)\s*\b(ste|apt|unit|bldg|fl|#)\s*([a-z0-9-]+)\s*$/);
  if (m) return { base: m[1].trim(), unit: `${m[2]} ${m[3]}`.replace('# ', '#') };
  return { base: n, unit: '' };
}

export function parseAddress(a) {
  if (!a) return null;
  if (typeof a === 'object') {
    return { street: a.street ?? '', city: a.city ?? '', state: a.state ?? '', zip: a.zip ?? a.postal_code ?? '' };
  }
  const parts = a.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return { street: a, city: '', state: '', zip: '' };
  const last = parts[parts.length - 1].replace(/\b(usa|united states|us)\b/i, '').trim();
  const m = last.match(/^([a-z .]+?)\s*(\d{5})?(?:-\d{4})?$/i);
  return { street: parts.slice(0, -2).join(', ') || parts[0], city: parts.length >= 3 ? parts[parts.length - 2] : '', state: m ? m[1].trim() : last, zip: m && m[2] ? m[2] : '' };
}

export function fmtAddress(a) {
  const p = parseAddress(a);
  if (!p) return '';
  return [p.street, p.city, [p.state, p.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

export function normUrlHost(u) {
  if (!u) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return clean(u).replace(/\s/g, ''); }
}

export function normalizeUrl(u) {
  try {
    const url = new URL(u.trim());
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|source|_ga)/i.test(k)) url.searchParams.delete(k);
    let s = url.toString();
    if (url.pathname !== '/' && s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return u.trim(); }
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_ALIASES = { monday: 'mon', mon: 'mon', tuesday: 'tue', tue: 'tue', tues: 'tue', wednesday: 'wed', wed: 'wed', thursday: 'thu', thu: 'thu', thur: 'thu', thurs: 'thu', friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat', sunday: 'sun', sun: 'sun' };

function toMinutes(h, m, ampm) {
  h = parseInt(h, 10); m = parseInt(m || '0', 10);
  if (ampm) { ampm = ampm.toLowerCase(); if (ampm === 'pm' && h < 12) h += 12; if (ampm === 'am' && h === 12) h = 0; }
  return h * 60 + m;
}
const hhmm = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

export function parseHourRange(s) {
  if (s == null) return null;
  const t = s.toString().toLowerCase().trim();
  if (!t || /^(n\/?a|unknown|not listed)$/.test(t)) return null;
  if (/closed/.test(t)) return 'closed';
  if (/24 ?hours|open 24|24\/7/.test(t)) return [{ open: '00:00', close: '24:00' }];
  const re = /(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/g;
  const ranges = [];
  let m;
  while ((m = re.exec(t))) {
    let [, h1, m1, ap1, h2, m2, ap2] = m;
    ap1 = ap1?.replace(/\./g, ''); ap2 = ap2?.replace(/\./g, '');
    if (!ap1 && ap2) ap1 = (parseInt(h1) < parseInt(h2) || parseInt(h1) === 12) ? ap2 : (ap2 === 'pm' ? 'am' : 'pm');
    if (!ap1 && !ap2 && parseInt(h1) <= 12 && parseInt(h2) <= 12 && parseInt(h2) < parseInt(h1)) { ap1 = 'am'; ap2 = 'pm'; }
    let open = toMinutes(h1, m1, ap1), close = toMinutes(h2, m2, ap2);
    if (close <= open) close += 12 * 60;
    ranges.push({ open: hhmm(open), close: hhmm(close) });
  }
  return ranges.length ? ranges : null;
}

export function normHours(h) {
  if (!h) return null;
  const grid = {};
  if (typeof h === 'string') {
    for (const line of h.split(/\n|;|\|/)) {
      const m = line.match(/^\s*([a-z]+)\s*(?:-|–|to)?\s*([a-z]+)?\s*[:\s]\s*(.+)$/i);
      if (!m) continue;
      const a = DAY_ALIASES[m[1].toLowerCase()], b = m[2] ? DAY_ALIASES[m[2].toLowerCase()] : null;
      if (!a) continue;
      const range = parseHourRange(m[3]);
      const from = DAYS.indexOf(a), to = b ? DAYS.indexOf(b) : from;
      for (let i = from; i <= (to >= from ? to : from); i++) grid[DAYS[i]] = range;
    }
  } else if (typeof h === 'object') {
    for (const [k, v] of Object.entries(h)) {
      const d = DAY_ALIASES[k.toLowerCase()];
      if (!d) continue;
      // "" / null mean the source simply doesn't list that day: leave it absent
      // so comparison treats it as "not listed" rather than "could not parse".
      if (v == null || (typeof v === 'string' && !v.trim())) continue;
      grid[d] = Array.isArray(v) ? v : parseHourRange(v);
    }
  }
  return Object.keys(grid).length ? grid : null;
}

export function fmtHours(grid) {
  if (!grid) return '';
  const fmt12 = t => { const [h, m] = t.split(':').map(Number); const hh = h % 12 || 12; return `${hh}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 && h < 24 ? 'pm' : 'am'}`; };
  return DAYS.filter(d => grid[d] !== undefined).map(d => {
    const v = grid[d];
    const s = v === 'closed' ? 'Closed' : v == null ? '?' : v.map(r => `${fmt12(r.open)}-${fmt12(r.close)}`).join(', ');
    return `${d[0].toUpperCase()}${d.slice(1)} ${s}`;
  }).join('; ');
}

export function normYear(y) {
  const m = (y ?? '').toString().match(/\b(18|19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

const SERVICE_STOP = new Set(['fence', 'fences', 'fencing', 'installation', 'install', 'services', 'service', 'and', 'the', 'a', 'of', 'for', 'contractor', 'company', 'repair', 'repairs']);
export function normService(s) {
  const toks = clean(s).split(' ').filter(t => t && !SERVICE_STOP.has(t)).map(t => t.replace(/s$/, ''));
  return toks.sort().join(' ');
}
export function normServices(list) {
  if (!list) return [];
  const arr = Array.isArray(list) ? list : list.toString().split(/,|;|\n/);
  return [...new Set(arr.map(s => s.trim()).filter(Boolean))];
}

export function similarity(a, b) {
  const A = new Set(clean(a).split(' ').filter(Boolean)), B = new Set(clean(b).split(' ').filter(Boolean));
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export { DAYS };
