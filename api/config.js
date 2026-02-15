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
export const GAMMA_FETCH_LIMIT = 80;       // Fetch extra to compensate for noise filtering
export const WHALE_TRADE_THRESHOLD = 10000; // USD minimum for whale trade detection
export const WHALE_LOOKBACK_MINUTES = 120;  // How far back to scan for whale trades

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
  priceChangePct: 25,    // abs(24h change) >= 25% → red (truly dramatic moves only)
  topPercentile: 0.12,   // Top ~12% by composite score → red (~3 of 28)
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
// ============================================
export const NOISE_PATTERNS = [
  // Crypto price/trading markets (keeps policy, regulation, ETF, adoption)
  /\b(bitcoin|btc|ethereum|eth|solana|sol|doge|dogecoin|xrp|bnb|cardano|avax|matic|polkadot|shib|pepe|memecoin|altcoin|litecoin|toncoin|chainlink)\b.*\b(price|above|below|reach|hit|close|end at|trade at|worth|all.time.high|ath)\b/i,
  /\bprice of\b.*\b(bitcoin|btc|eth|ethereum|sol|solana|crypto|token|coin)\b/i,
  /\bcrypto\b.*\b(price|above|below|market cap)\b/i,
  /\b(btc|eth|sol|bitcoin|ethereum|solana)\b.*\$[\d,]+/i,

  // Weather/climate daily predictions
  /\b(temperature|snowfall|rainfall|inches of (rain|snow)|high of \d|low of \d|degrees? (fahrenheit|celsius|f\b|c\b))\b/i,

  // Sports — leagues
  /\b(nfl|nba|mlb|nhl|mls|ncaa|wnba|ufc|wwe|pga|atp|wta|nascar|f1|formula (1|one)|premier league|champions league|la liga|serie a|bundesliga|ligue 1|eredivisie|cricket|ipl|afl)\b/i,
  // Sports — major events
  /\b(super bowl|world series|stanley cup|march madness|world cup|euro 20\d\d|olympics|grand slam|grand prix)\b/i,
  // Sports — outcome language
  /\b(win (the |their )?(game|match|series|title|championship|ring|trophy|pennant))\b/i,
  /\b(playoff|postseason|regular season|preseason|draft pick|mvp award|ballon d.or)\b/i,

  // Esports
  /\besports?\b/i,
  /\b(league of legends|dota|counter-?strike|cs ?2|valorant|overwatch|fortnite)\b/i,

  // Tweet/social media activity
  /\btweet(s|ed)?\b/i,
  /\bretweet\b/i,
  /\bpost(s|ed)? on (x|twitter)\b/i,
  /\b(x|twitter) (post|follower)/i,
  /\bfollowers? (on|count)\b/i,

  // YouTube/streaming/subscriber metrics
  /\b(youtube|twitch|tiktok)\b.*\b(views|subscribers|followers|likes)\b/i,
  /\bsubscribers?\b.*\b(youtube|channel)\b/i,
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
