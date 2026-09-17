import { fetchPage } from '../fetch/page.js';
import { extractListing } from '../extract/claude.js';
import { normYear } from '../compare/normalize.js';

const ABOUT_PATHS = ['/about', '/about-us', '/about-us/', '/about/', '/our-story', '/company', '/services', '/services/'];

function fromJsonLd(jsonld) {
  const biz = jsonld.find(j => /LocalBusiness|Organization|HomeAndConstructionBusiness|GeneralContractor/i.test([].concat(j['@type'] || []).join(' ')));
  if (!biz) return {};
  const addr = biz.address && typeof biz.address === 'object' ? { street: biz.address.streetAddress, city: biz.address.addressLocality, state: biz.address.addressRegion, zip: biz.address.postalCode } : null;
  return { name: biz.name, phone: biz.telephone, address: addr, email: biz.email, year_founded: normYear(biz.foundingDate), url: biz.url, hours_spec: biz.openingHoursSpecification || biz.openingHours };
}

export async function scrapeWebsite(website, target, { log = console.log } = {}) {
  const base = new URL(/^https?:\/\//.test(website) ? website : `https://${website}`);
  const pages = [];
  const home = await fetchPage(base.toString(), { allowFallbacks: true });
  if (home.method === 'blocked' || home.method === 'error') throw new Error(`Could not fetch ${base}: ${home.error}`);
  pages.push({ url: base.toString(), page: home });
  const links = new Set();
  for (const m of home.text.matchAll(/\b(about|our story|services|company)\b/gi)) links.add(m[1].toLowerCase());
  for (const path of ABOUT_PATHS) {
    if (pages.length >= 3) break;
    try {
      const p = await fetchPage(new URL(path, base).toString(), { allowFallbacks: false });
      if (p.method === 'direct' && p.status === 200 && p.text.length > 500 && !pages.some(x => x.page.text.slice(0, 500) === p.text.slice(0, 500))) pages.push({ url: new URL(path, base).toString(), page: p });
    } catch { /* optional page */ }
  }
  log(`  fetched ${pages.length} page(s) from ${base.hostname}`);
  const ld = fromJsonLd(home.jsonld);
  const merged = { url: base.toString(), title: home.title, description: home.description, jsonld: home.jsonld, text: pages.map(p => `=== ${p.url} ===\n${p.page.text.slice(0, 15_000)}`).join('\n\n') };
  const { data, usage } = await extractListing(merged, base.toString(), target, { isOwnSite: true });
  return {
    facts: {
      name: data.name || ld.name || null,
      address: data.address || ld.address || null,
      phone: data.phone || ld.phone || null,
      email: data.email || ld.email || null,
      year_founded: data.year_founded || ld.year_founded || null,
      services: data.services?.length ? data.services : null,
      hours: data.hours || null,
    },
    sources: pages.map(p => p.url), usage, notes: data.notes,
  };
}
