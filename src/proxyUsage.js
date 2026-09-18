import { config } from './config.js';

// ScraperAPI's account endpoint, cached so every page can show credits left without a
// network call per render. Refreshed when stale and after each audit.
const TTL_MS = 5 * 60_000;
const cache = { data: null, at: 0, inflight: null };

export const enabled = () => config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key);
export function proxyUsage() { return cache.data; }

export function refreshProxyUsage(force = false) {
  if (!enabled()) return Promise.resolve(null);
  if (!force && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data);
  if (cache.inflight) return cache.inflight;
  cache.inflight = (async () => {
    try {
      const res = await fetch(`https://api.scraperapi.com/account?api_key=${config.fetchProxy.key}`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`account ${res.status}`);
      const d = await res.json();
      cache.data = { left: d.creditsLeft, limit: d.requestLimit, used: d.requestCount, renews: String(d.nextBillingDate || '').slice(0, 10), concurrency: d.concurrencyLimit, at: new Date().toISOString() };
    } catch (e) {
      // Keep whatever we had; a stale number beats a blank one, and the setup check reports failures.
      console.error('[proxy-usage]', e.message);
    } finally { cache.at = Date.now(); cache.inflight = null; }
    return cache.data;
  })();
  return cache.inflight;
}
