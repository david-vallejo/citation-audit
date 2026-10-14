import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameStreet, closingMatch, closingFindings, CLOSING, CLOSING_PHONE, CHECK } from '../src/report/listings.js';

const closing = { address: '1489 Kelly Ave, Akron, OH 44306', phone: '(614) 259-7427', city: 'Akron', street: '1489 Kelly Ave' };

test('the same street matches across spellings and suite numbers', () => {
  assert.equal(sameStreet('1489 Kelly Avenue, Akron, OH 44306', closing.address), true);
  assert.equal(sameStreet('1341 Hughes Ford Road, Ste. 110, Frederick, MD 21703', '1341 Hughes Ford Rd #110, Frederick, MD 21701'), true);
  assert.equal(sameStreet('2580 Groveport Rd, Columbus, OH 43207', closing.address), false);
});

test('a listing is matched by address first, then phone, then a mention', () => {
  assert.equal(closingMatch({ address: '1489 Kelly Ave, Akron, OH 44306', phone: '(330) 238-3816' }, closing), 'address');
  assert.equal(closingMatch({ address: '2671 Sawbury Blvd, Columbus, OH 43235', phone: '614-259-7427' }, closing), 'phone');
  assert.equal(closingMatch({ text: 'https://example.com/akron/shly-deck-fence' }, closing), 'mention');
  assert.equal(closingMatch({ address: '100 Bell Ave, Carnegie, PA 15106', phone: '(412) 515-6575', text: 'Carnegie' }, closing), null);
});

test('closing findings say what to do with each group', () => {
  const f = closingFindings([
    { site: 'Yelp', status: CLOSING_PHONE, address: '2671 Sawbury Blvd, Columbus, OH 43235' },
    { site: 'fencecompanydirectory.us', status: CLOSING },
    { site: 'Facebook', status: CHECK },
  ], closing, [{ why: 'another location' }]).join('\n');
  assert.match(f, /1 listing\(s\) show the Akron location.*fencecompanydirectory\.us/);
  assert.match(f, /use the Akron phone, \(614\) 259-7427: Yelp \(2671 Sawbury/);
  assert.match(f, /1 other listing\(s\) belong to the business's other locations/);
});
