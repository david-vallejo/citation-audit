import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as N from '../src/compare/normalize.js';
import { classify, compareAddress, compareHours, compareName } from '../src/compare/classify.js';

test('phone normalization', () => {
  assert.equal(N.normPhone('(918) 555-0123'), '9185550123');
  assert.equal(N.normPhone('+1 918.555.0123'), '9185550123');
  assert.equal(N.fmtPhone('9185550123'), '(918) 555-0123');
});

test('address normalization treats St/Street and suite forms alike', () => {
  const f = compareAddress({ street: '123 North Main Street, Suite 4', city: 'Tulsa', state: 'Oklahoma', zip: '74103' }, '123 N Main St Ste 4, Tulsa, OK 74103-1234');
  assert.equal(f.status, 'consistent');
  const g = compareAddress({ street: '123 N Main St Ste 4', city: 'Tulsa', state: 'OK', zip: '74103' }, '123 N Main St, Tulsa, OK 74103');
  assert.equal(g.status, 'conflict');
  assert.equal(g.needs_qa, 1);
  const h = compareAddress({ street: '123 N Main St', city: 'Tulsa', state: 'OK', zip: '74103' }, '456 Elm Ave, Tulsa, OK 74103');
  assert.equal(h.status, 'conflict');
  assert.equal(h.needs_qa, 0);
});

test('name comparison', () => {
  assert.equal(compareName('Anvil Fence Co', 'Anvil Fence Company, LLC').status, 'consistent');
  assert.equal(compareName('Anvil Fence Co', 'Anvil Fencing & Deck').status, 'conflict');
  assert.equal(compareName('Anvil Fence Co', 'Bob\'s Plumbing').confidence < 0.6, true);
});

test('hours parsing and comparison', () => {
  const canon = { mon: [{ open: '08:00', close: '17:00' }], tue: [{ open: '08:00', close: '17:00' }], wed: [{ open: '08:00', close: '17:00' }], thu: [{ open: '08:00', close: '17:00' }], fri: [{ open: '08:00', close: '17:00' }], sat: 'closed', sun: 'closed' };
  assert.equal(compareHours(canon, { mon: '8:00 AM - 5:00 PM', tue: '8am–5pm', wed: '8:00 am to 5:00 pm', thu: '8 - 5', fri: '8:00AM-5:00PM', sat: 'Closed', sun: 'Closed' }).status, 'consistent');
  const f = compareHours(canon, { mon: '8:00 AM - 5:00 PM', tue: '8:00 AM - 5:00 PM', wed: '8:00 AM - 5:00 PM', thu: '8:00 AM - 5:00 PM', fri: '8:00 AM - 4:00 PM', sat: '9:00 AM - 12:00 PM', sun: 'Closed' });
  assert.equal(f.status, 'conflict');
  assert.match(f.reason, /fri, sat/);
  assert.equal(N.normHours('Mon-Fri: 8am-5pm; Sat: Closed').fri[0].close, '17:00');
  assert.equal(compareHours(canon, null).status, 'unable_to_verify');
});

test('classify end to end', () => {
  const canonical = { name: { value: 'Anvil Fence Co' }, address: { value: { street: '123 N Main St', city: 'Tulsa', state: 'OK', zip: '74103' } }, phone: { value: '(918) 555-0123' }, website: { value: 'https://anvilfence.com' }, hours: { value: null }, year_founded: { value: 1998 }, services: { value: ['Wood fence', 'Vinyl fence', 'Chain link'] } };
  const extracted = { name: 'Anvil Fence', address: { street: '123 N. Main Street', city: 'Tulsa', state: 'OK', zip: '74103' }, phone: '918-555-0199', website: 'http://www.anvilfence.com/contact', hours: null, year_founded: 1998, services: ['Wood Fences', 'Iron Fence'], confidence: 0.9 };
  const out = Object.fromEntries(classify(canonical, extracted, { extractionConfidence: 0.9 }).map(f => [f.field, f]));
  assert.equal(out.name.status, 'consistent');
  assert.equal(out.name.needs_qa, 1);
  assert.equal(out.address.status, 'consistent');
  assert.equal(out.phone.status, 'conflict');
  assert.equal(out.phone.needs_qa, 0);
  assert.equal(out.website.status, 'consistent');
  assert.equal(out.hours.status, 'unable_to_verify');
  assert.equal(out.year_founded.status, 'consistent');
  assert.equal(out.services.status, 'conflict');
  assert.match(out.services.reason, /Iron Fence/);
});

test('url normalization + directory classification', async () => {
  assert.equal(N.normalizeUrl('https://www.yelp.com/biz/anvil-fence-tulsa?utm_source=x#top'), 'https://yelp.com/biz/anvil-fence-tulsa');
  const { classifyUrl } = await import('../src/discovery/directories.js');
  assert.equal(classifyUrl('https://www.yelp.com/biz/anvil-fence-tulsa', 'anvilfence.com').kind, 'profile');
  assert.equal(classifyUrl('https://www.yelp.com/search?find_desc=fence', 'anvilfence.com').kind, 'directory-nonprofile');
  assert.equal(classifyUrl('https://anvilfence.com/about', 'anvilfence.com').kind, 'own-site');
  assert.equal(classifyUrl('https://www.bbb.org/us/ok/tulsa/profile/fence-contractors/anvil-fence-0995-1234', 'anvilfence.com').directory, 'bbb');
});
