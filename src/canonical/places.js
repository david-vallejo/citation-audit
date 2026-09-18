import { config } from '../config.js';
import { DAYS } from '../compare/normalize.js';

const FIELDS = 'id,displayName,formattedAddress,addressComponents,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,primaryTypeDisplayName,types,googleMapsUri,businessStatus';
const headers = () => {
  if (!config.placesKey) throw new Error('GOOGLE_PLACES_API_KEY is not set (Places API (New) must be enabled on the key)');
  return { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.placesKey };
};

export async function searchPlaces(textQuery, bias = null) {
  const body = { textQuery, maxResultCount: 5 };
  if (bias) body.locationBias = { circle: { center: { latitude: bias.lat, longitude: bias.lng }, radius: 2000 } };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { ...headers(), 'X-Goog-FieldMask': FIELDS.split(',').map(f => `places.${f}`).join(',') },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(`Places searchText ${res.status}: ${j.error?.message || 'error'}`);
  return (j.places || []).map(toCanonical);
}

export async function placeDetails(placeId) {
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, { headers: { ...headers(), 'X-Goog-FieldMask': FIELDS } });
  const j = await res.json();
  if (!res.ok) throw new Error(`Places details ${res.status}: ${j.error?.message || 'error'}`);
  return toCanonical(j);
}

const pad = n => String(n ?? 0).padStart(2, '0');
function hoursGrid(regular) {
  if (!regular?.periods) return null;
  const grid = Object.fromEntries(DAYS.map(d => [d, 'closed']));
  const dayOf = i => DAYS[(i + 6) % 7];
  for (const p of regular.periods) {
    if (!p.open) continue;
    const d = dayOf(p.open.day);
    if (!p.close) { grid[d] = [{ open: '00:00', close: '24:00' }]; continue; }
    const r = { open: `${pad(p.open.hour)}:${pad(p.open.minute)}`, close: `${pad(p.close.hour)}:${pad(p.close.minute)}` };
    if (p.close.day !== p.open.day && r.close === '00:00') r.close = '24:00';
    grid[d] = grid[d] === 'closed' ? [r] : [...grid[d], r];
  }
  return grid;
}

function component(comps, type, useShort = false) {
  const c = (comps || []).find(c => c.types?.includes(type));
  return c ? (useShort ? c.shortText : c.longText) : '';
}

function toCanonical(p) {
  const comps = p.addressComponents;
  const street = [component(comps, 'street_number'), component(comps, 'route', true), component(comps, 'subpremise') ? `Ste ${component(comps, 'subpremise')}` : ''].filter(Boolean).join(' ');
  return {
    place_id: p.id,
    name: p.displayName?.text || '',
    address: { street, city: component(comps, 'locality') || component(comps, 'sublocality') || component(comps, 'postal_town'), state: component(comps, 'administrative_area_level_1', true), zip: component(comps, 'postal_code') },
    formatted_address: p.formattedAddress,
    phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
    website: p.websiteUri || '',
    hours: hoursGrid(p.regularOpeningHours),
    hours_text: p.regularOpeningHours?.weekdayDescriptions || null,
    categories: [p.primaryTypeDisplayName?.text, ...(p.types || []).filter(t => !['point_of_interest', 'establishment'].includes(t)).map(t => t.replace(/_/g, ' '))].filter(Boolean),
    maps_url: p.googleMapsUri,
    status: p.businessStatus,
  };
}

// Accepts whatever someone can copy off Google: a Maps link, a share link, a
// "place_id:" URL, a raw Place ID, or just the business name and city.
// Returns { placeId } when an exact id is recoverable, else { query } to search.
export async function resolvePlaceInput(raw) {
  const input = (raw || '').trim();
  if (!input) throw new Error('Enter a Google Business Profile link, or the business name plus city and state');

  // A bare Place ID (these always start with ChIJ / GhIJ / EefJ style prefixes).
  if (/^[A-Za-z0-9_-]{25,}$/.test(input) && !input.includes('/') && !input.includes(' ')) return { placeId: input, via: 'place id' };

  let url = input;
  // Short share links (maps.app.goo.gl/…, goo.gl/maps/…) have to be expanded first.
  if (/^https?:\/\/(maps\.app\.goo\.gl|goo\.gl|g\.co)\//i.test(url)) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
      url = res.url || url;
    } catch { /* fall through and parse what we were given */ }
  }

  if (/^https?:\/\//i.test(url)) {
    const byId = url.match(/place_id[:=]([A-Za-z0-9_-]{25,})/);
    if (byId) return { placeId: byId[1], via: 'link' };
    // /maps/place/Business+Name/@lat,lng  → search by the name, narrowed by coordinates.
    const byName = url.match(/\/maps\/place\/([^/@?#]+)/);
    const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    if (byName) {
      const name = decodeURIComponent(byName[1].replace(/\+/g, ' ')).trim();
      if (name) return { query: name, bias: at ? { lat: parseFloat(at[1]), lng: parseFloat(at[2]) } : null, via: 'link' };
    }
    const q = url.match(/[?&]q=([^&]+)/);
    if (q) return { query: decodeURIComponent(q[1].replace(/\+/g, ' ')), via: 'link' };
    throw new Error('That Google link does not contain a business. Open the business in Google Maps, copy the address bar, and paste that.');
  }

  return { query: input, via: 'name' };
}
