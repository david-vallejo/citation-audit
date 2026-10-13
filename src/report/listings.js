import { all, getCanonical, getPrevious, getLocations } from '../db.js';
import { effectiveFindings } from '../audit.js';
import * as N from '../compare/normalize.js';
import { displayCanonical, comparePhone, compareWebsite } from '../compare/classify.js';

// Turns one audit run into the client deliverable: every real listing with a plain-English
// status and what to fix, the pages that only mention the business, and the key findings.
// Same rules every run, so the spreadsheet reads the same no matter who runs the audit.

export const CORRECT = 'Correct';
export const FIX = 'Needs Correction';
export const WRONG_LOCATION = 'Wrong Location - Remove';
export const CHECK = 'Check Manually';
export const STATUS_ORDER = [WRONG_LOCATION, FIX, CHECK, CORRECT];

const NAP_FIELDS = ['name', 'address', 'phone', 'website'];
const SOCIAL = /(^|\.)(facebook|instagram|youtube|tiktok|x|twitter|pinterest)\.com$/;
const DIRECTORY_LABELS = { bbb: 'BBB', yelp: 'Yelp', yellowpages: 'YellowPages', mapquest: 'MapQuest', manta: 'Manta', houzz: 'Houzz', nextdoor: 'Nextdoor', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', angi: 'Angi', homeadvisor: 'HomeAdvisor', thumbtack: 'Thumbtack', chamberofcommerce: 'ChamberofCommerce.com', showmelocal: 'ShowMeLocal', foursquare: 'Foursquare', thefencegroup: 'The Fence Group', superpages: 'Superpages', 'fencetrac.com': 'FenceTrac', 'thebluebook.com': 'The Blue Book', 'napc.pro': 'NAPC Directory', 'network.procore.com': 'Procore Network', 'projects.constructconnect.com': 'ConstructConnect', 'cgmimm.com': 'CGMIMM', 'fenceshow.com': 'Fence Show', 'business.liba.org': 'LIBA', 'tiktok.com': 'TikTok', buildzoom: 'BuildZoom', porch: 'Porch', merchantcircle: 'MerchantCircle', hotfrog: 'Hotfrog', alignable: 'Alignable', dnb: 'Dun & Bradstreet', birdeye: 'Birdeye' };

const host = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const siteLabel = (directory, url) => DIRECTORY_LABELS[directory] || (directory && !directory.includes('.') ? directory : host(url).replace(/^(ye|sd|ls|ch|es)\./, ''));

// Older runs predate page_kind; read the same answer out of the extraction notes.
function inferKind(data, reasons) {
  if (data?.page_kind) return data.page_kind;
  const t = `${data?.notes || ''} ${reasons}`.toLowerCase();
  if (/http 4\d\d|error page|login|captcha|security verification|challenge|failed to load|forbidden|could not fetch/.test(t)) return 'blocked';
  if (/not the target|different business|does not match the target|is for [a-z].* in [a-z]/.test(t) && !/same business|is the target/.test(t)) return 'other_business';
  if (/article|press release|news|job posting|registration|roster|blog|archive page|testimonials page|terms and conditions|organization chart|sponsor/.test(t)) return 'mention';
  if (data && data.is_profile_page === false && !data.name) return 'mention';
  return 'target_listing';
}

function addressParts(a) {
  const p = N.parseAddress(a);
  if (!p) return null;
  if (!p.city && p.street && !/\d/.test(p.street)) return { ...p, city: p.street, street: '' };
  return p;
}
const STATES = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy' };
const normState = s => { const c = N.clean(s || ''); return STATES[c] || c; };

function note(f, ctx) {
  const found = f.found || '(blank)';
  switch (f.field) {
    case 'name': return `Business name shows "${found}". Should be "${f.expected}".`;
    case 'phone': return ctx.knownPhones.has(N.normPhone(f.found)) ? '' : `Phone shows ${found}. Should be ${f.expected}. Confirm with the client whether this number is theirs.`;
    case 'website': return `Website link points to ${found}. Should be ${f.expected}.`;
    case 'address': {
      if ((f.reason || '').startsWith('Still shows the previous')) return `Old address (${found}). Update to ${f.expected}.`;
      const x = addressParts(f.found), c = addressParts(f.expected);
      if (x?.city && c?.city && N.clean(x.city) !== N.clean(c.city)) return `Shows ${found}, a different city. Update to ${f.expected}.`;
      if (/PO Box|P\.O\./i.test(found)) return `Shows a PO box (${found}) instead of the street address. Update to ${f.expected}.`;
      return `Address shows "${found}". Should be "${f.expected}".`;
    }
    default: return '';
  }
}

export function buildListings(run, client) {
  const rows = effectiveFindings(run.id);
  const canonical = getCanonical(client.id);
  const locations = getLocations(client), previous = getPrevious(client);
  const knownPhones = new Set([canonical.phone?.value, ...locations.phones, ...previous.phones].map(N.normPhone).filter(Boolean));
  const homeState = normState(addressParts(displayCanonical('address', canonical.address?.value))?.state);
  const okStates = new Set([homeState, ...locations.addresses.map(a => normState(addressParts(a)?.state))].filter(Boolean));
  const ctx = { knownPhones };

  const snaps = new Map(all('SELECT citation_id, extracted_json, fetch_method, http_status FROM snapshots WHERE run_id = ?', [run.id]).map(s => [s.citation_id, s]));
  const current = new Map(all('SELECT id, status, search_snippet FROM citations WHERE client_id = ?', [client.id]).map(c => [c.id, c]));
  const byCitation = new Map();
  for (const r of rows) { if (!byCitation.has(r.citation_id)) byCitation.set(r.citation_id, []); byCitation.get(r.citation_id).push(r); }

  const listings = [], mentions = [], excluded = [];
  for (const [id, fs] of byCitation) {
    const c = fs[0], cur = current.get(id), snap = snaps.get(id) || {};
    if (!cur || cur.status !== 'active') { excluded.push({ url: c.url, why: `marked ${cur?.status || 'removed'}` }); continue; }
    let data = null;
    try { data = JSON.parse(snap.extracted_json || 'null'); } catch { data = null; }
    if ([404, 410].includes(snap.http_status) && !data?.address && !data?.phone) { excluded.push({ url: c.url, why: `page gone (HTTP ${snap.http_status})` }); continue; }
    const live = fs.filter(f => f.effective_status !== 'dismissed');
    const kind = inferKind(data, fs.map(f => f.reason || '').join(' '));
    const shown = {
      name: data?.name || '',
      address: data?.address ? N.fmtAddress(data.address) : '',
      phone: data?.phone ? (N.normPhone(data.phone) ? N.fmtPhone(data.phone) : data.phone) : '',
    };
    const site = siteLabel(c.directory, c.url);
    let phoneIsClient = knownPhones.has(N.normPhone(data?.phone));
    let st = normState(addressParts(data?.address)?.state);
    // Read as "not the target" yet showing the client's phone: the client's listing, filed in the wrong place.
    if (!st && kind === 'other_business' && [...knownPhones].some(p => (data?.notes || '').replace(/\D/g, '').includes(p))) {
      const named = (data?.notes || '').match(/\b([A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+)*),\s*([A-Z][a-z]+(?: [A-Z][a-z]+)?|[A-Z]{2})\b/);
      if (named && STATES[N.clean(named[2])] || named?.[2]?.length === 2) { st = normState(named[2]); phoneIsClient = true; if (!shown.address) shown.address = `${named[1]}, ${st.toUpperCase()}`; if (!shown.phone) shown.phone = N.fmtPhone([...knownPhones][0]); }
    }
    // A blocked page still has its search result: "Empire Netting & Fence - Atlanta, GA - (402)682-7658".
    if (!st && cur.search_snippet) {
      const snip = cur.search_snippet, digits = snip.replace(/\D/g, '');
      const where = snip.match(/\b([A-Z][A-Za-z.]+(?: [A-Z][A-Za-z.]+)*),\s*([A-Z]{2})\b/);
      if (where && [...knownPhones].some(p => digits.includes(p))) { st = normState(where[2]); phoneIsClient = true; if (!shown.address) shown.address = `${where[1]}, ${where[2]}`; }
    }
    const base = { site, url: c.url, directory: c.directory, ...shown };

    if (phoneIsClient && st && okStates.size && !okStates.has(st)) {
      listings.push({ ...base, status: WRONG_LOCATION, notes: `Listed in ${shown.address || st.toUpperCase()} with the client's phone number. The business has no location there; request removal.`, issue: { type: 'wrong_location', key: (() => { const a = addressParts(shown.address); return a?.city ? `${a.city}, ${st.toUpperCase()}` : st.toUpperCase(); })() } });
      continue;
    }
    const social = SOCIAL.test(host(c.url)) || /(^|\.)tiktok\.com$/.test(host(c.url));
    const directory = social || Boolean(DIRECTORY_LABELS[c.directory]);
    if (kind === 'other_business') { excluded.push({ url: c.url, why: 'a different business' }); continue; }
    if (kind === 'mention' && !directory) { mentions.push({ site, url: c.url, what: (data?.notes || cur.search_snippet || '').split(/(?<=\.)\s/)[0].slice(0, 220) }); continue; }

    // Re-check phone and website with today's rules, so an older run's hidden phone or
    // snippet-truncated link does not show up as an error.
    const recheck = f => f.field === 'phone' ? comparePhone(f.expected, f.found).status : f.field === 'website' ? compareWebsite(f.expected, f.found).status : 'conflict';
    const conflicts = live.filter(f => NAP_FIELDS.includes(f.field) && f.effective_status === 'conflict' && recheck(f) === 'conflict');
    const hasData = shown.address || shown.phone;
    if (kind === 'blocked' || kind === 'mention' || !hasData) {
      listings.push({ ...base, status: CHECK, notes: social ? 'Social profile. Open it and confirm the About/bio details.' : 'Site blocks automated checks. Open it and confirm the name, address and phone.', issue: { type: 'manual' } });
      continue;
    }
    if (!conflicts.length) { listings.push({ ...base, status: CORRECT, notes: '' }); continue; }
    const notes = conflicts.map(f => note(f, ctx)).filter(Boolean);
    const issues = conflicts.map(f => {
      if (f.field === 'name') return { type: 'name', key: f.found };
      if (f.field === 'phone' && !knownPhones.has(N.normPhone(f.found))) return { type: 'phone', key: N.normPhone(f.found) ? N.fmtPhone(f.found) : f.found };
      if (f.field === 'address') {
        const x = addressParts(f.found), cAddr = addressParts(f.expected);
        if (x?.city && cAddr?.city && N.clean(x.city) !== N.clean(cAddr.city)) return { type: 'other_city', key: [x.city, (x.state || '').toUpperCase()].filter(Boolean).join(', ') };
        return { type: 'address' };
      }
      if (f.field === 'website') return { type: 'website' };
      return null;
    }).filter(Boolean);
    if (!notes.length) { listings.push({ ...base, status: CORRECT, notes: '' }); continue; }
    listings.push({ ...base, status: FIX, notes: notes.join(' '), issues });
  }

  // The same page reached through a language subdomain, a translated path or a tracking
  // query is one listing. Partner sites with several pages about the business count once.
  const rank = l => (l.address ? 2 : 0) + (l.phone ? 2 : 0) + (l.name ? 1 : 0) + (l.status === CHECK ? -5 : 0);
  const keyOf = l => {
    const u = new URL(l.url), h = u.hostname.replace(/^(www|[a-z]{2})\./, '');
    return DIRECTORY_LABELS[l.directory] ? `${h}${u.pathname.replace(/^\/[a-z]{2}(?=\/)/, '').replace(/\/$/, '')}${/\.aspx$|\.php$/.test(u.pathname) ? u.search : ''}` : h;
  };
  const best = new Map();
  for (const l of listings) { const k = keyOf(l); if (!best.has(k) || rank(l) > rank(best.get(k))) best.set(k, l); }
  listings.splice(0, listings.length, ...best.values());

  // Two listings on one directory for the same business: one of them should go.
  const perSite = new Map();
  for (const l of listings) if (l.status !== WRONG_LOCATION && DIRECTORY_LABELS[l.directory]) perSite.set(l.site, (perSite.get(l.site) || 0) + 1);
  for (const l of listings) {
    const n = perSite.get(l.site);
    if (n > 1 && l.status !== WRONG_LOCATION) l.notes = `${l.notes ? l.notes + ' ' : ''}One of ${n} listings on ${l.site}; merge the duplicates or remove the extra.`.trim();
  }
  listings.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.site.localeCompare(b.site));
  return { listings, mentions, excluded, findings: keyFindings(listings), canonical };
}

const list = arr => { const u = [...new Set(arr)]; return u.length <= 2 ? u.join(' and ') : `${u.slice(0, -1).join(', ')} and ${u.at(-1)}`; };

export function keyFindings(listings) {
  const out = [];
  const group = type => {
    const m = new Map();
    for (const l of listings) for (const i of [...(l.issues || []), ...(l.issue ? [l.issue] : [])]) if (i.type === type) { const k = i.key || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(l.site); }
    return m;
  };
  const cities = group('other_city');
  if (cities.size) out.push(`Listings still show other or old addresses: ${[...cities].map(([city, sites]) => `${city} (${list(sites)})`).join('; ')}.`);
  const wrong = group('wrong_location');
  if (wrong.size) out.push(`${[...wrong.values()].flat().length} listing(s) place the business in a location it does not have, using its real phone number: ${[...wrong].map(([where, sites]) => `${where} (${list(sites)})`).join('; ')}. These usually come from a bad data feed and should be removed.`);
  const names = group('name');
  if (names.size) out.push(`The business name appears differently on ${[...names.values()].flat().length} listing(s): ${[...names].map(([n, sites]) => `"${n}" (${list(sites)})`).join('; ')}.`);
  const phones = group('phone');
  if (phones.size) out.push(`Unrecognized phone numbers: ${[...phones].map(([p, sites]) => `${p} on ${list(sites)}`).join('; ')}. Confirm with the client.`);
  const addr = group('address');
  if (addr.size) out.push(`Address errors in the right city (wrong street, missing parts, typos): ${list([...addr.values()].flat())}.`);
  const manual = group('manual');
  if (manual.size) out.push(`${[...manual.values()].flat().length} listing(s) block automated checks and need a quick manual look: ${list([...manual.values()].flat())}.`);
  return out;
}
