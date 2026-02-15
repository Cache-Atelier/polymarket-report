# Polymarket Report — Implementation Plan v2

## Executive Summary

Transform the current MVP (which uses an undocumented `polymarket.com/api/biggest-movers` endpoint) into a multi-signal Drudge Report-style page powered by:
- **Gamma API** for market discovery + reconstructed biggest movers (documented, stable)
- **Data API** for whale/insider detection via large trade monitoring
- **AI summarization** via OpenCode Zen (Kimi K2.5 free) with NVIDIA NIM fallback
- **News sourcing** via RSS/search for article links alongside market headlines
- **Server-side caching** to stay well under rate limits

---

## Research Findings (Informing This Plan)

### Gamma API — Far More Than Biggest Movers
The Gamma API (`gamma-api.polymarket.com`) is fully documented, free, no-auth, and exposes:
- **`GET /markets`** with rich filtering: `order=oneDayPriceChange`, `volume_num_min`, `liquidity_num_min`, date ranges, tags, active/closed status
- **Pre-computed fields on every market**: `oneDayPriceChange`, `oneHourPriceChange`, `oneWeekPriceChange`, `volume24hr`, `volume1wk`, `liquidityNum`, `competitive`, `spread`, `bestBid`, `bestAsk`, `createdAt`, `endDate`
- **`GET /events`** — groups of related markets, same filtering
- **`GET /tags`** — category browsing (Politics, Crypto, Sports, etc.)
- **`GET /search`** — full-text search with status/tag filters

This means we can **reconstruct biggest movers ourselves** AND surface markets that biggest-movers misses (volume spikes, new markets, approaching resolution, competitive/close races).

### Whale/Insider Detection — Achievable via Data API
The **Data API** (`data-api.polymarket.com`) exposes:
- **`GET /trades`** — all trades, filterable by market, with `filterAmount` threshold for large trades
- **`GET /holders`** — top position holders per market

This is enough to build a "whale alert" feed: query `/trades?filterType=CASH&filterAmount=10000` to find $10K+ trades, cross-reference with market data to identify contrarian positions. No blockchain indexing needed for v1.

For v2+, **Bitquery** (GraphQL, has npm SDK) and the **Polymarket Subgraph** (100K free queries/month via The Graph) can provide deeper on-chain analysis.

### AI Provider Strategy
- **Primary**: OpenCode Zen — free Kimi K2.5 via OpenAI-compatible API (`https://opencode.ai/zen/v1`). Good for summarization and categorization. Temporary free tier; data may be used for model improvement.
- **Fallback**: NVIDIA NIM — also free Kimi K2.5 (`https://integrate.api.nvidia.com/v1`), 40 req/min, phone verification required. More stable long-term.
- **Alternative for speed**: Groq — free Llama 3.3 70B, 250-14,400 req/day, fastest inference (300+ tok/sec). Great for classification/filtering.
- **Future upgrade path**: Claude Sonnet 4.5 via OpenCode Zen for higher-quality editorial output when/if budget allows.

### Why Replace the Undocumented Endpoint
The current `polymarket.com/api/biggest-movers` is:
- Undocumented — could break without warning
- Unconfigurable — can't control result count, filtering, or sorting
- Limited — only shows price movers, misses volume spikes, whale activity, new markets

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Vercel Deployment                   │
│                                                       │
│  index.html          api/markets.js (serverless fn)   │
│  ┌─────────┐         ┌──────────────────────────┐    │
│  │ Browser  │────────▶│  /api/markets             │    │
│  │ (Drudge  │◀────────│                          │    │
│  │  layout) │         │  1. Check cache (KV/mem) │    │
│  └─────────┘         │  2. If stale:            │    │
│                       │     a. Fetch Gamma API   │    │
│                       │     b. Fetch Data API    │    │
│                       │        (whale trades)    │    │
│                       │     c. Merge & rank      │    │
│                       │     d. AI summarize      │    │
│                       │        (headlines)       │    │
│                       │     e. Cache result      │    │
│                       │  3. Return cached data   │    │
│                       └──────────────────────────┘    │
│                                                       │
│  api/config.js       (shared constants & helpers)     │
└─────────────────────────────────────────────────────┘
         │                    │                │
         ▼                    ▼                ▼
   Gamma API           Data API         OpenCode Zen
   (markets,           (trades,         or NVIDIA NIM
    events,             holders)        (AI headlines)
    tags)
```

### Caching Strategy
- **In-memory cache** in the serverless function with a 5-minute TTL
- Vercel serverless functions persist memory across warm invocations, so this works for moderate traffic
- On cold start, fetches fresh data (adds ~2-3s latency, acceptable)
- Cache key: just a single `lastFetch` timestamp + `cachedData` object
- If Vercel KV is available later, easy to swap in for cross-instance consistency
- **Stale-while-revalidate**: Return cached data immediately, refresh in background if TTL expired

### Rate Limit Budget (5-min cache = ~288 fetches/day max)
- Gamma API: ~3 calls per refresh (movers ascending, movers descending, volume leaders) = ~864/day — well under ~1,000/hr limit
- Data API: 1 call per refresh (large trades) = ~288/day — well under limits
- AI API: ~1 call per refresh for headline generation = ~288/day — well under free tier limits

---

## Data Feeds & Sections

### Feed 1: Biggest Movers (reconstructed from Gamma API)
```
GET /markets?active=true&closed=false&order=oneDayPriceChange&ascending=false&limit=30
GET /markets?active=true&closed=false&order=oneDayPriceChange&ascending=true&limit=30
```
Merge, sort by `abs(oneDayPriceChange)`, take top N. This replaces the undocumented endpoint with full control.

### Feed 2: Volume Leaders (markets people are betting on most)
```
GET /markets?active=true&closed=false&order=volume24hr&ascending=false&limit=20
```
High volume + low price change = contested/debated outcome. High volume + high price change = already in Feed 1.

### Feed 3: Whale Trades (contrarian/insider signal)
```
GET https://data-api.polymarket.com/trades?filterType=CASH&filterAmount=10000
```
Returns recent large trades ($10K+). Cross-reference with market current price:
- If a $10K+ trade is on the minority side (e.g., buying YES at 15%), flag as "contrarian whale bet"
- Group by market to find markets with multiple large trades

### Feed 4: New & Trending (optional, for variety)
```
GET /markets?active=true&closed=false&order=createdAt&ascending=false&limit=20&volume_num_min=1000
```
Recently created markets that already have meaningful volume.

### Ranking & Merging Algorithm
Each market gets a composite score:
```
score = (abs(oneDayPriceChange) * W_PRICE)
      + (normalized_volume24hr * W_VOLUME)
      + (whale_trade_count * W_WHALE)
      + (is_new_and_trending * W_NEW)
```
Default weights: `W_PRICE=0.4, W_VOLUME=0.25, W_WHALE=0.25, W_NEW=0.1`

Markets that appear in multiple feeds get a boost. Deduplicate by market ID.

### Red Headline Logic
Red headlines (`class="red"`) are NOT restricted to the top of the page. Any headline in any position (main story, any column, any row) can be red. Criteria for red:
- `abs(oneDayPriceChange) >= 10%` OR
- Whale contrarian bet detected OR
- Composite score in top 20% of displayed markets

This means a whale alert deep in column 3 gets red treatment, making the page scannable for high-signal items.

---

## AI Headline Generation

### When & Why
Market questions are often dry ("Will X happen by Y date?"). AI rewrites them as punchy Drudge-style headlines while preserving accuracy.

### Provider Chain (try in order)
1. **OpenCode Zen** — `POST https://opencode.ai/zen/v1/chat/completions` with model `opencode/kimi-k2.5-free`
2. **NVIDIA NIM** — `POST https://integrate.api.nvidia.com/v1/chat/completions` with model `moonshotai/kimi-k2.5`
3. **Fallback** — Use raw market question as-is (no AI, still functional)

### Prompt Design
```
You are a headline writer for a Drudge Report-style news aggregator about prediction markets.
Rewrite these market questions as punchy, attention-grabbing headlines.
Keep each under 80 characters. Preserve factual accuracy. Use active voice.
Include the current probability if it adds drama (e.g., "85% chance").

Markets:
1. "Will Donald Trump win the 2028 presidential election?" (YES: 42%, 24h change: +5.2%)
2. ...

Return JSON array of headlines, one per market, same order.
```

Batch all markets in one call to minimize API usage. Parse response. If AI fails, fall through to raw questions.

---

## Implementation Steps

### Phase 1: Server-Side Data Pipeline (api/markets.js rewrite)
1. Replace `polymarket.com/api/biggest-movers` with Gamma API calls
2. Add Data API whale trade fetching
3. Implement composite ranking algorithm
4. Add in-memory caching with 5-min TTL
5. Return enriched market data to frontend

### Phase 2: AI Headline Generation
1. Add OpenCode Zen integration with NVIDIA NIM fallback
2. Implement batched headline rewriting
3. Cache AI-generated headlines alongside market data
4. Graceful fallback to raw market questions

### Phase 3: Frontend Enhancements (index.html)
1. Red headlines can appear anywhere (based on score/signals, not position)
2. Add whale alert indicators (e.g., "WHALE BET" tag on relevant headlines)
3. Add visual distinction for different signal types
4. Section headers or subtle markers for why a headline is featured
5. Preserve Drudge aesthetic — no heavy UI, just text + signals

### Phase 4: News Article Linking (stretch)
1. For top N markets, search for related news articles (RSS feeds or search API)
2. Display article links below market headlines
3. This is the "content curation" layer — market signals point to what matters, articles provide the substance

---

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `api/markets.js` | **Rewrite** | Multi-source data fetching, ranking, caching, AI headlines |
| `api/config.js` | **New** | Shared constants (weights, thresholds, API URLs, cache TTL) |
| `index.html` | **Edit** | Red headlines anywhere, whale indicators, signal-based styling |
| `overview.md` | **Update** | Reflect new architecture and data sources |
| `vercel.json` | **Edit** | May need longer timeout for AI calls (30s vs 10s) |

---

## Environment Variables (Vercel)
```
OPENCODE_API_KEY=xxx          # OpenCode Zen API key for Kimi K2.5
NVIDIA_API_KEY=xxx            # NVIDIA NIM fallback (optional)
CACHE_TTL_MS=300000           # 5 minutes default
WHALE_TRADE_THRESHOLD=10000   # Minimum USD for whale trade detection
```

---

## Open Decisions (For Your Input)

1. **Whale trade threshold**: $10K is a reasonable starting point. Should we go higher ($25K, $50K) to reduce noise?
2. **AI headlines**: Should every market get AI-rewritten, or only the top N? (Batching all is simple and one API call)
3. **News article linking**: Defer to Phase 4, or include in initial build?
4. **Market count**: Keep 28 (1 main + 27 columns) or increase now that we have richer data?
