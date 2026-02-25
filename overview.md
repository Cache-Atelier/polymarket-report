## Vision

A Drudge Report-style news aggregator that uses Polymarket prediction markets as content curation signals. Instead of editorial decisions, market prices, volume, and whale activity determine what news matters. An LLM (Claude Opus via OpenCode Zen) writes punchy, informative headlines with full event context, resolution criteria, and holistic sub-market analysis.

## Architecture (v2 — Decoupled Generation)

### Curation Pipeline (generate.js — runs offline via GitHub Actions)
1. **Enriched Data Fetch** — Events with full sub-market trees, descriptions, resolution criteria
2. **Recently Resolved** — Markets that resolved in the last 24h (confirmed outcomes = real news)
3. **Whale Trades** — Data API large trades ($10K+), 6-hour lookback window
4. **Two-Tier Noise Filtering**:
   - **Tier 1 (hard)**: Always excluded — crypto prices, player stats, esports, social media metrics
   - **Tier 2 (soft)**: Flagged for LLM judgment — weather, entertainment, sports (sometimes newsworthy)
5. **Scoring & Ranking** — Weighted composite: 35% volume, 25% price change, 25% whale, 10% trending
6. **Event Grouping** — Sub-markets grouped by parent event for holistic analysis
7. **Editorial Briefing** — Rich structured prompt with descriptions, resolution criteria, sibling markets
8. **LLM Curation** — Claude Opus (or any model via OpenCode Zen) with extended thinking, no time pressure
9. **Output** — `data/headlines.json` committed to repo, triggers Vercel deploy

### Serving Layer (api/markets.js — Vercel serverless, trivial)
- Reads pre-computed `data/headlines.json`
- Returns with CORS headers and cache control
- Sub-second response, no LLM latency in request path

### Schedule
- GitHub Actions cron: 2x daily (10am ET, 7pm ET)
- Manual trigger available via workflow_dispatch
- ~5 min per run, well within free tier (2,000 min/month)

### Frontend (index.html)
- Drudge Report aesthetic: black/white, text-focused, monospace
- Red headlines flagged by LLM for urgency/drama
- Movement indicators (↑/↓ with %) appended automatically
- "WHALE ALERT" tags on markets with large trades

## Key Files
- `generate.js` — Offline curation: fetch, filter, score, brief, LLM call, write JSON
- `api/markets.js` — Thin serving layer (reads headlines.json)
- `api/config.js` — Legacy config (retained for reference; generate.js is self-contained)
- `index.html` — Drudge-style frontend
- `.github/workflows/curate.yml` — GitHub Actions cron schedule
- `data/headlines.json` — Pre-computed curation output (auto-generated, committed by CI)
- `vercel.json` — Vercel deployment config

## Environment Variables
```
OPENCODE_API_KEY    — OpenCode Zen API key (set in GitHub Actions secrets)
AI_MODEL            — Model to use (default: claude-opus-4-20250115, set in GitHub Actions vars)
```
