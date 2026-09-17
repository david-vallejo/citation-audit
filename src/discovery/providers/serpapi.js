import { config } from '../../config.js';

// Paid (100 free searches/month on the free plan). Real Google results incl. local pack.
export async function search(query, { limit = 20 } = {}) {
  if (!config.serpapiKey) throw new Error('SERPAPI_KEY is required for the serpapi provider');
  const url = `https://serpapi.com/search.json?engine=google&num=${Math.min(limit, 100)}&q=${encodeURIComponent(query)}&api_key=${config.serpapiKey}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!res.ok || j.error) throw new Error(`serpapi: ${j.error || res.status}`);
  return (j.organic_results || []).map(r => ({ url: r.link, title: r.title, snippet: r.snippet }));
}
