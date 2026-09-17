import { config } from '../config.js';
import { DAYS } from '../compare/normalize.js';

const FIELDS = 'id,displayName,formattedAddress,addressComponents,nationalPhoneNumber,internationalPhoneNumber,websiteUri,regularOpeningHours,primaryTypeDisplayName,types,googleMapsUri,businessStatus';
const headers = () => {
  if (!config.placesKey) throw new Error('GOOGLE_PLACES_API_KEY is not set (Places API (New) must be enabled on the key)');
  return { 'Content-Type': 'application/json', 'X-Goog-Api-Key': config.placesKey };
};

export async function searchPlaces(textQuery) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST', headers: { ...headers(), 'X-Goog-FieldMask': FIELDS.split(',').map(f => `places.${f}`).join(',') },
    body: JSON.stringify({ textQuery, maxResultCount: 5 }),
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

export function toCanonical(p) {
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
