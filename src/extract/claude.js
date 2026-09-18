import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { get, insert, uuid, now } from '../db.js';

let client;
function getClient() {
  if (!config.anthropicKey && !process.env.ANTHROPIC_AUTH_TOKEN) throw new Error('ANTHROPIC_API_KEY is not set (see .env.example)');
  return (client ??= new Anthropic({ apiKey: config.anthropicKey || undefined }));
}

// $ per million tokens: [input, output]. Cache reads bill at 0.1x input, cache writes at 1.25x.
const PRICES = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10], 'claude-sonnet-4-6': [3, 15], 'claude-opus-5': [5, 25], 'claude-opus-4-8': [5, 25], 'claude-fable-5-1': [10, 50] };
// The API returns dated ids (claude-haiku-4-5-20251001), so match on the longest
// price-table key the id starts with rather than requiring an exact hit.
function priceFor(model) {
  if (PRICES[model]) return PRICES[model];
  const key = Object.keys(PRICES).filter(k => String(model || '').startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? PRICES[key] : PRICES['claude-opus-5'];
}
function estimateCost(model, u) {
  const [i, o] = priceFor(model);
  return ((u.input_tokens || 0) * i + (u.cache_read_input_tokens || 0) * i * 0.1 + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.output_tokens || 0) * o) / 1e6;
}
export function usageToday() {
  const day = new Date().toISOString().slice(0, 10);
  const r = get('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(input_tokens + cache_read + cache_write), 0) AS input_tokens FROM llm_usage WHERE at >= ?', [`${day}T00:00:00`]);
  return { day, calls: r.calls, cost: r.cost, input_tokens: r.input_tokens, calls_limit: config.dailyClaudeCalls, cost_limit: config.dailyCostLimitUsd };
}
export class BudgetError extends Error {}
function assertBudget() {
  const u = usageToday();
  if (u.calls >= u.calls_limit) throw new BudgetError(`daily Claude call cap reached (${u.calls}/${u.calls_limit}); raise DAILY_CLAUDE_CALLS or re-run tomorrow`);
  if (u.cost >= u.cost_limit) throw new BudgetError(`daily Claude spend cap reached ($${u.cost.toFixed(2)}/$${u.cost_limit.toFixed(2)}); raise DAILY_COST_LIMIT_USD or re-run tomorrow`);
}
function recordUsage(purpose, model, u) {
  const cost = estimateCost(model, u);
  insert('llm_usage', { id: uuid(), purpose, model, input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0, cache_read: u.cache_read_input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, cost_usd: cost, at: now() });
  return cost;
}

// Structured outputs support `anyOf` but not type-union arrays, and reject
// numeric constraints (minimum/maximum). Keep the schema to the documented subset.
const nullable = t => ({ anyOf: [{ type: t }, { type: 'null' }] });
const nullableList = () => ({ anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] });
const nullableObject = (props, description) => ({
  anyOf: [
    { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props },
    { type: 'null' },
  ],
  ...(description ? { description } : {}),
});
// Plain string, empty when the page doesn't list it. Keeps the parameter out of the
// union budget (structured outputs allow at most 16 union-typed parameters).
const blankable = description => ({ type: 'string', ...(description ? { description } : {}) });

const LISTING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_profile_page', 'name', 'address', 'phone', 'website', 'hours', 'year_founded', 'services', 'categories', 'email', 'confidence', 'notes'],
  properties: {
    is_profile_page: { type: 'boolean', description: 'true if this page is a listing/profile for exactly one business' },
    name: nullable('string'),
    address: nullableObject(
      { street: blankable(), city: blankable(), state: blankable(), zip: blankable() },
      'Use "" for any part the page does not show; use null only when no address appears at all',
    ),
    phone: nullable('string'),
    website: nullable('string'),
    hours: nullableObject(
      { mon: blankable(), tue: blankable(), wed: blankable(), thu: blankable(), fri: blankable(), sat: blankable(), sun: blankable() },
      'Per-day string exactly as listed, e.g. "8:00 AM - 5:00 PM", "Closed", "Open 24 hours". Use "" for a day the page does not list; use null only when no hours appear at all',
    ),
    year_founded: nullable('integer'),
    services: nullableList(),
    categories: nullableList(),
    email: nullable('string'),
    confidence: { type: 'number', description: 'Between 0 and 1: how confident you are that the extracted values belong to the target business and were read correctly' },
    notes: nullable('string'),
  },
};

const SYSTEM = `You extract business listing facts from web page text for a local-SEO citation audit.
Rules:
- Only report values that are literally present on the page for the TARGET business. Never infer, guess, or fill from general knowledge. Use null when a value is not on the page.
- If the page shows several businesses (search results, category page), set is_profile_page=false and extract the entry that matches the target, if any.
- Copy values verbatim (do not reformat phone numbers, do not expand abbreviations). Hours: one string per day as printed.
- Inside the address and hours objects use an empty string "" for anything the page does not show. Use null for the whole object only when the page shows no address / no hours at all.
- year_founded: only from explicit statements like "Established 1998", "Founded in 2005", "In business since 2010", "Years in business: 12" (convert relative claims using the page's evident date only if stated).
- services: the named services/offerings the listing itself enumerates (not review text). categories: the directory's category labels for the listing.
- Structured data (JSON-LD) on the page is the most reliable source when present.
- If the page is an error, login wall, or unrelated, set is_profile_page=false, confidence low, and explain in notes.`;

function pageBlock(page, url) {
  const parts = [`URL: ${url}`];
  if (page.title) parts.push(`TITLE: ${page.title}`);
  if (page.description) parts.push(`META DESCRIPTION: ${page.description}`);
  if (page.jsonld?.length) parts.push(`JSON-LD:\n${JSON.stringify(page.jsonld).slice(0, 12_000)}`);
  parts.push(`PAGE TEXT:\n${(page.text || '').slice(0, config.maxPageChars)}`);
  return parts.join('\n\n');
}

export async function extractListing(page, url, target, { isOwnSite = false } = {}) {
  assertBudget();
  const targetDesc = isOwnSite
    ? `This is the business's OWN website. Extract its facts, focusing on year founded, services offered, phone, address, hours and email.`
    : `TARGET BUSINESS: ${target.name}${target.city ? `, ${target.city}` : ''}${target.phone ? ` (phone ${target.phone})` : ''}. The listing may use a slightly different spelling; use address/phone to confirm identity.`;
  const model = config.model;
  const supportsEffort = !/haiku-4-5|sonnet-4-5|opus-4-5/.test(model);
  const useFallbacks = /opus-5|fable/.test(model);
  const params = {
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { ...(supportsEffort ? { effort: 'low' } : {}), format: { type: 'json_schema', schema: LISTING_SCHEMA } },
    messages: [{ role: 'user', content: `${targetDesc}\n\n${pageBlock(page, url)}` }],
  };
  const res = useFallbacks
    ? await getClient().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await getClient().messages.create(params);
  const cost = recordUsage(isOwnSite ? 'website' : 'citation', res.model || model, res.usage);
  if (res.stop_reason === 'refusal') throw new Error(`extraction refused: ${res.stop_details?.explanation || res.stop_details?.category || 'unspecified'}`);
  if (res.stop_reason === 'max_tokens') throw new Error('extraction truncated (max_tokens)');
  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const data = JSON.parse(text);
  data.address = data.address && Object.values(data.address).some(Boolean) ? data.address : null;
  data.hours = data.hours && Object.values(data.hours).some(Boolean) ? data.hours : null;
  data.confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0));
  return { data, usage: res.usage, model: res.model, cost };
}
