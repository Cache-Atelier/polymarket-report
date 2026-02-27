#!/usr/bin/env node
// Polymarket Report — Offline Curation Script
// Fetches enriched Polymarket data, builds an editorial briefing,
// calls an LLM (via OpenRouter / OpenCode Zen fallback) for headline curation,
// and writes the result to data/headlines.json for static serving.

// ============================================
// CONFIGURATION
// ============================================
const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const PRICE_HISTORY_TOP_N = 30;
const PRICE_HISTORY_CONCURRENCY = 5;

const AI_PROVIDERS = [
  {
    name: 'openrouter-opus',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'anthropic/claude-opus-4-6',
    envKey: 'OPENROUTER_API_KEY',
  },
  {
    name: 'opencode-minimax',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    model: 'minimax-m2.5',
    envKey: 'OPENCODE_API_KEY',
  },
];

const TOTAL_MARKETS = 28;           // 1 main story + 27 in columns
const LLM_CANDIDATE_POOL = 50;      // Send more context to a smarter model
const WHALE_TRADE_THRESHOLD = 10000; // USD minimum for whale trade detection
const WHALE_LOOKBACK_MINUTES = 360;  // 6 hours — wider window for 2x/day runs
const RESOLVED_LOOKBACK_HOURS = 24;  // Recently resolved markets

// Tag-based content curation (same categories as before)
const TAG_IDS = [
  { id: 2,      label: 'Politics' },
  { id: 100265, label: 'Geopolitics' },
  { id: 1401,   label: 'Tech' },
];

const TAG_SLUGS = [
  'elections', 'us-elections', 'global-elections', 'congress', 'courts', 'scotus',
  'world', 'ukraine', 'middle-east', 'china', 'iran', 'israel',
  'economy', 'economic-policy', 'fed', 'tariffs', 'trade-war', 'business',
  'science', 'space', 'ai',
];

// Ranking weights
const WEIGHTS = {
  volume: 0.35,
  priceChange: 0.25,
  whale: 0.25,
  newTrending: 0.10,
  featuredBoost: 1.25,
};

const VOLUME_FLOOR = 25_000;
const VOLUME_FLOOR_PENALTY = 0.4;

const SPREAD_PENALTY_THRESHOLD = 0.10; // $0.10 spread
const SPREAD_PENALTY = 0.6;

const EXPIRY_DRIFT = {
  daysThreshold: 7,
  priceExtremeBelow: 0.15,
  priceExtremeAbove: 0.85,
  dampener: 0.3,
};

const IMMINENT_RESOLUTION_HOURS = 24;

// ============================================
// TIER 1: HARD NOISE FILTERS (always exclude — never newsworthy)
// ============================================
const HARD_NOISE_PATTERNS = [
  // ---- CRYPTO PRICES ----
  /\b(bitcoin|btc|ethereum|eth|solana|sol|doge|dogecoin|xrp|bnb|cardano|avax|matic|polkadot|shib|pepe|memecoin|altcoin|litecoin|toncoin|chainlink|sui|apt|aptos|sei|near|fantom|ftm|arb|arbitrum|optimism|stx|bonk|wif|jup|pyth|render|ondo|fet|kaspa)\b.*\b(price|above|below|reach|hit|close|end at|trade at|worth|all.time.high|ath|market cap)\b/i,
  /\bprice of\b.*\b(bitcoin|btc|eth|ethereum|sol|solana|crypto|token|coin)\b/i,
  /\bcrypto\b.*\b(price|above|below|market cap|dominance)\b/i,
  /\b(btc|eth|sol|bitcoin|ethereum|solana|doge|xrp|bnb)\b.*\$[\d,]+/i,
  /\$[\d,]+.*\b(btc|eth|sol|bitcoin|ethereum|solana)\b/i,

  // ---- STOCK / COMMODITY PRICES ----
  /\b(stock price|share price|market cap|NASDAQ|S&P 500|Dow Jones|DJIA|NYSE|Russell 2000)\b/i,
  /\b(AAPL|MSFT|GOOGL|GOOG|AMZN|TSLA|NVDA|META|NFLX|AMD|INTC|CRM|ORCL|UBER|ABNB|COIN|PLTR|RIVN|LCID)\b.*\b(price|above|below|close|reach|hit|trade)\b/i,
  /\b(gold|silver|crude oil|natural gas|WTI|Brent|copper|platinum)\b.*\b(price|above|below|per ounce|per barrel|close)\b/i,

  // ---- SPORTS: PLAYER STATS & PERFORMANCE ----
  /\b(passing yards?|rushing yards?|receiving yards?|touchdowns?|interceptions?|sacks?|tackles?|completions?|passer rating|quarterback rating|field goals? (made|attempted|percentage))\b/i,
  /\b(rebounds?|assists?|steals?|blocks?|three.pointers?|free throws?|double.double|triple.double|points? per game|minutes? per game)\b/i,
  /\b(home runs?|RBIs?|batting average|ERA|earned run|strikeouts?|walks?|hits? (allowed)?|innings? pitched|on.base percentage|slugging|WAR|OPS)\b/i,
  /\b(goals? scored|clean sheets?|hat tricks?|saves? (made|percentage)|shots? on (target|goal)|expected goals|xG)\b/i,
  /\b(aces?|double faults?|break points?|unforced errors?|winners?|first serve)\b/i,
  /\b(knockouts?|TKO|submission|decision|rounds? (?:won|fought)|significant strikes?|takedowns?)\b/i,

  // ---- SPORTS: GAME STRUCTURE ----
  /\b(first quarter|second quarter|third quarter|fourth quarter|halftime|half.time|overtime|extra time|penalty shootout|sudden death|extra innings?|seventh.inning stretch)\b/i,

  // ---- SPORTS: BETTING LANGUAGE ----
  /\b(spread|over.?under|moneyline|money line|point total|prop bet|parlay|handicap|odds (of|at|to)|point spread|run line|puck line|total (points|goals|runs|sets))\b/i,

  // ---- SPORTS: POSITIONS ----
  /\b(quarterback|wide receiver|running back|tight end|linebacker|cornerback|safety|pitcher|catcher|shortstop|outfielder|designated hitter|goalie|goalkeeper|striker|midfielder|defender|winger|point guard|shooting guard|small forward|power forward|center(?! for))\b/i,

  // ---- SPORTS: BOXING / MMA ----
  /\b(boxing|MMA|mixed martial arts|bout|title fight|championship fight|fight card|weigh.in|undercard|main event winner|co.main)\b/i,

  // ---- SPORTS: RACING ----
  /\b(horse rac|IndyCar|Daytona|Le Mans|rally|qualifying|pole position|pit stop|lap time|podium finish)\b/i,

  // ---- ESPORTS ----
  /\besports?\b/i,
  /\b(league of legends|dota|counter-?strike|cs ?2|valorant|overwatch|fortnite|apex legends|rocket league|call of duty)\b/i,

  // ---- SOCIAL MEDIA ACTIVITY ----
  /\btweet(s|ed)?\b/i,
  /\bretweet\b/i,
  /\bpost(s|ed)? on (x|twitter|instagram|threads)\b/i,
  /\b(x|twitter) (post|follower)/i,
  /\bfollowers? (on|count|reach)\b/i,

  // ---- YOUTUBE / STREAMING ----
  /\b(youtube|twitch|tiktok|kick)\b.*\b(views|subscribers|followers|likes|stream)\b/i,
  /\bsubscribers?\b.*\b(youtube|channel)\b/i,

  // ---- NOVELTY / PARANORMAL ----
  /\b(second coming|jesus christ return|rapture)\b/i,
  /\baliens? exist\b/i,
  /\bextraterrestrial life\b/i,
  /\bUFO disclosure\b/i,
];

// ============================================
// TIER 2: SOFT NOISE CATEGORIES (LLM decides — sometimes newsworthy)
// Markets matching these get passed to the LLM with a flag.
// ============================================
const SOFT_NOISE_PATTERNS = [
  {
    category: 'weather',
    pattern: /\b(temperature|high of \d|low of \d|degrees? (fahrenheit|celsius|f\b|c\b)|weather forecast|precipitation|inches? of (snow|rain)|snowfall|rainfall)\b/i,
    guidance: 'Weather markets are usually bot-farmed daily forecasts. Only include if it represents a genuinely significant weather event (historic storm, hurricane, major disaster).',
  },
  {
    category: 'entertainment',
    pattern: /\b(box office|opening weekend|gross(ed|ing)?|Oscar|Academy Award|Grammy|Emmy|Golden Globe|Tony Award|BAFTA|Billboard|album sales|chart position|Bachelor(ette)?|Survivor|Big Brother|Love Island|American Idol|The Voice)\b/i,
    guidance: 'Entertainment markets are usually low-signal. Only include if it represents a major cultural moment with broad significance beyond the entertainment industry.',
  },
  {
    category: 'vs-matchup',
    pattern: /\bvs\.?\s/i,
    guidance: 'Usually sports matchups. Only include if it represents a policy confrontation, legal case, or geopolitical conflict.',
  },
  {
    category: 'sports-league',
    pattern: /\b(nfl|nba|mlb|nhl|mls|ncaa|wnba|ufc|wwe|pga|atp|wta|nascar|f1|formula (1|one)|premier league|champions league|la liga|serie a|bundesliga|ligue 1|super bowl|world series|stanley cup|march madness|world cup|euro 20\d\d|olympics|grand slam|grand prix|masters tournament|playoff|postseason|regular season|MVP award|heisman)\b/i,
    guidance: 'Sports markets are generally off-topic. Only include if the event has major political, economic, or cultural crossover (e.g., Olympics boycott, World Cup corruption scandal, stadium public funding debate).',
  },
];

// ============================================
// TAG-GATED FILTERING (Gamma API returns tags on each market)
// ============================================

const NOISE_TAG_SLUGS = new Set([
  'sports', 'nfl', 'nba', 'mlb', 'nhl', 'soccer', 'tennis', 'golf',
  'boxing', 'mma', 'racing', 'cricket', 'rugby', 'esports',
  'entertainment', 'culture', 'pop-culture', 'music', 'movies', 'tv', 'gaming',
  'crypto',
]);

const RELEVANT_TAG_SLUGS = new Set([
  'politics', 'geopolitics', 'elections', 'us-elections', 'global-elections',
  'congress', 'courts', 'scotus', 'economy', 'economic-policy',
  'fed', 'tariffs', 'trade-war', 'business', 'tech', 'ai',
  'science', 'space', 'world', 'ukraine', 'middle-east', 'china',
  'iran', 'israel', 'health', 'climate', 'finance',
]);

// ============================================
// TOPIC KEYWORD EXTRACTION (used for clustering and grouping)
// ============================================
const STOP_WORDS = new Set([
  'will','be','the','a','an','in','on','by','to','of','for','and','or',
  'is','it','at','if','do','no','yes','not','this','that','with','from',
  'has','have','was','are','been','its','than','before','after','during',
  'between','about','into','over','under','more','most','what','when',
  'who','how','which','their','there','these','those','other','new','first',
  'us', 'end', '2025', '2026', '2027',
]);

function extractTopicKeys(question) {
  return (question || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

// ============================================
// DATA FETCHING
// ============================================

async function resolveTagSlugs() {
  const results = await Promise.all(
    TAG_SLUGS.map(async (slug) => {
      try {
        const res = await fetch(`${GAMMA_API}/tags/slug/${slug}`);
        if (!res.ok) return null;
        const tag = await res.json();
        return { slug, id: tag.id, label: tag.label };
      } catch {
        return null;
      }
    })
  );
  const resolved = results.filter(Boolean);
  console.log(`Resolved ${resolved.length}/${TAG_SLUGS.length} tag slugs`);
  return resolved;
}

async function fetchFeaturedEvents() {
  try {
    const res = await fetch(
      `${GAMMA_API}/events?featured=true&active=true&closed=false&limit=30`
    );
    if (!res.ok) return [];
    const events = await res.json();
    const markets = [];
    for (const evt of events) {
      if (evt.markets && Array.isArray(evt.markets)) {
        for (const m of evt.markets) {
          markets.push({
            ...m,
            _isFeatured: true,
            _parentEventSlug: evt.slug,
            _parentEventTitle: evt.title,
          });
        }
      }
    }
    console.log(`  Featured: ${events.length} events → ${markets.length} markets`);
    return markets;
  } catch (err) {
    console.log(`  Featured events error: ${err.message}`);
    return [];
  }
}

async function fetchMarketsByTagId(id, label, limit = 50) {
  try {
    const res = await fetch(
      `${GAMMA_API}/markets?tag_id=${id}&active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`
    );
    if (!res.ok) return [];
    const markets = await res.json();
    if (markets.length > 0) {
      console.log(`  tag_id ${id} (${label}): ${markets.length} markets`);
    }
    return markets;
  } catch {
    return [];
  }
}

async function fetchRecentlyResolved() {
  try {
    // Fetch recently closed/resolved events
    const res = await fetch(
      `${GAMMA_API}/events?closed=true&limit=50&order=endDate&ascending=false`
    );
    if (!res.ok) return [];
    const events = await res.json();

    const cutoff = Date.now() - RESOLVED_LOOKBACK_HOURS * 60 * 60 * 1000;
    const recentMarkets = [];

    for (const evt of events) {
      if (!evt.markets || !Array.isArray(evt.markets)) continue;
      for (const m of evt.markets) {
        if (!m.resolved) continue;
        // Check if resolution is recent
        const endTime = new Date(m.endDate || evt.endDate || 0).getTime();
        const updatedTime = new Date(m.updatedAt || m.endDate || 0).getTime();
        const resolvedTime = Math.max(endTime, updatedTime);
        if (resolvedTime >= cutoff) {
          recentMarkets.push({
            ...m,
            _isRecentlyResolved: true,
            _parentEventSlug: evt.slug,
            _parentEventTitle: evt.title,
            _resolvedTime: new Date(resolvedTime).toISOString(),
          });
        }
      }
    }

    console.log(`  Recently resolved: ${recentMarkets.length} markets (last ${RESOLVED_LOOKBACK_HOURS}h)`);
    return recentMarkets;
  } catch (err) {
    console.log(`  Recently resolved error: ${err.message}`);
    return [];
  }
}

async function fetchImminentResolution() {
  try {
    const res = await fetch(
      `${GAMMA_API}/markets?active=true&closed=false&order=endDate&ascending=true&limit=50`
    );
    if (!res.ok) return [];
    const markets = await res.json();

    const cutoff = Date.now() + IMMINENT_RESOLUTION_HOURS * 60 * 60 * 1000;
    const imminent = [];
    for (const m of markets) {
      if (!m.endDate) continue;
      const endTime = new Date(m.endDate).getTime();
      if (endTime > Date.now() && endTime <= cutoff) {
        imminent.push({
          ...m,
          _isImminentResolution: true,
          _hoursUntilResolution: Math.round((endTime - Date.now()) / (1000 * 60 * 60)),
        });
      }
    }
    console.log(`  Imminent resolution: ${imminent.length} markets (next ${IMMINENT_RESOLUTION_HOURS}h)`);
    return imminent;
  } catch (err) {
    console.log(`  Imminent resolution error: ${err.message}`);
    return [];
  }
}

async function fetchWhaleTrades() {
  try {
    const res = await fetch(
      `${DATA_API}/trades?filterType=CASH&filterAmount=${WHALE_TRADE_THRESHOLD}`
    );
    if (!res.ok) return [];
    const trades = await res.json();
    const cutoff = Date.now() - WHALE_LOOKBACK_MINUTES * 60 * 1000;
    return (trades || []).filter(t => {
      const ts = new Date(t.timestamp || t.created_at || t.createdAt).getTime();
      return ts >= cutoff;
    });
  } catch (err) {
    console.error('Whale trade fetch failed:', err.message);
    return [];
  }
}

async function fetchAllMarkets() {
  console.log('Phase 1: Resolving tag slugs...');
  const resolvedTags = await resolveTagSlugs();

  const allTagIds = [
    ...TAG_IDS.map(t => ({ ...t, limit: 50 })),
    ...resolvedTags.map(t => ({ id: t.id, label: `${t.label} [${t.slug}]`, limit: 30 })),
  ];

  console.log(`Phase 2: Fetching from ${allTagIds.length} sources + featured + resolved + imminent...`);
  const [featured, resolved, imminent, ...tagResults] = await Promise.all([
    fetchFeaturedEvents(),
    fetchRecentlyResolved(),
    fetchImminentResolution(),
    ...allTagIds.map(t => fetchMarketsByTagId(t.id, t.label, t.limit)),
  ]);

  const tagMarkets = tagResults.flat();
  console.log(`Totals: ${featured.length} featured, ${resolved.length} resolved, ${imminent.length} imminent, ${tagMarkets.length} from tags`);

  return [...featured, ...resolved, ...imminent, ...tagMarkets];
}

// ============================================
// NOISE FILTERING (Two-tier)
// ============================================

function classifyNoise(market) {
  const question = market.question || market.title || '';

  // Tier 1: hard filter — always exclude
  if (HARD_NOISE_PATTERNS.some(p => p.test(question))) {
    return { excluded: true };
  }

  // Tier 2: soft filter — flag for LLM judgment
  const softFlags = [];
  for (const { category, pattern, guidance } of SOFT_NOISE_PATTERNS) {
    if (pattern.test(question)) {
      softFlags.push({ category, guidance });
    }
  }

  return { excluded: false, softFlags };
}

function classifyByTags(market) {
  const rawTags = market.tags;
  if (!rawTags || !Array.isArray(rawTags) || rawTags.length === 0) {
    return { action: 'keep', reason: 'no tags (pre-filtered by tag endpoint)', tags: [] };
  }

  const slugs = rawTags.map(t => {
    if (typeof t === 'string') return t.toLowerCase();
    return (t.slug || t.label || '').toLowerCase().replace(/\s+/g, '-');
  }).filter(Boolean);

  const hasRelevant = slugs.some(s => RELEVANT_TAG_SLUGS.has(s));
  const hasNoise = slugs.some(s => NOISE_TAG_SLUGS.has(s));

  if (hasRelevant) return { action: 'keep', reason: 'has relevant tag', tags: slugs };
  if (hasNoise) return { action: 'exclude', reason: 'only noise tags', tags: slugs };
  return { action: 'soft-flag', reason: 'unknown tags only', tags: slugs };
}

// ============================================
// RANKING
// ============================================

function getYesPrice(market) {
  try {
    if (market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      return parseFloat(prices[0]) || 0.5;
    }
    if (market.bestBid != null) return market.bestBid;
  } catch { /* ignore */ }
  return 0.5;
}

function getResolvedOutcome(market) {
  try {
    if (market.outcomePrices) {
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      const yesPrice = parseFloat(prices[0]) || 0;
      return yesPrice > 0.5 ? 'YES' : 'NO';
    }
  } catch { /* ignore */ }
  return 'UNKNOWN';
}

function getMajoritySide(sides) {
  const counts = {};
  for (const s of sides) {
    const key = (s || 'unknown').toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

function isNewAndTrending(market) {
  if (!market.createdAt) return false;
  const ageMs = Date.now() - new Date(market.createdAt).getTime();
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  return ageMs < threeDays && (market.volume24hr || 0) > 5000;
}

function rankAndEnrich(allMarkets, whaleTrades) {
  // Build whale trade index
  const whaleIndex = {};
  for (const trade of whaleTrades) {
    const mid = trade.market || trade.conditionId || trade.asset;
    if (!mid) continue;
    if (!whaleIndex[mid]) whaleIndex[mid] = { count: 0, totalUsd: 0, sides: [] };
    whaleIndex[mid].count += 1;
    whaleIndex[mid].totalUsd += parseFloat(trade.amount || trade.size || 0);
    whaleIndex[mid].sides.push(trade.side || trade.outcome);
  }

  // Deduplicate by market ID
  const marketMap = new Map();
  for (const m of allMarkets) {
    const id = m.id || m.conditionId;
    if (!id) continue;
    if (!marketMap.has(id)) {
      marketMap.set(id, {
        ...m,
        _absPriceChange: Math.abs(m.oneDayPriceChange || 0),
        _isFeatured: !!m._isFeatured,
        _isRecentlyResolved: !!m._isRecentlyResolved,
      });
    } else {
      const existing = marketMap.get(id);
      if (m._isFeatured) existing._isFeatured = true;
      if (m._isRecentlyResolved) {
        existing._isRecentlyResolved = true;
        existing._resolvedTime = m._resolvedTime;
      }
      if (m._isImminentResolution) {
        existing._isImminentResolution = true;
        existing._hoursUntilResolution = m._hoursUntilResolution;
      }
      if (m._parentEventTitle && !existing._parentEventTitle) {
        existing._parentEventTitle = m._parentEventTitle;
        existing._parentEventSlug = m._parentEventSlug;
      }
    }
  }

  // Two-tier noise filtering
  let hardFilterCount = 0;
  const softFlagged = new Map(); // id → softFlags[]
  for (const [id, m] of marketMap) {
    // Skip noise filtering for recently resolved — they're confirmed news
    if (m._isRecentlyResolved) continue;

    const { excluded, softFlags } = classifyNoise(m);
    if (excluded) {
      marketMap.delete(id);
      hardFilterCount++;
    } else if (softFlags && softFlags.length > 0) {
      softFlagged.set(id, softFlags);
    }
  }

  // Tag-gated filtering (second pass)
  let tagFilterCount = 0;
  for (const [id, m] of marketMap) {
    if (m._isRecentlyResolved) continue; // skip resolved
    const tagResult = classifyByTags(m);
    m._tagSlugs = tagResult.tags;
    if (tagResult.action === 'exclude') {
      marketMap.delete(id);
      tagFilterCount++;
    } else if (tagResult.action === 'soft-flag') {
      if (!softFlagged.has(id)) softFlagged.set(id, []);
      softFlagged.get(id).push({ category: 'tag-unknown', guidance: `${tagResult.reason}: tags=[${tagResult.tags.join(', ')}]. Only include if clearly newsworthy.` });
    }
  }

  const scorable = Array.from(marketMap.values());
  console.log(`${allMarkets.length} raw → ${scorable.length} after dedup + hard filter (${hardFilterCount} noise, ${tagFilterCount} tag-filtered, ${softFlagged.size} soft-flagged)`);

  if (scorable.length === 0) return [];

  // Normalization baselines (exclude resolved from normalization — they don't compete on movement)
  const active = scorable.filter(m => !m._isRecentlyResolved);
  const maxAbsChange = Math.max(...active.map(m => m._absPriceChange), 0.001);
  const maxVolume = Math.max(...active.map(m => m.volume24hr || 0), 1);

  // Score each market
  for (const m of scorable) {
    const id = m.id || m.conditionId;
    const whale = whaleIndex[id];

    // Recently resolved markets get a fixed high score — they're confirmed news
    if (m._isRecentlyResolved) {
      m._score = 0.9;
      m._resolvedOutcome = getResolvedOutcome(m);
      continue;
    }

    let priceSignal = m._absPriceChange / maxAbsChange;
    const volumeSignal = (m.volume24hr || 0) / maxVolume;
    const whaleSignal = whale ? Math.min(whale.count / 3, 1) : 0;
    const newTrendingSignal = isNewAndTrending(m) ? 1 : 0;

    // Expiry drift dampener — exempt imminent-resolution markets
    if (m.endDate) {
      const daysToExpiry = (new Date(m.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      const yesPrice = getYesPrice(m);

      if (daysToExpiry <= 0) {
        // Past endDate — market should have resolved. Dampen stale price signal.
        priceSignal *= 0.1;
      } else if (daysToExpiry <= 1) {
        // Genuinely imminent (0-24h) — flag it, don't dampen
        m._isImminentResolution = true;
        m._hoursUntilResolution = Math.round(daysToExpiry * 24);
      } else if (daysToExpiry <= EXPIRY_DRIFT.daysThreshold
          && (yesPrice < EXPIRY_DRIFT.priceExtremeBelow || yesPrice > EXPIRY_DRIFT.priceExtremeAbove)) {
        priceSignal *= EXPIRY_DRIFT.dampener;
      }
    }

    m._score = (volumeSignal * WEIGHTS.volume)
             + (priceSignal * WEIGHTS.priceChange)
             + (whaleSignal * WEIGHTS.whale)
             + (newTrendingSignal * WEIGHTS.newTrending);

    if ((m.volume24hr || 0) < VOLUME_FLOOR) m._score *= VOLUME_FLOOR_PENALTY;
    const spread = parseFloat(m.spread || 0);
    if (spread > SPREAD_PENALTY_THRESHOLD) m._score *= SPREAD_PENALTY;
    if (Math.abs(m.oneDayPriceChange || 0) < 0.005 && !whale) m._score *= 0.5;
    if (m._isFeatured) m._score *= WEIGHTS.featuredBoost;

    if (whale) {
      m._whaleInfo = whale;
      m.whaleSignal = `${whale.count} large trade(s) totaling ~$${Math.round(whale.totalUsd).toLocaleString()}, mostly ${getMajoritySide(whale.sides)}`;
    }
  }

  // Filter out static long-shot markets (no movement, low probability, no whale interest)
  const beforeStaticFilter = scorable.length;
  const filtered = scorable.filter(m => {
    if (m._isRecentlyResolved) return true; // always keep resolved
    const absChange = Math.abs(m.oneDayPriceChange || 0);
    const yesPrice = getYesPrice(m);
    const hasWhale = !!m._whaleInfo;
    // Near-zero movement + low probability + no whale = perpetual novelty, not news
    if (absChange < 0.005 && yesPrice < 0.15 && !hasWhale) return false;
    return true;
  });
  console.log(`Static long-shot filter: ${beforeStaticFilter} → ${filtered.length}`);

  // Sort by score
  filtered.sort((a, b) => b._score - a._score);

  // Event-level dedup: keep best per event, track group size
  const eventSeen = new Map();
  const deduped = [];
  for (const m of filtered) {
    const eSlug = m.events?.[0]?.slug || m._parentEventSlug || m.eventSlug || m.slug;
    if (eventSeen.has(eSlug)) {
      eventSeen.get(eSlug).count++;
      eventSeen.get(eSlug).siblings.push(m);
      if (m.whaleSignal && !eventSeen.get(eSlug).rep.whaleSignal) {
        eventSeen.get(eSlug).rep.whaleSignal = m.whaleSignal;
      }
      continue;
    }
    const entry = { rep: m, count: 1, siblings: [] };
    eventSeen.set(eSlug, entry);
    deduped.push(m);
  }
  for (const { rep, count, siblings } of eventSeen.values()) {
    rep._eventGroupSize = count;
    // Attach sibling market questions for holistic context
    if (siblings.length > 0) {
      rep._siblingMarkets = siblings.slice(0, 5).map(s => ({
        question: s.question,
        yesPrice: getYesPrice(s),
        priceChange: s.oneDayPriceChange || 0,
      }));
    }
  }

  console.log(`Event dedup: ${filtered.length} → ${deduped.length}`);

  // Topic-level cap (max 3 per topic cluster)
  const MAX_PER_TOPIC = 3;

  const topicClusters = [];
  for (const m of deduped) {
    const keys = extractTopicKeys(m.question || m.title);
    let bestCluster = null;
    let bestOverlap = 0;
    for (const cluster of topicClusters) {
      const overlap = keys.filter(k => cluster.keys.has(k)).length;
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      bestCluster.markets.push(m);
      for (const k of keys) bestCluster.keys.add(k);
    } else {
      topicClusters.push({ keys: new Set(keys), markets: [m] });
    }
  }

  const topicCapped = [];
  for (const cluster of topicClusters) {
    topicCapped.push(...cluster.markets.slice(0, MAX_PER_TOPIC));
  }
  topicCapped.sort((a, b) => b._score - a._score);

  console.log(`Topic cap: ${deduped.length} → ${topicCapped.length}`);

  // Build enriched candidate objects
  return topicCapped.slice(0, LLM_CANDIDATE_POOL).map(m => ({
    id: m.id || m.conditionId,
    question: m.question || m.title || 'Unknown Market',
    description: (m.description || '').substring(0, 500),
    slug: m.slug,
    eventSlug: m.events?.[0]?.slug || m._parentEventSlug || m.eventSlug || null,
    eventTitle: m._parentEventTitle || m.events?.[0]?.title || null,
    oneDayPriceChange: m.oneDayPriceChange || 0,
    volume24hr: m.volume24hr || 0,
    bestYesPrice: getYesPrice(m),
    resolved: !!m.resolved,
    isRecentlyResolved: !!m._isRecentlyResolved,
    resolvedOutcome: m._resolvedOutcome || null,
    resolvedTime: m._resolvedTime || null,
    isImminentResolution: !!m._isImminentResolution,
    hoursUntilResolution: m._hoursUntilResolution || null,
    endDate: m.endDate,
    whaleSignal: m.whaleSignal || null,
    isFeatured: !!m._isFeatured,
    score: Math.round(m._score * 1000) / 1000,
    eventGroupSize: m._eventGroupSize || 1,
    siblingMarkets: m._siblingMarkets || null,
    softNoiseFlags: softFlagged.get(m.id || m.conditionId) || null,
    clobTokenIds: m.clobTokenIds || null,
    resolutionSource: m.resolutionSource || null,
    tags: m._tagSlugs || [],
  }));
}

// ============================================
// PRICE HISTORY ENRICHMENT (CLOB API)
// ============================================

async function pMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function fetchPriceHistory(market) {
  try {
    let tokenIds = market.clobTokenIds;
    if (!tokenIds) return null;
    if (typeof tokenIds === 'string') tokenIds = JSON.parse(tokenIds);
    if (!Array.isArray(tokenIds) || tokenIds.length === 0) return null;
    const yesTokenId = tokenIds[0];

    const res = await fetch(
      `${CLOB_API}/prices-history?market=${yesTokenId}&interval=1w&fidelity=1440`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.history || !Array.isArray(data.history) || data.history.length === 0) return null;

    const sorted = data.history.sort((a, b) => a.t - b.t);
    return sorted.map(p => parseFloat(p.p));
  } catch {
    return null;
  }
}

async function enrichWithPriceHistory(candidates) {
  const top = candidates.slice(0, PRICE_HISTORY_TOP_N);
  if (top.length === 0) return;

  const t0 = Date.now();
  let enriched = 0;

  await pMap(top, async (market) => {
    const history = await fetchPriceHistory(market);
    if (history && history.length >= 2) {
      market.priceHistory = history;
      const first = history[0];
      const last = history[history.length - 1];
      const delta = last - first;
      market._priceTrend = {
        direction: delta > 0.01 ? 'rising' : delta < -0.01 ? 'falling' : 'flat',
        points: history.map(p => Math.round(p * 100)),
        delta: Math.round(delta * 100),
      };
      enriched++;
    }
  }, PRICE_HISTORY_CONCURRENCY);

  console.log(`Price history: ${enriched}/${top.length} enriched (${Date.now() - t0}ms)`);
}

// ============================================
// EDITORIAL BRIEFING BUILDER
// ============================================

function buildEditorialBriefing(candidates) {
  const sections = [];

  // Group by event for holistic context
  const eventGroups = new Map();
  const standalone = [];

  for (const m of candidates) {
    const eventKey = m.eventTitle || m.eventSlug;
    if (eventKey && m.eventGroupSize > 1) {
      if (!eventGroups.has(eventKey)) eventGroups.set(eventKey, []);
      eventGroups.get(eventKey).push(m);
    } else {
      standalone.push(m);
    }
  }

  // Recently resolved section
  const resolved = candidates.filter(m => m.isRecentlyResolved);
  if (resolved.length > 0) {
    sections.push('═══════════════════════════════════════');
    sections.push('RECENTLY RESOLVED — CONFIRMED OUTCOMES');
    sections.push('═══════════════════════════════════════');
    sections.push('These markets have resolved. You MAY state these as confirmed fact.\n');
    for (const m of resolved) {
      sections.push(`★ RESOLVED ${m.resolvedOutcome}: "${m.question}"`);
      sections.push(`  Resolved: ${m.resolvedTime}`);
      if (m.description) sections.push(`  Context: ${m.description}`);
      sections.push(`  id: ${m.id}`);
      sections.push('');
    }
  }

  // Imminent resolution section
  const imminent = candidates.filter(m => m.isImminentResolution && !m.isRecentlyResolved);
  if (imminent.length > 0) {
    sections.push('═══════════════════════════════════════');
    sections.push('RESOLVING WITHIN 24 HOURS — DEADLINE APPROACHING');
    sections.push('═══════════════════════════════════════');
    sections.push('These markets resolve VERY SOON. The outcome is about to be decided.\n');
    for (const m of imminent) {
      const hrs = m.hoursUntilResolution;
      sections.push(`DEADLINE ~${hrs}h: "${m.question}"`);
      sections.push(`  YES ${Math.round(m.bestYesPrice * 100)}% | vol $${Math.round(m.volume24hr).toLocaleString()}`);
      if (m.description) sections.push(`  Context: ${m.description}`);
      sections.push(`  id: ${m.id}`);
      sections.push('');
    }
  }

  // Event groups
  for (const [eventTitle, markets] of eventGroups) {
    // Skip if all markets in this group are resolved (already shown above)
    const active = markets.filter(m => !m.isRecentlyResolved);
    if (active.length === 0) continue;

    sections.push('═══════════════════════════════════════');
    sections.push(`EVENT: ${eventTitle}`);
    sections.push('═══════════════════════════════════════');

    // Show the primary (highest-scored) market with full detail
    const primary = active[0];
    sections.push(formatMarketForBriefing(primary, true));

    // Show sibling markets for holistic context
    if (primary.siblingMarkets && primary.siblingMarkets.length > 0) {
      sections.push('  Related sub-markets in this event:');
      for (const sib of primary.siblingMarkets) {
        const chg = sib.priceChange >= 0 ? '+' : '';
        sections.push(`    - "${sib.question}" — YES ${Math.round(sib.yesPrice * 100)}%, ${chg}${(sib.priceChange * 100).toFixed(1)}% 24h`);
      }
    }
    sections.push('');
  }

  // Standalone markets
  if (standalone.length > 0) {
    sections.push('═══════════════════════════════════════');
    sections.push('INDIVIDUAL MARKETS');
    sections.push('═══════════════════════════════════════\n');
    for (const m of standalone) {
      if (m.isRecentlyResolved) continue; // already shown above
      sections.push(formatMarketForBriefing(m, false));
      sections.push('');
    }
  }

  return sections.join('\n');
}

function formatMarketForBriefing(market, isEventPrimary) {
  const lines = [];
  const prefix = isEventPrimary ? '✦' : '•';
  const chg = market.oneDayPriceChange >= 0 ? '+' : '';
  const yesPercent = Math.round(market.bestYesPrice * 100);

  lines.push(`${prefix} "${market.question}"`);
  lines.push(`  YES ${yesPercent}% | ${chg}${(market.oneDayPriceChange * 100).toFixed(1)}% 24h | $${Math.round(market.volume24hr).toLocaleString()} vol`);

  if (market.description) {
    lines.push(`  Resolution criteria: ${market.description}`);
  }

  if (market.whaleSignal) {
    lines.push(`  WHALE SIGNAL: ${market.whaleSignal}`);
  }

  if (market.isFeatured) {
    lines.push(`  [Polymarket featured]`);
  }

  if (market._priceTrend) {
    const trend = market._priceTrend;
    lines.push(`  7d trend: ${trend.points.map(p => p + '%').join(' → ')} [${trend.direction}, ${trend.delta >= 0 ? '+' : ''}${trend.delta}pp]`);
  }

  if (market.resolutionSource) {
    lines.push(`  Resolution source: ${market.resolutionSource}`);
  }

  if (market.softNoiseFlags) {
    for (const flag of market.softNoiseFlags) {
      lines.push(`  ⚠ SOFT CATEGORY [${flag.category}]: ${flag.guidance}`);
    }
  }

  if (market.eventGroupSize > 1) {
    lines.push(`  Part of event with ${market.eventGroupSize} total markets`);
  }

  lines.push(`  id: ${market.id}`);
  return lines.join('\n');
}

// ============================================
// SYSTEM PROMPT
// ============================================

const EDITORIAL_SYSTEM_PROMPT = `You are the editor-in-chief of POLYMARKET REPORT — a Drudge Report-style news site that covers the FUTURE, using prediction-market signals to surface what matters next.

You are being given a rich editorial briefing with market data, event context, resolution criteria, whale signals, recently resolved outcomes, and markets about to resolve. Take your time to think through what is truly newsworthy.

YOUR JOB: From the briefing, select UP TO ${TOTAL_MARKETS} stories. Rank them by newsworthiness. Write a punchy headline for each. Flag exactly 4 as red (not counting #1, which is always red).

═══════════════════════════════════════════════
EDITORIAL PRINCIPLES
═══════════════════════════════════════════════

1. THINK HOLISTICALLY ABOUT EVENTS
   - When you see an event with multiple sub-markets, don't just headline the individual market.
   - If several sub-markets in the same event all shifted the same direction, the REAL story is the broader trend.
   - Write one headline about the big picture, not the narrow sub-market.

2. RECENTLY RESOLVED MARKETS ARE NEWS
   - Markets marked as "RESOLVED" are confirmed outcomes — you can state them as fact.
   - These are often the most compelling headlines: something actually HAPPENED.
   - Lead with the resolution if it's significant: "CONFIRMED:", "OFFICIAL:", "IT'S OVER:"

3. DIVERSITY IS ESSENTIAL
   - Maximum 2-3 headlines on any single topic or geopolitical situation.
   - The page should feel like a broad scan of what's happening in the world.
   - If 8 candidates are about the same conflict, pick the 2 most distinct angles.

═══════════════════════════════════════════════
HONESTY ABOUT CERTAINTY (CRITICAL)
═══════════════════════════════════════════════

For UNRESOLVED markets, NEVER write a headline that states an outcome as fact.
"Nvidia beats earnings expectations" is WRONG if the market hasn't resolved.
Instead write "Nvidia expected to beat earnings" or "Markets brace for Nvidia earnings report."

This is the #1 rule. If you are unsure whether something has happened, hedge the language.
ONLY state something as fact if the market is explicitly marked "RESOLVED".

When the 24h change is large, lead with the SHIFT:
  "SURGE OF SUPPORT FOR...", "MOMENTUM BUILDS TOWARD..."
  "CONFIDENCE COLLAPSES IN...", "SUPPORT CRUMBLES FOR..."

SKIP BORING STATIC MARKETS:
- A market sitting at 5% with no movement is NOT news. "Second coming remains longshot" is not a headline.
- A market at 50% with no movement is NOT news. "Coin flip" is not a headline.
- ONLY include low-probability or coin-flip markets if:
  (a) There was a DRAMATIC shift (e.g., was 90% now 50%), OR
  (b) The market resolves within 24 hours and the outcome is genuinely uncertain, OR
  (c) Whale activity signals insider conviction.

═══════════════════════════════════════════════
HEADLINE STYLE
═══════════════════════════════════════════════
- Under 80 characters. Punchy, active voice, present tense.
- Write about what is happening IN THE WORLD — not about markets, bets, or traders.
- NEVER include percentages, probabilities, dollar amounts, or market jargon.
- NEVER use the word "odds" — it's betting language.
- Question marks OK when genuinely uncertain (40-69%), but don't overuse.

CAPS:
- The LEAD HEADLINE (#1) must be ALL CAPS.
- For other headlines: if you want to emphasize one, make the WHOLE headline all caps. Don't capitalize random words mid-sentence for emphasis — either the whole thing is caps or none of it is.

STYLISTIC TECHNIQUES:
- Trailing ellipses (...) to create intrigue and imply a developing story. Use on ~30-50% of headlines.
- Short punchy verbs: push, slam, surge, crash, freeze, barrel, rein in, brace, crumble, shatter, torpedo, gut.
- NEVER passive voice. Not "rates expected to be held" but "Fed freezes rates."

═══════════════════════════════════════════════
PRICE DIRECTION — READ CAREFULLY
═══════════════════════════════════════════════
- A YES price DROPPING means the event is LESS likely to happen. Do NOT write a headline implying it happened.
- A YES price RISING means the event is MORE likely to happen.
- Example: "Will USD reach 1.7M Iranian rials?" dropping from 33% to 5% means the rial is STRENGTHENING, not crashing.
- When in doubt about the direction, frame the headline around the SHIFT itself: "Momentum shifts on...", "Markets reverse on..."

LEAD STORY (#1):
- Must be the most DYNAMIC story — something that CHANGED today, or just resolved.
- Big movement, whale activity, or a confirmed resolution.
- A market sitting still is NEVER the lead.

RED FLAGS (exactly 4) and ALL-CAPS — SUBJECT MATTER GUIDANCE:
- Flag exactly 4 headlines with isRed:true. The main story (#1) is ALWAYS red, so do NOT count it. Flag 4 OTHER headlines.
- Red headlines can appear ANYWHERE in the list. Spread them out.
- Use your judgment, but generally lean toward giving red/caps to stories with higher human stakes. Rough priority order:
  - War, armed conflict, national security crises, government bans
  - Political upheaval, leadership changes, diplomatic breakthroughs or breakdowns
  - Economic policy with broad human impact (shutdowns, rate decisions), public health
  - Corporate deals, individual net worth, trade statistics, entertainment
- This is guidance, not a hard rule — a genuinely shocking Tier 4 story can absolutely get red. Use editorial instinct.
- Also consider novelty: a war headline that's been running for weeks with no new development is less red-worthy than a fresh, surprising story in any tier.

EDITORIAL TONE:
- Every headline must describe something that ACTUALLY CHANGED — a shift, a resolution, a new development.
- Do NOT write headlines about things merely "looming", "approaching", or being "watched". If nothing happened, it's not a headline.
- Do NOT headline a market just because it's resolving soon. If the price didn't move, there's no story.
- "Long-shot" or "remains unlikely" is NEVER a headline. If nothing changed, skip it.

FINAL STEP — SEMANTIC GROUPING:
After selecting and writing all your headlines, review the FULL list as a group.
Reorder the array so that semantically related headlines are CONSECUTIVE.
Then assign each headline a short topic label (1-3 words) — headlines you consider related MUST share the EXACT SAME label string.

GROUPING RULES:
- Look for markets about the SAME PERSON, ENTITY, POLICY, or EVENT.
- If two headlines mention the same person (e.g., both about a Fed Chair nominee), they MUST share the same topic label and be adjacent.
- If two headlines are about the same geopolitical conflict, country, or policy area, group them.
- Common failure mode: headlines about "Fed Chair Powell" and "Fed interest rates" end up separated — these should be grouped under "Federal Reserve" or similar.
- Another failure mode: two headlines about the same political figure in different contexts get different labels — unify them.

Do NOT just label individually — read all headlines together and decide what belongs together.
Single-topic headlines that don't relate to anything else should get a unique label or null.
The lead story (#1) stays at position #1. Reorder positions #2 onward.

SOFT-FLAGGED MARKETS:
- Some markets are flagged with ⚠ SOFT CATEGORY warnings (weather, entertainment, sports).
- These are USUALLY noise, but sometimes newsworthy. Read the guidance and use your judgment.
- Only include them if they represent genuinely significant events.

WHAT TO DROP:
- Niche or low-interest stories that wouldn't make a general news audience care
- Markets with near-zero movement and no notable activity
- Routine, predictable outcomes that aren't surprising

OUTPUT: Return a JSON array only, no markdown fences, no commentary:
[{"id":"market_id","headline":"YOUR HEADLINE TEXT","isRed":true,"topic":"short-label"},...]`;

// ============================================
// LLM CALL (multi-provider with fallback)
// ============================================

async function callLLM(briefing) {
  const userPrompt = `Here is today's editorial briefing. Pick up to ${TOTAL_MARKETS} stories, rank by newsworthiness, write headlines, flag exactly 4 as red (not counting #1).\n\n${briefing}`;

  let lastError;

  for (const provider of AI_PROVIDERS) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(`Skipping ${provider.name}: ${provider.envKey} not set`);
      continue;
    }

    console.log(`\nCalling ${provider.model} via ${provider.name} (${userPrompt.length} char prompt)...`);
    const t0 = Date.now();

    try {
      const response = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: EDITORIAL_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.55,
          max_tokens: provider.maxTokens || 8192,
          response_format: { type: 'json_object' },
        }),
      });

      const elapsed = Date.now() - t0;

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content
        || data.choices?.[0]?.message?.text
        || data.choices?.[0]?.text
        || (typeof data.result === 'string' ? data.result : null);

      if (!content) {
        throw new Error(`Empty response. finish_reason=${data.choices?.[0]?.finish_reason}`);
      }

      console.log(`${provider.name} responded in ${(elapsed / 1000).toFixed(1)}s`);

      // Parse JSON from response (handle markdown fences and prose preamble)
      const cleaned = content.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      let picks;
      try {
        picks = JSON.parse(cleaned);
      } catch (parseErr) {
        // Model may have wrapped JSON in prose — try to extract the first JSON array or object
        const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
        const objectMatch = cleaned.match(/\{[\s\S]*\}/);
        const candidate = arrayMatch?.[0] || objectMatch?.[0];
        if (candidate) {
          try {
            picks = JSON.parse(candidate);
            console.warn('Extracted JSON from prose-wrapped response');
          } catch {
            console.error('Failed to parse LLM response as JSON:');
            console.error(cleaned.substring(0, 500));
            throw parseErr;
          }
        } else {
          console.error('Failed to parse LLM response as JSON:');
          console.error(cleaned.substring(0, 500));
          throw parseErr;
        }
      }

      if (picks && !Array.isArray(picks) && typeof picks === 'object') {
        const arrVal = Object.values(picks).find(v => Array.isArray(v));
        if (arrVal) picks = arrVal;
      }

      if (!Array.isArray(picks) || picks.length === 0) {
        throw new Error('LLM response is not a valid array');
      }

      console.log(`LLM selected ${picks.length} markets (${picks.filter(p => p.isRed).length} red)`);
      return { picks, elapsed, model: provider.model, aiProvider: provider.name };
    } catch (err) {
      console.error(`${provider.name} failed: ${err.message}`);
      lastError = err;
    }
  }

  throw lastError || new Error('No AI providers configured (check API key env vars)');
}

// ============================================
// ALGORITHMIC HEADLINE GROUPING
// ============================================

function groupHeadlinesByTopic(markets) {
  if (markets.length <= 1) return markets;

  // Lead story stays at index 0; group the rest
  const lead = markets[0];
  const rest = markets.slice(1);

  // Cluster by keyword overlap (2+ shared keywords = same cluster)
  const clusters = [];
  for (const m of rest) {
    const keys = extractTopicKeys(m.question || '');
    let bestCluster = null;
    let bestOverlap = 0;
    for (const cluster of clusters) {
      const overlap = keys.filter(k => cluster.keys.has(k)).length;
      if (overlap >= 2 && overlap > bestOverlap) {
        bestOverlap = overlap;
        bestCluster = cluster;
      }
    }
    if (bestCluster) {
      bestCluster.markets.push(m);
      for (const k of keys) bestCluster.keys.add(k);
    } else {
      clusters.push({ keys: new Set(keys), markets: [m] });
    }
  }

  // Assign topic labels: most common non-stop-word across the cluster's questions
  for (const cluster of clusters) {
    if (cluster.markets.length < 2) {
      // Single-market cluster — no topic label needed
      cluster.markets[0].topic = null;
      continue;
    }
    // Count keyword frequency across all markets in this cluster
    const freq = {};
    for (const m of cluster.markets) {
      const keys = extractTopicKeys(m.question || '');
      for (const k of keys) freq[k] = (freq[k] || 0) + 1;
    }
    // Pick the keyword that appears in the most markets, prefer shorter labels
    const sorted = Object.entries(freq)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
    const topicLabel = sorted.length > 0
      ? sorted[0][0].charAt(0).toUpperCase() + sorted[0][0].slice(1)
      : null;
    for (const m of cluster.markets) m.topic = topicLabel;
  }

  // Sort clusters: larger clusters first, then by best market score within cluster
  clusters.sort((a, b) => {
    if (b.markets.length !== a.markets.length) return b.markets.length - a.markets.length;
    const bestA = Math.max(...a.markets.map(m => m.score || 0));
    const bestB = Math.max(...b.markets.map(m => m.score || 0));
    return bestB - bestA;
  });

  // Flatten: lead + grouped rest
  const grouped = [lead];
  for (const cluster of clusters) {
    grouped.push(...cluster.markets);
  }

  console.log(`Headline grouping: ${clusters.length} clusters from ${rest.length} headlines`);
  return grouped;
}

// ============================================
// ASSEMBLE FINAL OUTPUT
// ============================================

function assembleOutput(candidates, llmResult) {
  const candidateMap = new Map();
  for (const m of candidates) {
    candidateMap.set(String(m.id), m);
  }

  const { picks, elapsed, model, aiProvider } = llmResult;
  const markets = [];

  for (const pick of picks) {
    const original = candidateMap.get(String(pick.id));
    if (!original) {
      console.log(`  LLM picked unknown id "${pick.id}", skipping`);
      continue;
    }
    markets.push({
      ...original,
      headline: pick.headline || null,
      isRed: !!pick.isRed,
      topic: pick.topic || null,
      priceHistory: original.priceHistory || null,
      // Remove internal fields from output
      softNoiseFlags: undefined,
      siblingMarkets: undefined,
      _priceTrend: undefined,
    });
  }

  if (markets.length < TOTAL_MARKETS * 0.3) {
    console.warn(`WARNING: Only ${markets.length} markets matched — LLM may have returned bad IDs`);
  }

  // Use LLM-assigned topics if present, fall back to algorithmic grouping
  const hasLLMTopics = markets.filter(m => m.topic).length >= 3;
  const grouped = hasLLMTopics ? markets : groupHeadlinesByTopic(markets);
  console.log(`Topic source: ${hasLLMTopics ? 'LLM' : 'algorithmic fallback'}`);

  // Log the top headlines
  console.log('\n=== CURATED HEADLINES ===');
  grouped.slice(0, 10).forEach((m, i) => {
    const red = m.isRed ? ' [RED]' : '';
    const topicTag = m.topic ? ` [${m.topic}]` : '';
    console.log(`  #${i + 1}: "${(m.headline || m.question).substring(0, 60)}"${red}${topicTag}`);
  });

  return {
    markets: grouped.slice(0, TOTAL_MARKETS),
    meta: {
      generated: new Date().toISOString(),
      aiModel: model,
      aiProvider: aiProvider || null,
      aiResponseMs: elapsed,
      aiMode: 'curated',
      candidateCount: candidates.length,
      resolvedCount: candidates.filter(m => m.isRecentlyResolved).length,
    },
  };
}

function buildFallbackOutput(candidates) {
  console.warn('Using algorithmic fallback (no LLM curation)');
  const markets = candidates.slice(0, TOTAL_MARKETS).map((m, i) => ({
    ...m,
    headline: null,
    isRed: i < Math.floor(TOTAL_MARKETS * 0.10),
    topic: null,
    softNoiseFlags: undefined,
    siblingMarkets: undefined,
    _priceTrend: undefined,
  }));

  return {
    markets,
    meta: {
      generated: new Date().toISOString(),
      aiMode: 'fallback',
      candidateCount: candidates.length,
    },
  };
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('=== Polymarket Report — Curation Run ===');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Providers: ${AI_PROVIDERS.map(p => p.name).join(' → ')}\n`);

  // Fetch all data
  const [allMarkets, whaleTrades] = await Promise.all([
    fetchAllMarkets(),
    fetchWhaleTrades(),
  ]);
  console.log(`\nTotal: ${allMarkets.length} markets, ${whaleTrades.length} whale trades`);

  // Rank and enrich
  const candidates = rankAndEnrich(allMarkets, whaleTrades);
  console.log(`\nCandidate pool: ${candidates.length} markets for LLM`);

  if (candidates.length === 0) {
    console.error('No candidates after filtering — nothing to curate');
    process.exit(1);
  }

  // Enrich top candidates with 7-day price history from CLOB API
  try {
    await enrichWithPriceHistory(candidates);
  } catch (err) {
    console.error(`Price history enrichment failed (non-fatal): ${err.message}`);
  }

  // Build editorial briefing
  const briefing = buildEditorialBriefing(candidates);
  console.log(`Editorial briefing: ${briefing.length} chars`);

  // Call LLM
  let output;
  try {
    const llmResult = await callLLM(briefing);
    output = assembleOutput(candidates, llmResult);
  } catch (err) {
    console.error(`LLM curation failed: ${err.message}`);
    output = buildFallbackOutput(candidates);
  }

  // Write output
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const __dirname = dirname(fileURLToPath(import.meta.url));
  const outDir = join(__dirname, 'data');
  const outPath = join(outDir, 'headlines.json');

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${output.markets.length} markets to ${outPath}`);
  console.log(`Mode: ${output.meta.aiMode}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
