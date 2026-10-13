import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/compare/classify.js';
import { parsePreviousInput, getLocations } from '../src/db.js';

const canonical = {
  name: { value: 'Empire Netting & Fence' },
  address: { value: '14650 Woodstock Blvd, Waverly, NE 68462' },
  phone: { value: '(402) 682-7658' },
  website: { value: 'https://empire-fence.com/' },
};
const locations = parsePreviousInput('Shawnee, KS\n(913) 555-0100');

test('getLocations reads the stored json and tolerates junk', () => {
  assert.deepEqual(getLocations({ locations_json: JSON.stringify(locations) }), locations);
  assert.deepEqual(getLocations({ locations_json: 'nope' }), { addresses: [], phones: [] });
});

test('a listing for another location is consistent, not a conflict', () => {
  const extracted = { name: 'Empire Netting & Fence', address: { street: '', city: 'Shawnee', state: 'KS', zip: '' }, phone: '913-555-0100', website: 'https://empire-fence.com/' };
  const out = classify(canonical, extracted, { extractionConfidence: 0.9, locations });
  const addr = out.find(f => f.field === 'address'), phone = out.find(f => f.field === 'phone');
  assert.equal(addr.status, 'consistent'); assert.equal(phone.status, 'consistent');
  assert.match(addr.reason, /^Matches another location/);
  assert.equal(addr.needs_qa, 0);
});

test('a listing at a third, unknown address is still a conflict', () => {
  const extracted = { name: 'Empire Netting & Fence', address: '100 Main St, Omaha, NE 68102', phone: '(402) 682-7658' };
  const out = classify(canonical, extracted, { extractionConfidence: 0.9, locations });
  assert.equal(out.find(f => f.field === 'address').status, 'conflict');
});
