## Vision

A Drudge Report-style news aggregator that uses Polymarket prediction markets as content curation signals. Instead of editorial decisions, market prices, volume, and whale activity determine what news matters. AI rewrites dry market questions into punchy, informative headlines. Shows "what the market is saying about this news" — combining financial signals with content discovery for high-signal news reading.

## Architecture

### Data Pipeline (api/markets.js)
1. **Biggest Movers** — Gamma API sorted by `oneDayPriceChange` (both directions), merged by absolute change
2. **Volume Leaders** — Gamma API sorted by `volume24hr` (catches contested markets with heavy trading but small price moves)
3. **Whale Trades** — Data API `/trades` with `filterAmount=$10K+`, cross-referenced for contrarian positions
4. **Composite Ranking** — Weighted score: 40% price change, 25% volume, 25% whale signal, 10% new+trending
5. **AI Headlines** — OpenCode Zen (Kimi K2.5) with NVIDIA NIM fallback; resolution status + criteria fed to LLM to prevent false claims
6. **Caching** — 5-min in-memory TTL, stale-while-revalidate on errors

### Frontend (index.html)
- Drudge Report aesthetic: black/white, text-focused, monospace
- Red headlines appear anywhere on page based on signals (10%+ move, whale detection, top 20% score)
- "WHALE ALERT" tags on markets with large contrarian trades
- AI-generated headlines with raw question fallback

### API Endpoints Used
- **Gamma API**: `GET /markets` with `active`, `closed`, `order`, `limit` params — no auth required
- **Data API**: `GET /trades` with `filterType=CASH&filterAmount=10000` — no auth required
- **OpenCode Zen**: `POST /v1/chat/completions` — API key required
- **NVIDIA NIM**: `POST /v1/chat/completions` — API key required (fallback)

## Environment Variables
```
OPENCODE_API_KEY    — OpenCode Zen API key for Kimi K2.5
NVIDIA_API_KEY      — NVIDIA NIM fallback (optional)
CACHE_TTL_MS        — Override default 5-min cache (optional)
```

## Key Files
- `api/config.js` — All tunable constants, weights, thresholds, AI prompt
- `api/markets.js` — Serverless function: fetch, rank, AI headlines, cache
- `index.html` — Drudge-style frontend
- `vercel.json` — Vercel deployment config (30s timeout for AI calls)
