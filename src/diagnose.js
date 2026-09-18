import { config } from './config.js';
import { extractListing, usageToday } from './extract/claude.js';
import { searchPlaces } from './canonical/places.js';
import { fetchPage } from './fetch/page.js';
import { refreshProxyUsage } from './proxyUsage.js';

const ok = (name, detail) => ({ name, status: 'ok', detail });
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix });
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix });

const SAMPLE = {
  title: 'Anvil Fence Company - Garden City, ID',
  description: '',
  jsonld: [],
  text: `Anvil Fence Company
106 E 46th Pl, Garden City, ID 83714
Phone: (208) 375-6653
Website: anvilfence.com
Hours: Mon-Fri 8:00 AM - 5:00 PM, Sat Closed, Sun Closed
In business since 1958.
Services: wood fence, vinyl fence, chain link fence, ornamental iron.`,
};

// Runs one real (tiny) Claude call plus cheap config checks. ~$0.001 on Haiku.
export async function diagnose({ callClaude = true } = {}) {
  const out = [];

  // 1. Claude
  if (!config.anthropicKey && !process.env.ANTHROPIC_AUTH_TOKEN) {
    out.push(fail('Claude API key', 'ANTHROPIC_API_KEY is not set', 'Create a key at console.anthropic.com (Billing must have credit), then add it in Render → Environment.'));
  } else if (!callClaude) {
    out.push(warn('Claude API key', 'Set, but not tested on this run', 'Run the full check to make a live call.'));
  } else {
    const t = Date.now();
    try {
      const { data, cost } = await extractListing(SAMPLE, 'https://example.com/listing', { name: 'Anvil Fence Company', city: 'Garden City', phone: '(208) 375-6653' });
      const got = [data.name && 'name', data.phone && 'phone', data.address && 'address', data.year_founded && 'year', data.services?.length && 'services'].filter(Boolean);
      out.push(ok('Claude extraction', `${config.model} answered in ${((Date.now() - t) / 1000).toFixed(1)}s for $${cost.toFixed(4)}. Read back: ${got.join(', ') || 'nothing'}.`));
    } catch (e) {
      const m = e.message || String(e);
      const fix = /authentication|invalid x-api-key|401/i.test(m) ? 'The key is wrong or revoked. Create a fresh one at console.anthropic.com and update it in Render → Environment.'
        : /credit balance|billing|402/i.test(m) ? 'The account has no credit. Add a balance at console.anthropic.com → Billing.'
        : /not_found|model/i.test(m) ? `Your account may not have access to ${config.model}. Set CLAUDE_MODEL to claude-sonnet-5 in Render → Environment.`
        : /daily .* cap/i.test(m) ? 'Daily cap hit. Raise DAILY_CLAUDE_CALLS / DAILY_COST_LIMIT_USD, or wait for the UTC-midnight reset.'
        : 'Send this message to your developer.';
      out.push(fail('Claude extraction', m.slice(0, 400), fix));
    }
  }

  // 2. Google Places (canonical GBP facts)
  if (!config.placesKey) {
    out.push(warn('Google Places API', 'Not set, so facts come from the website instead of Google Business Profile', 'Optional, and it needs a billing account on Google Cloud. "Refresh canonical facts" reads the client website and fills in name, address, phone, hours, year founded and services without it.'));
  } else {
    try {
      const hits = await searchPlaces('Anvil Fence Company Garden City ID');
      out.push(hits.length ? ok('Google Places API', `Working. Test lookup returned "${hits[0].name}".`) : warn('Google Places API', 'Key works but the test lookup found nothing', 'Usually fine.'));
    } catch (e) {
      out.push(fail('Google Places API', (e.message || '').slice(0, 300), 'Enable "Places API (New)" in Google Cloud and confirm the key has no referrer restriction.'));
    }
  }

  // 3. Discovery provider
  const chain = String(config.discoveryProvider).split(',').map(s => s.trim()).filter(Boolean);
  const viaScraper = config.fetchProxy.provider === 'scraperapi' && Boolean(config.fetchProxy.key);
  if (viaScraper && callClaude) {
    try {
      const { search } = await import('./discovery/providers/scraperapi-google.js');
      const t = Date.now();
      const hits = await search('"Anvil Fence Company" Boise ID');
      out.push(hits.length
        ? ok('Search discovery', `Google results through ScraperAPI: ${hits.length} for a test query in ${((Date.now() - t) / 1000).toFixed(1)}s. No Google Cloud setup needed.`)
        : warn('Search discovery', 'ScraperAPI Google search answered but returned no results for the test query', 'Usually transient. Try the check again.'));
    } catch (e) {
      out.push(fail('Search discovery', (e.message || '').slice(0, 200), 'Check the ScraperAPI key and that the dashboard still shows credits.'));
    }
  } else if (viaScraper) {
    out.push(warn('Search discovery', 'ScraperAPI Google search is configured, not tested on this run', 'Run the full check to make a live search.'));
  } else if (chain.includes('google-cse') && !(config.googleCse.key && config.googleCse.cx)) {
    out.push(warn('Search discovery', `Chain is "${config.discoveryProvider}" but no search key is set, so it falls back to DuckDuckGo`, 'DuckDuckGo rate-limits after a few queries. Adding a ScraperAPI key turns on real Google results with no other setup.'));
  } else {
    out.push(ok('Search discovery', `Provider chain: ${config.discoveryProvider}`));
  }

  // 4. Profile fetching
  try {
    const p = await fetchPage('https://www.anvilfence.com/', { allowFallbacks: false });
    out.push(p.text.length > 500 ? ok('Outbound fetching', `Fetched a live page (${p.text.length.toLocaleString()} chars).`) : warn('Outbound fetching', `Reachable but thin response (HTTP ${p.status})`, ''));
  } catch (e) {
    out.push(fail('Outbound fetching', (e.message || '').slice(0, 200), 'The host may be blocking outbound requests.'));
  }
  if (!config.fetchProxy.provider || !config.fetchProxy.key) {
    out.push(warn('Scraping proxy', 'Not set, so Yelp, YellowPages, BBB, Angi and Manta cannot be read', 'Optional but high value. Sign up free at scraperapi.com, then set FETCH_PROXY=scraperapi and FETCH_PROXY_KEY to the dashboard key.'));
  } else if (!callClaude) {
    out.push(warn('Scraping proxy', `${config.fetchProxy.provider} configured, not tested on this run`, 'Run the full check to fetch a real blocked page through it.'));
  } else {
    // Prove it against a site that reliably refuses plain requests. Costs one credit.
    const probe = 'https://www.yelp.com/biz/anvil-fence-company-garden-city';
    try {
      const t = Date.now();
      const p = await fetchPage(probe);
      const secs = ((Date.now() - t) / 1000).toFixed(1);
      const pu = await refreshProxyUsage(true);
      const credits = pu ? ` ${pu.left.toLocaleString()} of ${pu.limit.toLocaleString()} credits left, renewing ${pu.renews}.` : '';
      if (p.method.startsWith('proxy') && p.text.length > 1500) {
        out.push(ok('Scraping proxy', `${config.fetchProxy.provider} read a live Yelp page in ${secs}s (${p.text.length.toLocaleString()} chars).${credits}`));
      } else if (p.method.startsWith('proxy')) {
        out.push(warn('Scraping proxy', `${config.fetchProxy.provider} responded but returned little content (${p.text.length} chars)`, 'The key works; that page may be an interstitial. Try an audit and check the evidence page.'));
      } else {
        out.push(fail('Scraping proxy', `Fell through to "${p.method}" instead of the proxy. ${p.error || ''}`.slice(0, 300),
          'Usually a wrong or exhausted key. Check FETCH_PROXY is exactly "scraperapi" (or "scrapingbee") and that the dashboard still shows credits.'));
      }
    } catch (e) {
      out.push(fail('Scraping proxy', (e.message || '').slice(0, 250), 'Check the key on your scraperapi.com dashboard.'));
    }
  }

  // 5. Report output
  out.push(config.serviceAccountJson
    ? ok('Report output', 'Google service account set: reports write to a Google Sheet.')
    : warn('Report output', 'No service account, so reports are written as CSV files', 'CSV downloads work fine for a demo. Add GOOGLE_SERVICE_ACCOUNT_JSON for real Sheets.'));

  // 6. Persistence
  out.push(process.env.GH_DB_TOKEN && process.env.GH_DB_REPO
    ? ok('Database persistence', `Synced to ${process.env.GH_DB_REPO}`)
    : warn('Database persistence', `Database at ${config.dbPath} is wiped on restart and redeploy`, 'On a free host the app sleeps after 15 idle minutes and loses data. Set GH_DB_TOKEN and GH_DB_REPO to keep it.'));

  const u = usageToday();
  return { checks: out, usage: u, blocking: out.filter(c => c.status === 'fail').length };
}
