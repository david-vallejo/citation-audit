import { config } from './config.js';
import { extractListing, usageToday } from './extract/claude.js';
import { searchPlaces } from './canonical/places.js';
import { fetchPage } from './fetch/page.js';

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
    out.push(warn('Google Places API', 'Not set, so GBP facts are skipped', 'Optional. Without it, enter the canonical name/address/phone by hand on the client page.'));
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
  if (chain.includes('google-cse') && !(config.googleCse.key && config.googleCse.cx)) {
    out.push(warn('Search discovery', `Chain is "${config.discoveryProvider}" but GOOGLE_CSE_KEY/CX are missing, so it falls back to DuckDuckGo`, 'DuckDuckGo rate-limits after a few queries. Add a Programmable Search key for reliable discovery.'));
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
  if (!config.fetchProxy.provider) {
    out.push(warn('Scraping proxy', 'Not set: Yelp, YellowPages, BBB and Angi will return 403', 'Optional. Add a free ScraperAPI key as FETCH_PROXY=scraperapi and FETCH_PROXY_KEY=… to verify those.'));
  } else {
    out.push(ok('Scraping proxy', `${config.fetchProxy.provider} configured`));
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
