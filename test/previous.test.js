import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, matchesPreviousPhone, matchesPreviousAddress } from '../src/compare/classify.js';
import { parsePreviousInput } from '../src/db.js';

const previous = { addresses: ['1304 Holtwood Rd, Holtwood, PA 17532'], phones: ['(717) 501-1712'] };
const canonical = {
  name: { value: 'Kingdom Fence & Supply' },
  address: { value: '87 Mill St, Fawn Grove, PA 17321' },
  phone: { value: '(717) 798-9300' },
  website: { value: 'https://kingdomfence.net/' },
};

test('parsePreviousInput splits phones from addresses', () => {
  const p = parsePreviousInput('1304 Holtwood Rd, Holtwood, PA 17532\n(717) 501-1712\n\n717.555.0100');
  assert.deepEqual(p.addresses, ['1304 Holtwood Rd, Holtwood, PA 17532']);
  assert.deepEqual(p.phones, ['(717) 501-1712', '717.555.0100']);
});

test('previous phone and address are recognized in any format', () => {
  assert.equal(matchesPreviousPhone(previous, '717-501-1712'), true);
  assert.equal(matchesPreviousPhone(previous, '(717) 798-9300'), false);
  assert.equal(matchesPreviousAddress(previous, { street: '1304 Holtwood Road', city: 'Holtwood', state: 'PA', zip: '17532-9747' }), true);
  assert.equal(matchesPreviousAddress(previous, '87 Mill St, Fawn Grove, PA 17321'), false);
});

test('a listing with the old address and phone is a confident conflict, not QA', () => {
  const extracted = { name: 'Kingdom Fence and Supply', address: { street: '1304 Holtwood Rd', city: 'Holtwood', state: 'PA', zip: '17532' }, phone: '(717) 501-1712', website: null };
  const out = classify(canonical, extracted, { extractionConfidence: 0.6, previous });
  const addr = out.find(f => f.field === 'address'), phone = out.find(f => f.field === 'phone');
  assert.equal(addr.status, 'conflict'); assert.equal(phone.status, 'conflict');
  assert.match(addr.reason, /^Still shows the previous address/);
  assert.match(phone.reason, /^Still shows the previous phone/);
  assert.equal(addr.needs_qa, 0); assert.equal(phone.needs_qa, 0);
});

test('without previous info the same listing is an ordinary conflict', () => {
  const extracted = { name: 'Kingdom Fence and Supply', address: '1304 Holtwood Rd, Holtwood, PA 17532', phone: '(717) 501-1712' };
  const out = classify(canonical, extracted, { extractionConfidence: 0.95 });
  assert.doesNotMatch(out.find(f => f.field === 'phone').reason, /previous/);
});
