import { fetchWithTimeout, sleep } from '../../fetch/page.js';

const decode = s => (s || '').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();

// Free, keyless. DuckDuckGo's HTML endpoint rate-limits aggressively (~3-5 quick queries), so: slow cadence,
// one automatic retry after a cool-off, and a clear error so the provider chain can fail over.
export async function search(query, { limit = 25, attempt = 1 } = {}) {
  const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeout: 25_000 });
  const html = await res.text();
  const blocks = html.split(/<div class="result results_links/).slice(1);
  if (res.status !== 200 || (!blocks.length && /anomaly|bots|captcha|error getting results/i.test(html))) {
    if (attempt === 1) { await sleep(45_000); return search(query, { limit, attempt: 2 }); }
    throw new Error(`ddg rate-limited (HTTP ${res.status}) even after a 45s cool-off; switch DISCOVERY_PROVIDER or add google-cse to the chain`);
  }
  const out = [];
  for (const b of blocks) {
    const a = b.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;
    let url = decode(a[1]);
    const u = url.match(/[?&]uddg=([^&]+)/);
    if (u) url = decodeURIComponent(u[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url)) continue;
    const snip = b.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
    out.push({ url, title: decode(a[2]), snippet: decode(snip?.[1]) });
    if (out.length >= limit) break;
  }
  await sleep(6000 + Math.random() * 4000);
  return out;
}
