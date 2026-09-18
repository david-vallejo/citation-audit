import { config } from '../config.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_TEXT = 40_000;

export async function fetchWithTimeout(url, { timeout = 20_000, headers = {} } = {}) {
  const ctrl = new AbortController();
  // The timer stays armed after the headers arrive so a body that trickles in is cut
  // off too; clearing it on success would guard only the first byte. unref lets a CLI
  // exit without waiting on it, and firing after a finished read is a harmless no-op.
  const t = setTimeout(() => ctrl.abort(), timeout);
  t.unref?.();
  try {
    return await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', ...headers } });
  } catch (e) { clearTimeout(t); throw e; }
}

function extractJsonLd(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { const j = JSON.parse(m[1].trim()); out.push(...(Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j])); } catch { /* skip malformed */ }
  }
  return out;
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) || [])[1] || '';
  let t = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<a\s[^>]*href=["'](tel:[^"']+|mailto:[^"']+)["'][^>]*>/gi, ' [$1] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/[ \t\r]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: title.trim(), description: desc.trim(), text: t };
}

function looksBlocked(status, body) {
  if ([401, 403, 405, 429, 503].includes(status)) return true;
  const head = body.slice(0, 4000).toLowerCase();
  return body.length < 1500 || /access denied|are you a human|captcha|verify you are|unusual traffic|enable javascript and cookies|attention required|request blocked|px-captcha|just a moment/.test(head);
}

function fromHtml(html, status, method, finalUrl, extra = {}) {
  const { title, description, text } = htmlToText(html);
  return { status, method, title, description, text: text.slice(0, MAX_TEXT), jsonld: extractJsonLd(html), finalUrl, ...extra };
}

// Layer 1: plain fetch with a browser UA.
async function direct(url) {
  const res = await fetchWithTimeout(url);
  const html = await res.text();
  if (looksBlocked(res.status, html)) return { blocked: true, status: res.status };
  return fromHtml(html, res.status, 'direct', res.url);
}

// Layer 2: scraping proxy with a free tier (FETCH_PROXY=scraperapi|scrapingbee + key). Handles most bot walls.
// These services retry the target internally and still surface a transient 500 fairly often,
// so a single attempt under-reports what the proxy can actually reach.
async function proxy(url) {
  const { provider, key } = config.fetchProxy;
  if (!provider || !key) return null;
  // Escalate to residential proxies only after a plain attempt fails, so the cheaper
  // route is tried first. Yelp and BBB generally need the premium tier; most others do not.
  // country_code is geotargeting and is not available on free plans: sending it makes
  // every request fail with a 500. Opt in with PROXY_COUNTRY once on a paid plan.
  const geo = config.proxyCountry ? `&country_code=${config.proxyCountry}` : '';
  const build = premium => provider === 'scraperapi'
    ? `https://api.scraperapi.com/?api_key=${key}&url=${encodeURIComponent(url)}${geo}${premium ? '&premium=true' : ''}`
    : provider === 'scrapingbee'
      ? `https://app.scrapingbee.com/api/v1/?api_key=${key}&url=${encodeURIComponent(url)}&render_js=false${geo}${premium ? '&premium_proxy=true' : ''}`
      : null;
  if (!build(false)) throw new Error(`unknown FETCH_PROXY "${provider}"`);
  let last = '';
  for (let attempt = 1; attempt <= config.proxyAttempts; attempt++) {
    const target = build(attempt > 1);
    let res, html;
    try {
      res = await fetchWithTimeout(target, { timeout: 90_000 });
      html = await res.text();
    } catch (e) { last = e.message; if (attempt < config.proxyAttempts) { await sleep(2000 * attempt); continue; } break; }
    if (res.ok && !looksBlocked(200, html)) return fromHtml(html, 200, `proxy:${provider}${attempt > 1 ? '+premium' : ''}`, url);
    last = `${provider} ${res.status}`;
    // 4xx other than 429 means the target really is missing or refused; retrying wastes credits.
    const retryable = res.status >= 500 || res.status === 429 || res.ok;
    if (!retryable || attempt === config.proxyAttempts) break;
    await sleep(2000 * attempt);
  }
  throw new Error(last || `${provider} failed`);
}

// Layer 3: Jina Reader (free, keyless). Works for many mid-tier directories; the big ones block it too.
async function reader(url) {
  const res = await fetchWithTimeout(`https://r.jina.ai/${url}`, { timeout: 45_000, headers: { Accept: 'text/plain', 'X-Return-Format': 'markdown' } });
  const body = await res.text();
  if (!res.ok || body.length < 500 || /^error/i.test(body.trim())) throw new Error(`reader ${res.status}`);
  const title = (body.match(/^Title:\s*(.*)$/m) || [])[1] || '';
  return { status: res.status, method: 'reader', title, description: '', text: body.slice(0, MAX_TEXT), jsonld: [], finalUrl: url };
}

// Layer 4: Wayback Machine (free). Evidence is dated, so findings from it are capped in confidence and routed to QA.
async function wayback(url) {
  if (!config.waybackFallback) return null;
  const res = await fetchWithTimeout(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { timeout: 20_000 });
  if (!res.ok) throw new Error(`wayback ${res.status}`);
  const j = await res.json();
  const snap = j?.archived_snapshots?.closest;
  if (!snap?.available) throw new Error('no archived copy');
  const page = await fetchWithTimeout(snap.url.replace(/^http:/, 'https:').replace(/\/web\/(\d+)\//, '/web/$1id_/'), { timeout: 40_000 });
  const html = await page.text();
  if (!page.ok || html.length < 1500) throw new Error(`wayback page ${page.status}`);
  const date = `${snap.timestamp.slice(0, 4)}-${snap.timestamp.slice(4, 6)}-${snap.timestamp.slice(6, 8)}`;
  return fromHtml(html, 200, 'archive', snap.url, { archivedOn: date });
}

const empty = (status, method, error) => ({ status, method, title: '', description: '', text: '', jsonld: [], error });

// Returns { status, method: direct|proxy:*|reader|archive|blocked|error, title, description, text, jsonld, error?, archivedOn? }
export async function fetchPage(url, { allowFallbacks = true, skipArchive = false } = {}) {
  let first;
  try {
    const r = await direct(url);
    if (!r.blocked) return r;
    first = { status: r.status };
  } catch (e) { first = { status: 0, error: e.message }; }
  if (!allowFallbacks) return empty(first.status, first.error ? 'error' : 'blocked', first.error || `HTTP ${first.status}`);
  const tried = [first.error ? `direct: ${first.error}` : `direct: HTTP ${first.status}`];
  for (const layer of (skipArchive ? [proxy, reader] : [proxy, reader, wayback])) {
    try { const r = await layer(url); if (r) return r; }
    catch (e) { tried.push(`${layer.name}: ${e.message}`); }
  }
  return empty(first.status, first.error ? 'error' : 'blocked', tried.join('; '));
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
