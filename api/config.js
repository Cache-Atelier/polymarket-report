// Shared configuration for Polymarket Report
// All tunable constants in one place

// ============================================
// API ENDPOINTS
// ============================================
export const GAMMA_API = 'https://gamma-api.polymarket.com';
export const DATA_API = 'https://data-api.polymarket.com';

// ============================================
// AI PROVIDERS (tried in order)
// ============================================
export const AI_PROVIDERS = [
  {
    name: 'opencode-minimax',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    model: 'minimax-m2.5-free',
    envKey: 'OPENCODE_API_KEY',
  },
  {
    name: 'opencode-kimi',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    model: 'kimi-k2.5-free',
    envKey: 'OPENCODE_API_KEY',
    maxTokens: 16384, // reasoning model — needs headroom beyond internal chain-of-thought
  },
];

// ============================================
// MARKET FETCHING
// ============================================
export const TOTAL_MARKETS = 28;           // 1 main story + 27 in columns
export const LLM_CANDIDATE_POOL = 35;     // Send more to LLM so it can curate/drop
export const WHALE_TRADE_THRESHOLD = 10000; // USD minimum for whale trade detection
export const WHALE_LOOKBACK_MINUTES = 120;  // How far back to scan for whale trades

// --- TAG-BASED CONTENT CURATION ---
// We use THREE complementary fetch strategies and merge the results:
//
// 1. FEATURED EVENTS: Polymarket's own editorial picks (featured=true)
// 2. TOP-LEVEL TAG IDs: Broad categories with known numeric IDs
// 3. SUB-TAG SLUGS: Specific sub-topics cherry-picked for news value
//
// This is the PRIMARY content filter. If it's not in these lists, it doesn't
// appear on the site. The noise regex is just a lightweight safety net.

// Top-level categories by tag_id (confirmed from Polymarket frontend source)
// We ONLY include news-worthy categories — Sports (100639), Crypto (21),
// and Culture (596) are intentionally excluded.
export const TAG_IDS = [
  { id: 2,      label: 'Politics' },
  { id: 100265, label: 'Geopolitics' },
  { id: 1401,   label: 'Tech' },
  // Finance (120) excluded at top-level — too much price speculation.
  // We cherry-pick newsworthy finance sub-tags below instead.
];

// Specific sub-tags by slug, curated for news signal.
// These drill into topics that the broad tag_ids might miss,
// and let us grab finance/economy news without the price noise.
export const TAG_SLUGS = [
  // Politics & Law
  'elections', 'us-elections', 'global-elections', 'congress', 'courts', 'scotus',
  // Geopolitics & World
  'world', 'ukraine', 'middle-east', 'china', 'iran', 'israel',
  // Economy & Policy (NOT price speculation)
  'economy', 'economic-policy', 'fed', 'tariffs', 'trade-war', 'business',
  // Science & Space
  'science', 'space',
  // AI (dedicated sub-tag, more specific than broad Tech)
  'ai',
];

// ============================================
// RANKING WEIGHTS
// ============================================
export const WEIGHTS = {
  volume: 0.35,        // High volume = the world cares (best proxy for newsworthiness)
  priceChange: 0.25,   // Big price moves = something happened
  whale: 0.25,         // Whale/contrarian bets = insider signal
  newTrending: 0.10,   // New markets gaining traction
  featuredBoost: 1.25, // Multiplier for Polymarket editorial picks
};

// ============================================
// SCORING ADJUSTMENTS
// ============================================
// Volume floor: markets below this threshold get a penalty.
// A $10K market with a big swing is just illiquid, not news.
export const VOLUME_FLOOR = 25_000;       // USD
export const VOLUME_FLOOR_PENALTY = 0.4;  // Score multiplied by this when below floor

// Expiry drift: markets near deadline naturally swing to 0% or 100%.
// That's not news — it's just a clock running out. Dampen those.
export const EXPIRY_DRIFT = {
  daysThreshold: 7,         // Market expires within this many days
  priceExtremeBelow: 0.15,  // YES price below 15%...
  priceExtremeAbove: 0.85,  // ...or above 85%
  dampener: 0.3,            // Price signal multiplied by this
};

// ============================================
// RED HEADLINE THRESHOLDS
// ============================================
export const RED_THRESHOLDS = {
  // Only score-based: top ~10% by composite score → red (~3 of 28 column headlines)
  // Price change is NOT used — "biggest movers" almost always exceed any % threshold
  topPercentile: 0.10,
};

// ============================================
// CACHING
// ============================================
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================
// NOISE MARKET FILTERS
// Markets matching these patterns are excluded from display.
// Goal: surface politics, geopolitics, policy, economics, AI, and
// significant world events — NOT crypto prices, sports, weather, tweets.
//
// IMPORTANT: Polymarket sports markets usually use TEAM NAMES, not league
// names ("Lakers vs Celtics", not "NBA game"). So we must also match on
// player stats, betting language, and game-structure terms.
// ============================================
export const NOISE_PATTERNS = [
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

  // ---- WEATHER ----
  /\b(temperature|snowfall|rainfall|inches of (rain|snow)|high of \d|low of \d|degrees? (fahrenheit|celsius|f\b|c\b)|weather forecast)\b/i,

  // ---- SPORTS: LEAGUES & ORGANIZATIONS ----
  /\b(nfl|nba|mlb|nhl|mls|ncaa|wnba|ufc|wwe|pga|atp|wta|nascar|f1|formula (1|one)|premier league|champions league|la liga|serie a|bundesliga|ligue 1|eredivisie|cricket|ipl|afl|lpga|xfl|usfl|cfl|liga mx|copa libertadores|europa league|conference league|fa cup|carabao cup|efl|ligue 2|serie b|segunda division|j.league|k.league|a.league)\b/i,

  // ---- SPORTS: MAJOR EVENTS ----
  /\b(super bowl|world series|stanley cup|march madness|world cup|euro 20\d\d|olympics|grand slam|grand prix|masters tournament|ryder cup|solheim cup|daytona 500|indy 500|kentucky derby|preakness|belmont stakes|tour de france|six nations|ashes series)\b/i,

  // ---- SPORTS: PLAYER STATS & PERFORMANCE ----
  /\b(passing yards?|rushing yards?|receiving yards?|touchdowns?|interceptions?|sacks?|tackles?|completions?|passer rating|quarterback rating|field goals? (made|attempted|percentage))\b/i,
  /\b(rebounds?|assists?|steals?|blocks?|three.pointers?|free throws?|double.double|triple.double|points? per game|minutes? per game)\b/i,
  /\b(home runs?|RBIs?|batting average|ERA|earned run|strikeouts?|walks?|hits? (allowed)?|innings? pitched|on.base percentage|slugging|WAR|OPS)\b/i,
  /\b(goals? scored|clean sheets?|hat tricks?|saves? (made|percentage)|shots? on (target|goal)|expected goals|xG)\b/i,
  /\b(aces?|double faults?|break points?|unforced errors?|winners?|first serve)\b/i,
  /\b(knockouts?|TKO|submission|decision|rounds? (?:won|fought)|significant strikes?|takedowns?)\b/i,

  // ---- SPORTS: GAME STRUCTURE ----
  /\b(first quarter|second quarter|third quarter|fourth quarter|halftime|half.time|overtime|extra time|penalty shootout|sudden death|extra innings?|seventh.inning stretch)\b/i,

  // ---- SPORTS: OUTCOME & SEASON ----
  /\b(win (the |their )?(game|match|series|title|championship|ring|trophy|pennant|medal|bout|fight|race|tournament|cup))\b/i,
  /\b(playoff|postseason|regular season|preseason|offseason|draft pick|free agent|trade deadline|waiver|roster move|injury report|starting lineup|MVP award|ballon d.or|rookie of the year|defensive player|sixth man|cy young|heisman|golden boot|golden glove)\b/i,

  // ---- SPORTS: BETTING LANGUAGE ----
  /\b(spread|over.?under|moneyline|money line|point total|prop bet|parlay|handicap|odds (of|at|to)|point spread|run line|puck line|total (points|goals|runs|sets))\b/i,

  // ---- SPORTS: POSITIONS (catches player-centric markets) ----
  /\b(quarterback|wide receiver|running back|tight end|linebacker|cornerback|safety|pitcher|catcher|shortstop|outfielder|designated hitter|goalie|goalkeeper|striker|midfielder|defender|winger|point guard|shooting guard|small forward|power forward|center(?! for))\b/i,

  // ---- SPORTS: TEAM vs TEAM pattern ----
  // Catches "Lakers vs Celtics", "Chiefs vs Eagles", "Arsenal vs Liverpool"
  /\bvs\.?\s/i,

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

  // ---- ENTERTAINMENT ----
  /\b(box office|opening weekend|gross(ed|ing)?|domestic gross|worldwide gross)\b/i,
  /\b(Oscar|Academy Award|Grammy|Emmy|Golden Globe|Tony Award|BAFTA|SAG Award|Critics.? Choice)\b/i,
  /\b(Bachelor(ette)?|Survivor|Big Brother|Love Island|American Idol|The Voice|Dancing with the Stars|Amazing Race)\b/i,
  /\b(Billboard|album sales|chart position|number.one (hit|single|album)|platinum|certified gold)\b/i,
];

// ============================================
// AI EDITORIAL CURATION PROMPT
// The LLM acts as editor-in-chief: it selects, orders, headlines, and flags.
// ============================================
export const EDITORIAL_SYSTEM_PROMPT = `You are the editor of a Drudge Report-style news site. Your source data comes from prediction markets, but YOUR HEADLINES READ LIKE REAL NEWS. Readers should never feel like they're looking at a betting site.

TASK: From ~35 candidates, pick UP TO ${TOTAL_MARKETS} (fewer is fine — quality and diversity over quantity). Rank by newsworthiness, write headlines, flag 2-4 as red.

DIVERSITY:
- Maximum 2-3 headlines on any single topic or geopolitical situation.
- The page should feel like a broad scan of what's happening in the world, not tunnel vision on one story.
- If 8 candidates are about the same conflict, pick the 2 most distinct angles and drop the rest.

HEADLINE RULES:
- Under 80 characters. Punchy, active voice, present tense. ALL-CAPS sparingly.
- Write about what is HAPPENING IN THE WORLD. Not about markets, odds, prices, bets, traders, or money.
- NEVER include percentages, odds, probabilities, or any numbers about market prices.
- The frontend automatically appends a movement indicator — do NOT include one.
- No question marks. These are declarative news headlines.
- If a market is unresolved, frame as developing news: "TENSIONS MOUNT...", "TALKS STALL...", "GROWING SIGNS OF..."
- If resolved, state the outcome as fact.

LEAD STORY (#1):
- Must be the most DYNAMIC story — something that CHANGED today.
- Big movement or significant real-world developments.
- A market sitting still, even at a dramatic price, is NEVER the lead.

RED FLAGS (2-4 total):
- Mark the most urgent, dramatic, or breaking stories as red.

WHAT TO DROP:
- Niche or low-interest stories
- Markets with near-zero movement and no notable activity
- If an event has multiple related markets (noted as "eventGroup: N"), write one headline about the broader event, not the specific sub-market

OUTPUT: JSON array only, no markdown/commentary:
[{"id":"market_id","headline":"TEXT","isRed":true},...]`;

export function buildEditorialUserPrompt(markets) {
  const lines = markets.map(m => {
    const chg = m.oneDayPriceChange >= 0 ? '+' : '';
    const parts = [
      m.id,
      m.question,
      `${chg}${(m.oneDayPriceChange * 100).toFixed(1)}% 24h`,
      `$${Math.round(m.volume24hr || 0).toLocaleString()} vol`,
    ];
    if (m.whaleSignal) parts.push(`WHALE: ${m.whaleSignal}`);
    if (m.eventGroupSize > 1) parts.push(`eventGroup: ${m.eventGroupSize} markets`);
    return parts.join(' | ');
  });

  return `Pick up to ${TOTAL_MARKETS} (diversity over quantity), rank, headline, flag 2-4 red:\n\n${lines.join('\n')}`;
}
