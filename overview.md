## Vision

A Drudge Report-style news aggregator that uses Polymarket prediction markets as content curation signals. Instead of editorial decisions, market prices and volumes determine what news matters. Shows "what the market is saying about this news" - combining financial signals with content discovery for high-signal news reading.

## Next Actions

- [ ] Set up Gamma API connection to fetch active markets
- [ ] Build 24hr activity calculator (price history + trades data)
- [ ] Create market ranking algorithm (volume, price change, trade count)
- [ ] Design headline extraction from market question/title field
- [ ] Build minimal frontend to display ranked headlines
- [ ] Add periodic polling/refresh mechanism
- [ ] Source news articles to link with markets (separate from Polymarket)

## Notes

### 2026-01-07 - Initial Concept

**Core Mechanic**:
- Fetch active markets from Gamma API
- Calculate 24hr activity metrics (volume, price changes, trade count)
- Rank markets by activity signals
- Display market questions as headlines
- Link to related news articles (sourced separately)

**Technical Implementation**:

**Step 1: Market Discovery**
- GET `https://gamma-api.polymarket.com/events?active=true&closed=false`
- Returns market metadata: question, outcomes, outcomePrices
- Poll periodically (every 5-15 min)

**Step 2: Activity Calculation**
- GET `https://clob.polymarket.com/prices-history?market={tokenId}&interval=1d`
  - Calculate 24hr price changes
- GET `https://data-api.polymarket.com/trades`
  - Track volume and trade count

**Step 3: Ranking Algorithm**
Combine signals:
- 24hr price delta (big moves = newsworthy)
- Volume (high activity = market cares)
- Number of trades (attention metric)
- Weight these to generate activity score

**Step 4: Display**
- Extract question/title from market as headline
- Show activity indicators (↑ price, volume, etc.)
- Ultra-minimal HTML layout
- Link to Polymarket market + related news

**Why This Works**:
- Markets aggregate information better than editors
- Price/volume = real signal about what matters
- Headlines come directly from market questions
- Simple to build - just API polling + ranking + display

**Key Design Decisions**:
- Use market question as headline directly
- Show current odds + 24hr change
- Drudge aesthetic: black/white, text-focused
- Mobile-first
- No login/accounts for MVP

**News Article Sourcing** (Separate Problem):
- Polymarket doesn't provide article links
- Options: manual curation, RSS feeds, Twitter links, or skip entirely for MVP
- Could just link to Polymarket market page initially

### Open Questions
- Name: "Polymarket News"? "Market Signal"? "Drudge Markets"?
- Monetization: free, or premium tier with more markets/features?
- Should MVP just link to market pages, or attempt news article sourcing?
- Ranking weights: how much to emphasize price change vs volume vs trade count?

## Resources

- [Polymarket API Docs](https://docs.polymarket.com/quickstart/overview#apis-at-a-glance)
- **Key Endpoints**:
  - Gamma API: `https://gamma-api.polymarket.com/events?active=true&closed=false`
  - CLOB API: `https://clob.polymarket.com/prices-history?market={tokenId}&interval=1d`
  - Data API: `https://data-api.polymarket.com/trades`
- Drudge Report for design reference: https://www.drudgereport.com/
- Drudge Report context: https://en.wikipedia.org/wiki/Drudge_Report
