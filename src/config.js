import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const TOOL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const p = join(TOOL_DIR, '.env');
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k, d = '') => (process.env[k] ?? d).trim();

export const config = {
  anthropicKey: env('ANTHROPIC_API_KEY'),
  model: env('CLAUDE_MODEL', 'claude-haiku-4-5'),
  dailyClaudeCalls: parseInt(env('DAILY_CLAUDE_CALLS', '80'), 10),
  dailyCostLimitUsd: parseFloat(env('DAILY_COST_LIMIT_USD', '1.00')),
  maxPageChars: parseInt(env('MAX_PAGE_CHARS', '20000'), 10),
  placesKey: env('GOOGLE_PLACES_API_KEY'),
  discoveryProvider: env('DISCOVERY_PROVIDER', 'ddg'),
  discoverySiteQueries: parseInt(env('DISCOVERY_SITE_QUERIES', '6'), 10),
  googleCse: { key: env('GOOGLE_CSE_KEY'), cx: env('GOOGLE_CSE_CX') },
  serpapiKey: env('SERPAPI_KEY'),
  fetchProxy: { provider: env('FETCH_PROXY'), key: env('FETCH_PROXY_KEY') },
  proxyAttempts: parseInt(env('PROXY_ATTEMPTS', '3'), 10),
  proxyCountry: env('PROXY_COUNTRY'),
  waybackFallback: env('WAYBACK_FALLBACK', '1') !== '0',
  serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'),
  shareWith: env('SHEET_SHARE_WITH').split(',').map(s => s.trim()).filter(Boolean),
  dbPath: resolve(TOOL_DIR, env('DB_PATH', 'data/citation-audit.sqlite')),
  reportsDir: join(TOOL_DIR, 'reports'),
  qaThreshold: parseFloat(env('QA_CONFIDENCE_THRESHOLD', '0.8')),
  fetchConcurrency: parseInt(env('FETCH_CONCURRENCY', '4'), 10),
  qaPort: parseInt(env('QA_PORT', '8322'), 10),
};

export const AUDIT_FIELDS = ['name', 'address', 'phone', 'website', 'hours', 'year_founded', 'services'];
export const PHASE2_FIELDS = ['categories', 'email'];
