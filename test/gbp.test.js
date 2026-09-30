import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareGbpToWebsite } from '../src/compare/gbp.js';

const site = { name: 'Anvil Fence Co', address: '106 E 46th Pl, Garden City, ID 83714', phone: '(208) 555-0123', hours: null };
const gbp = { name: 'Anvil Fence Co', address: { street: '106 E 46th Pl', city: 'Garden City', state: 'ID', zip: '83714' }, phone: '2085550123', website: 'https://anvilfence.com/', hours: null };
const by = rows => Object.fromEntries(rows.map(r => [r.field, r]));

test('matching profile and website are consistent', () => {
  const r = by(compareGbpToWebsite(gbp, site, 'https://www.anvilfence.com'));
  for (const f of ['name', 'address', 'phone', 'website']) assert.equal(r[f].status, 'consistent', f);
  assert.equal(r.hours.status, 'unable_to_verify');
});

test('a different street on the profile is a conflict showing both values', () => {
  const r = by(compareGbpToWebsite({ ...gbp, address: { street: '9 Main St', city: 'Boise', state: 'ID', zip: '83702' } }, site, 'https://anvilfence.com'));
  assert.equal(r.address.status, 'conflict');
  assert.match(r.address.gbp, /9 Main St/);
  assert.match(r.address.website, /106 E 46th Pl/);
  assert.equal(r.address.needs_qa, 0);
});

test('a profile with no website link is a conflict', () => {
  const r = by(compareGbpToWebsite({ ...gbp, website: '' }, site, 'https://anvilfence.com'));
  assert.equal(r.website.status, 'conflict');
});

test('service-area profile with a hidden street is not flagged unless the city differs', () => {
  const hidden = { ...gbp, address: { street: '', city: 'Garden City', state: 'ID', zip: '' } };
  assert.equal(by(compareGbpToWebsite(hidden, site, 'https://anvilfence.com')).address.status, 'unable_to_verify');
  const moved = { ...hidden, address: { ...hidden.address, city: 'Nampa' } };
  assert.equal(by(compareGbpToWebsite(moved, site, 'https://anvilfence.com')).address.status, 'conflict');
});

test('nothing on the website to compare is unable to verify, not a conflict', () => {
  const r = by(compareGbpToWebsite(gbp, null, 'https://anvilfence.com'));
  assert.equal(r.address.status, 'unable_to_verify');
  assert.equal(r.phone.status, 'unable_to_verify');
});
