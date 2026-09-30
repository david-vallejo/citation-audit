// Google Business Profile vs the client's own website. Neither side is assumed right:
// a mismatch here means Google and the site tell customers different things, so the
// finding reports both values and leaves the fix to whoever knows which is current.
import { compareName, compareAddress, comparePhone, compareWebsite, compareHours, CONFLICT, UNVERIFIED } from './classify.js';
import { parseAddress } from './normalize.js';
import { config } from '../config.js';

export const GBP_FIELDS = ['name', 'address', 'phone', 'hours', 'website'];
const COMPARE = { name: compareName, address: compareAddress, phone: comparePhone, hours: compareHours, website: compareWebsite };
const empty = v => v == null || v === '' || (typeof v === 'object' && !Object.values(v).some(Boolean));

// gbp: facts from places.js toCanonical. site: facts from scrapeWebsite. siteUrl: the client's website.
export function compareGbpToWebsite(gbp, site, siteUrl) {
  return GBP_FIELDS.map(field => {
    const g = gbp?.[field], w = field === 'website' ? siteUrl : site?.[field];
    // The comparators read (canonical, cited); the website plays canonical, the profile cited.
    const f = COMPARE[field](w, g);
    const out = { field, status: f.status, confidence: f.confidence, website: f.expected, gbp: f.found, reason: f.reason };
    if (empty(g) && field === 'website' && !empty(w)) Object.assign(out, { status: CONFLICT, confidence: 0.9, reason: 'The profile does not link to the website' });
    else if (empty(g)) Object.assign(out, { status: UNVERIFIED, reason: 'Not on the Google Business Profile' });
    else if (empty(w)) Object.assign(out, { status: UNVERIFIED, reason: 'The website does not state it' });
    else if (field === 'address' && !parseAddress(g).street) {
      // Service-area businesses hide their street on Google; only the city and state are public.
      const town = compareAddress({ ...parseAddress(w), street: '', zip: '' }, { ...parseAddress(g), zip: '' });
      Object.assign(out, town.status === CONFLICT
        ? { status: CONFLICT, confidence: town.confidence, reason: `${town.reason}; the profile hides its street address` }
        : { status: UNVERIFIED, confidence: 1, reason: 'The profile hides its street address (service-area business); city and state match' });
    }
    out.needs_qa = out.status === CONFLICT && out.confidence < config.qaThreshold ? 1 : 0;
    return out;
  });
}
