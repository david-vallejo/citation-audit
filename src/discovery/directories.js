// Known citation sources. `profile` matches a business profile URL (vs. a search/category page).
const DIRECTORIES = [
  { key: 'yelp', host: /(^|\.)yelp\.com$/, profile: /\/biz\/[^/?]+/ },
  { key: 'yellowpages', host: /(^|\.)yellowpages\.com$/, profile: /\/mip\/|\/[a-z-]+\/[a-z0-9-]+-\d+$/ },
  { key: 'bbb', host: /(^|\.)bbb\.org$/, profile: /\/profile\// },
  { key: 'angi', host: /(^|\.)(angi|angieslist)\.com$/, profile: /\/companylist\/us\/|\/company\// },
  { key: 'homeadvisor', host: /(^|\.)homeadvisor\.com$/, profile: /\/rated\./ },
  { key: 'houzz', host: /(^|\.)houzz\.com$/, profile: /\/professionals\/|\/pro\// },
  { key: 'thumbtack', host: /(^|\.)thumbtack\.com$/, profile: /\/service\/|\/[a-z]{2}\/[a-z-]+\/[a-z-]+\/[a-z0-9-]+\/service/ },
  { key: 'porch', host: /(^|\.)porch\.com$/, profile: /\/[a-z-]+\/[a-z-]+\/[a-z0-9-]+\/pp$|\/pro\// },
  { key: 'buildzoom', host: /(^|\.)buildzoom\.com$/, profile: /\/contractor\// },
  { key: 'nextdoor', host: /(^|\.)nextdoor\.com$/, profile: /\/pages\// },
  { key: 'facebook', host: /(^|\.)facebook\.com$/, profile: /^\/(?!search|groups|events|marketplace|people|pages\/category|login|public)[A-Za-z0-9.]+\/?$|\/pages\/[^/]+\/\d+/ },
  { key: 'mapquest', host: /(^|\.)mapquest\.com$/, profile: /\/us\/[a-z-]+\/[a-z0-9-]+-\d+$/ },
  { key: 'manta', host: /(^|\.)manta\.com$/, profile: /\/c\// },
  { key: 'superpages', host: /(^|\.)superpages\.com$/, profile: /\/bp\// },
  { key: 'merchantcircle', host: /(^|\.)merchantcircle\.com$/, profile: /\/[a-z0-9-]+-[a-z]{2}$/ },
  { key: 'hotfrog', host: /(^|\.)hotfrog\.com$/, profile: /\/company\// },
  { key: 'chamberofcommerce', host: /(^|\.)chamberofcommerce\.com$/, profile: /\/business-directory\/|\/united-states\// },
  { key: 'foursquare', host: /(^|\.)foursquare\.com$/, profile: /\/v\// },
  { key: 'alignable', host: /(^|\.)alignable\.com$/, profile: /\/[a-z-]+\/[a-z0-9-]+$/ },
  { key: 'dexknows', host: /(^|\.)dexknows\.com$/, profile: /\/business_profiles\// },
  { key: 'elocal', host: /(^|\.)elocal\.com$/, profile: /\/profile\// },
  { key: 'showmelocal', host: /(^|\.)showmelocal\.com$/, profile: /\/profile\.aspx|\/\d+-/ },
  { key: 'cylex', host: /(^|\.)cylex\.us\.com$/, profile: /\/company\// },
  { key: 'brownbook', host: /(^|\.)brownbook\.net$/, profile: /\/business\// },
  { key: 'ezlocal', host: /(^|\.)ezlocal\.com$/, profile: /\/[a-z]{2}\/[a-z-]+\/[a-z-]+\/\d+/ },
  { key: 'citysquares', host: /(^|\.)citysquares\.com$/, profile: /\/b\// },
  { key: 'local', host: /(^|\.)local\.com$/, profile: /\/business\// },
  { key: 'localsearch', host: /(^|\.)localsearch\.com$/, profile: /\// },
  { key: 'yellowbook', host: /(^|\.)yellowbook\.com$/, profile: /\/profile\// },
  { key: 'bizapedia', host: /(^|\.)bizapedia\.com$/, profile: /\/[a-z]{2}\// },
  { key: 'dnb', host: /(^|\.)dnb\.com$/, profile: /\/business-directory\/company-profiles/ },
  { key: 'expertise', host: /(^|\.)expertise\.com$/, profile: /\// },
  { key: 'birdeye', host: /(^|\.)birdeye\.com$/, profile: /\// },
  { key: 'crunchbase', host: /(^|\.)crunchbase\.com$/, profile: /\/organization\// },
  { key: 'linkedin', host: /(^|\.)linkedin\.com$/, profile: /\/company\// },
  { key: 'instagram', host: /(^|\.)instagram\.com$/, profile: /^\/[A-Za-z0-9_.]+\/?$/ },
  { key: 'pinterest', host: /(^|\.)pinterest\.com$/, profile: /^\/[A-Za-z0-9_]+\/?$/ },
  { key: 'youtube', host: /(^|\.)youtube\.com$/, profile: /^\/(@|channel\/|c\/)/ },
  { key: 'x', host: /(^|\.)(x|twitter)\.com$/, profile: /^\/[A-Za-z0-9_]+\/?$/ },
  { key: 'bing-places', host: /(^|\.)bing\.com$/, profile: /\/maps.*(ypid|cp=)/ },
  { key: 'apple-maps', host: /(^|\.)maps\.apple\.com$/, profile: /place|\?q=/ },
  { key: 'nicelocal', host: /(^|\.)nicelocal\.com$/, profile: /\// },
  { key: 'yellowpagecity', host: /(^|\.)yellowpagecity\.com$/, profile: /\// },
  // Fence-industry directories (verified live; fencecertified + thefencegroup both
  // surfaced real contractor profiles during discovery testing).
  { key: 'americanfenceassociation', host: /(^|\.)americanfenceassociation\.com$/, profile: /\/(member|directory|find)/i },
  { key: 'fencecertified', host: /(^|\.)fencecertified\.com$/, profile: /\/company\// },
  { key: 'thefencegroup', host: /(^|\.)thefencegroup\.com$/, profile: /\/members\/business\// },
];

// Directories worth an explicit `site:` query during discovery (highest-value NAP sources for contractors).
export const PRIORITY_KEYS = ['yelp', 'yellowpages', 'bbb', 'angi', 'homeadvisor', 'houzz', 'facebook', 'thumbtack', 'porch', 'mapquest', 'manta', 'nextdoor', 'buildzoom', 'superpages'];
export const PRIORITY_SITES = { yelp: 'yelp.com', yellowpages: 'yellowpages.com', bbb: 'bbb.org', angi: 'angi.com', homeadvisor: 'homeadvisor.com', houzz: 'houzz.com', facebook: 'facebook.com', thumbtack: 'thumbtack.com', porch: 'porch.com', mapquest: 'mapquest.com', manta: 'manta.com', nextdoor: 'nextdoor.com', buildzoom: 'buildzoom.com', superpages: 'superpages.com' };

// Hosts that mention businesses but are not citations: job boards, government lookups, bid aggregators.
const NOISE_HOSTS = /(^|\.)(google\.[a-z.]+|wikipedia\.org|amazon\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|zillow\.com|realtor\.com|reddit\.com|quora\.com|duckduckgo\.com|apple\.com|microsoft\.com|fcc\.report|fmcsa\.dot\.gov|[a-z]+bids\.com)$/;

export function classifyUrl(url, clientHost) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (clientHost && (host === clientHost || host.endsWith('.' + clientHost))) return { kind: 'own-site', host };
  if (NOISE_HOSTS.test(host)) return { kind: 'noise', host };
  for (const d of DIRECTORIES) {
    if (d.host.test(host)) return { kind: d.profile.test(u.pathname + u.search) ? 'profile' : 'directory-nonprofile', host, directory: d.key };
  }
  return { kind: 'other', host, directory: host };
}
