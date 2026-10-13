import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFindings, siteLabel, FIX, WRONG_LOCATION, CHECK } from '../src/report/listings.js';
import { comparePhone, compareWebsite } from '../src/compare/classify.js';

test('site labels read like directory names', () => {
  assert.equal(siteLabel('bbb', 'https://bbb.org/x'), 'BBB');
  assert.equal(siteLabel('fencetrac.com', 'https://fencetrac.com/x'), 'FenceTrac');
  assert.equal(siteLabel('ye.maptons.com', 'https://ye.maptons.com/p/1'), 'maptons.com');
});

test('key findings group listings by problem', () => {
  const f = keyFindings([
    { site: 'Manta', status: FIX, issues: [{ type: 'other_city', key: 'Lincoln, NE' }, { type: 'phone', key: '(402) 858-6119' }] },
    { site: 'Houzz', status: FIX, issues: [{ type: 'other_city', key: 'Lincoln, NE' }, { type: 'name', key: 'Empire Fence & Netting' }] },
    { site: 'MapQuest', status: WRONG_LOCATION, issue: { type: 'wrong_location', key: 'Atlanta, GA' } },
    { site: 'Facebook', status: CHECK, issue: { type: 'manual' } },
  ]);
  assert.match(f[0], /Lincoln, NE \(Manta and Houzz\)/);
  assert.match(f.join('\n'), /Atlanta, GA \(MapQuest\)/);
  assert.match(f.join('\n'), /\(402\) 858-6119 on Manta/);
  assert.match(f.join('\n'), /manual look: Facebook/);
});

test('a hidden phone or a cut-off link is not a mismatch', () => {
  assert.equal(comparePhone('(402) 682-7658', '402-XXX-XXXX').status, 'unable_to_verify');
  assert.equal(compareWebsite('https://empire-fence.com/', 'https://www.empire-fence.').status, 'unable_to_verify');
  assert.equal(compareWebsite('https://empire-fence.com/', 'Empire Netting & Fence').status, 'unable_to_verify');
  assert.equal(compareWebsite('https://empire-fence.com/', 'https://empirenetting.com/').status, 'conflict');
});
