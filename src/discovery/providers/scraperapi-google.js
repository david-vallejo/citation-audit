import { config } from '../../config.js';
import { fetchWithTimeout, mapLimit } from '../../fetch/page.js';

// Real Google results through ScraperAPI's structured SERP endpoint. It reuses the same
// key as the scraping proxy, so there is nothing new to sign up for, and it does not
// depend on Google Cloud's Custom Search API, which now refuses new projects outright.
// Result links arrive as google.com/goto redirect wrappers; each is followed once to
// recover the real URL. That follow is a plain request and costs no credits.
async function resolve(link) {
  if (!link) return null;
  if (!/google\.com\/goto\?/.test(link)) return link;
  try {
    const res = await fetchWithTimeout(link, { timeout: 15_000 });
    const final = res.url && !/google\.com\/goto/.test(res.url) ? res.url : null;
    // Only the final URL is wanted. An unread body holds the socket open, and enough
    // of those keep the process from ever exiting.
    res.body?.cancel().catch(() => {});
    return final;
  } catch { return null; }
}

export function available() {
  return config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key);
}

export async function search(query, { limit = 10 } = {}) {
  if (!available()) throw new Error('scraperapi-google needs FETCH_PROXY=scraperapi and FETCH_PROXY_KEY');
  const url = `https://api.scraperapi.com/structured/google/search?api_key=${config.fetchProxy.key}&query=${encodeURIComponent(query)}&country_code=us&num=${Math.min(limit, 10)}`;
  const res = await fetchWithTimeout(url, { timeout: 90_000 });
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`scraperapi-google ${res.status}: ${text.slice(0, 120)}`); }
  if (!res.ok || j.error) throw new Error(`scraperapi-google ${res.status}: ${j.error || 'error'}`);
  const rows = j.organic_results || [];
  const out = await mapLimit(rows, 4, async r => ({ url: await resolve(r.link), title: r.title || '', snippet: r.snippet || '' }));
  return out.filter(r => r.url);
}
