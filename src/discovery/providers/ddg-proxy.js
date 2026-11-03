import { config } from '../../config.js';
import { fetchWithTimeout, sleep } from '../../fetch/page.js';
import { parse } from './ddg.js';

// DuckDuckGo's HTML results through the ScraperAPI key. Unlike Google's results, whose links
// are now google.com/goto pages that no longer redirect, every link here carries the real URL,
// and a plain page costs about one credit instead of a Google search's twenty-five.
export function available() {
  return config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key);
}

export async function search(query, { limit = 30 } = {}) {
  if (!available()) throw new Error('ddg-proxy needs FETCH_PROXY=scraperapi and FETCH_PROXY_KEY');
  const target = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=us-en`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetchWithTimeout(`https://api.scraperapi.com/?api_key=${config.fetchProxy.key}&url=${encodeURIComponent(target)}`, { timeout: 90_000 });
      const html = await res.text();
      if (res.ok && /result__a|No results\.|No results found/i.test(html)) return parse(html, limit);
      last = `ddg-proxy ${res.status}`;
    } catch (e) { last = `ddg-proxy ${e.message}`; }
    await sleep(2000 * attempt);
  }
  throw new Error(last);
}
