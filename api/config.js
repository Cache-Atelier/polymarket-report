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
    name: 'opencode-zen',
    url: 'https://opencode.ai/zen/v1/chat/completions',
    model: 'opencode/kimi-k2.5-free',
    envKey: 'OPENCODE_API_KEY',
  },
  {
    name: 'nvidia-nim',
    url: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'moonshotai/kimi-k2.5',
    envKey: 'NVIDIA_API_KEY',
  },
];

// ============================================
// MARKET FETCHING
// ============================================
export const TOTAL_MARKETS = 28;           // 1 main story + 27 in columns
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
  priceChange: 0.40,   // Big price moves = something happened
  volume: 0.25,        // High volume = market cares
  whale: 0.25,         // Whale/contrarian bets = insider signal
  newTrending: 0.10,   // New markets gaining traction
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
// AI HEADLINE PROMPT
// ============================================
export const HEADLINE_SYSTEM_PROMPT = `You are a headline writer for a prediction-market news aggregator styled after the Drudge Report.

Your job: turn prediction market data into short, punchy, informative headlines that tell the reader what is ACTUALLY HAPPENING in the world right now.

CRITICAL RULES:
1. NEVER claim something happened just because the price moved. A market going to 92% does NOT mean the event occurred — it means bettors think it's very likely.
2. Use the resolution status carefully:
   - If "resolved: true" → the outcome IS confirmed. You can state it as fact.
   - If "resolved: false" → the outcome is NOT confirmed. Frame as market sentiment: "Bettors surge toward...", "Odds spike for...", "Market gives X% chance..."
3. Use the resolution criteria (description field) to understand WHAT the market is actually about. This prevents misinterpreting vague market titles.
4. A big price DROP on a YES outcome means the event is now seen as LESS likely — don't invert this.
5. For whale/contrarian trades: frame as "Smart money betting against..." or "Large trader takes contrarian position on..." — do NOT claim insider knowledge.

STYLE:
- Drudge Report energy: urgent, punchy, ALL-CAPS sparingly for emphasis
- Under 80 characters per headline
- Active voice, present tense
- Include odds when they add drama (e.g., "NOW AT 94%")
- No question marks — these are declarations about market state, not questions
- No quotation marks wrapping the whole headline

OUTPUT: Return a JSON array of headline strings, one per market, same order as input. Nothing else — no markdown, no explanation.`;

export function buildHeadlineUserPrompt(markets) {
  const entries = markets.map((m, i) => {
    const parts = [
      `${i + 1}. "${m.question}"`,
      `   Current YES price: ${(m.bestYesPrice * 100).toFixed(0)}%`,
      `   24h change: ${m.oneDayPriceChange >= 0 ? '+' : ''}${(m.oneDayPriceChange * 100).toFixed(1)}%`,
    ];
    if (m.volume24hr) {
      parts.push(`   24h volume: $${Math.round(m.volume24hr).toLocaleString()}`);
    }
    if (m.resolved) {
      parts.push(`   STATUS: RESOLVED — outcome is confirmed fact`);
    } else {
      parts.push(`   STATUS: UNRESOLVED — outcome is NOT yet determined`);
    }
    if (m.description) {
      // Truncate long descriptions to keep prompt manageable
      const desc = m.description.length > 300
        ? m.description.substring(0, 300) + '...'
        : m.description;
      parts.push(`   Resolution criteria: ${desc}`);
    }
    if (m.whaleSignal) {
      parts.push(`   WHALE ALERT: ${m.whaleSignal}`);
    }
    return parts.join('\n');
  });

  return `Rewrite these ${markets.length} prediction markets as Drudge-style headlines:\n\n${entries.join('\n\n')}`;
}
