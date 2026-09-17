import { config } from '../../config.js';

// Free tier: 100 queries/day. Needs a Programmable Search Engine set to "search the entire web".
export async function search(query, { limit = 10 } = {}) {
  const { key, cx } = config.googleCse;
  if (!key || !cx) throw new Error('GOOGLE_CSE_KEY and GOOGLE_CSE_CX are required for the google-cse provider');
  const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&num=${Math.min(limit, 10)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  const j = await res.json();
  if (!res.ok) throw new Error(`google-cse ${res.status}: ${j.error?.message || 'error'}`);
  return (j.items || []).map(i => ({ url: i.link, title: i.title, snippet: i.snippet }));
}
