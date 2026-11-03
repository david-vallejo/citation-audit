import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameVariants, webQueries } from '../src/discovery/index.js';
import { unwrapUrl, normalizeUrl } from '../src/compare/normalize.js';

test('name variants cover swapped words and & / and', () => {
  assert.deepEqual(nameVariants('Empire Netting & Fence').sort(), ['Empire Fence & Netting', 'Empire Fence and Netting', 'Empire Netting & Fence', 'Empire Netting and Fence']);
  assert.deepEqual(nameVariants('Anvil Fence Company'), ['Anvil Fence Company']);
});

test('web queries search every location, phone format and the street', () => {
  const q = webQueries({ name: { value: 'Empire Netting & Fence' }, address: { value: '14650 Woodstock Blvd, Waverly, NE 68462' }, phone: { value: '4026827658' } },
    { name: 'Empire', website: 'https://empire-fence.com/', locations_json: JSON.stringify({ addresses: ['Shawnee, KS'], phones: [] }) });
  for (const want of ['"402-682-7658"', '"(402) 682-7658"', '"14650 Woodstock Blvd" Waverly', '"Empire Netting" Waverly NE', '"Empire Netting" Shawnee KS']) assert.ok(q.includes(want), want);
  assert.ok(q.every(x => !x.startsWith('"Empire') || !x.includes('Netting & Fence"') || x.includes('-site:empire-fence.com') || /reviews$/.test(x)));
});

test('login walls and bot gates unwrap to the profile behind them', () => {
  assert.equal(unwrapUrl('https://www.facebook.com/login/?next=https%3A%2F%2Fwww.facebook.com%2Fempirenettingandfence%2F'), 'https://www.facebook.com/empirenettingandfence/');
  assert.equal(normalizeUrl('https://www.showmelocal.com/norobots.aspx?a=1&src=%2fprofile.aspx%3fbid%3d39117144'), 'https://showmelocal.com/profile.aspx?bid=39117144');
  assert.equal(unwrapUrl('https://www.yelp.com/biz/x?next=/'), 'https://www.yelp.com/biz/x?next=/');
});

test('Facebook page links in every current format count as profiles', async () => {
  const { classifyUrl } = await import('../src/discovery/directories.js');
  for (const u of ['https://www.facebook.com/p/Summit-Fence-61556716297370/', 'https://www.facebook.com/people/Summit-Fence/61556716297370/', 'https://www.facebook.com/profile.php?id=61556716297370', 'https://www.facebook.com/summitfence']) assert.equal(classifyUrl(u, 'summitfences.com').kind, 'profile', u);
  for (const u of ['https://www.facebook.com/people/search', 'https://www.facebook.com/groups/123']) assert.notEqual(classifyUrl(u, 'summitfences.com').kind, 'profile', u);
});

test('DuckDuckGo results unwrap to the real listing URL', async () => {
  const { parse } = await import('../src/discovery/providers/ddg.js');
  const html = '<div class="result results_links results_links_deep web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.yelp.com%2Fbiz%2Fsummit-fence-akron-2&amp;rut=x">Summit Fence - Akron, OH - Yelp</a><a class="result__snippet" href="#">Fence company in Akron</a></div>';
  assert.deepEqual(parse(html), [{ url: 'https://www.yelp.com/biz/summit-fence-akron-2', title: 'Summit Fence - Akron, OH - Yelp', snippet: 'Fence company in Akron' }]);
});
