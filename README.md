# Polymarket Report

A Drudge Report-style news aggregator using Polymarket prediction markets as content curation signals.

## The CORS Fix

**Problem**: Polymarket's API doesn't include CORS headers, blocking direct browser requests.

**Solution**: Added a Vercel Serverless Function (`api/markets.js`) that proxies API requests server-side, bypassing browser CORS restrictions.

## Project Structure

```
├── index.html          # Main page (Drudge-style layout)
├── api/
│   └── markets.js      # Vercel serverless function (API proxy)
├── vercel.json         # Vercel configuration
└── README.md           # This file
```

## How It Works

1. Browser loads `index.html`
2. JavaScript fetches from `/api/markets` (our proxy)
3. Vercel serverless function fetches from Polymarket (no CORS issue)
4. Data flows back to browser
5. Markets are ranked by weighted algorithm (price change + volume + trades)
6. Display in Drudge-style three-column layout

## Deployment to Vercel

### Option 1: Vercel CLI

```bash
# Install Vercel CLI globally (optional)
npm install -g vercel

# Deploy from project directory
vercel --prod
```

### Option 2: GitHub + Vercel Dashboard

1. Push this project to GitHub
2. Go to vercel.com/dashboard
3. Click "New Project"
4. Import your GitHub repository
5. Deploy (Vercel auto-detects the configuration)

### Option 3: Drag & Drop

1. Go to vercel.com/dashboard
2. Drag the entire project folder into Vercel
3. Deploy

## Local Development

To test locally with Vercel dev server:

```bash
npx vercel dev
```

Then open http://localhost:3000

## Configuration

### Ranking Weights

Edit these values in `index.html` (around line 143):

```javascript
const RANKING_WEIGHTS = {
  priceChange: 0.60,    // 60% weight on 24hr price movement
  volume: 0.30,         // 30% weight on trading volume
  tradeCount: 0.10      // 10% weight on number of trades
};
```

### Display Settings

```javascript
const TOTAL_MARKETS = 28;        // 1 main + 27 in columns
const RED_HEADLINE_COUNT = 7;    // Top N markets show in red
```

## Troubleshooting

**"Error loading markets" message:**
- Make sure you've deployed to Vercel (not opening index.html locally)
- The `/api/markets` endpoint only works when deployed to Vercel
- Local file:// protocol won't work - you need a server

**Markets not ranking correctly:**
- Adjust `RANKING_WEIGHTS` in index.html
- Check browser console for debugging info
- Weights must sum to any value (typically 1.0)

## Next Steps

1. Deploy to Vercel ✅
2. Test in production
3. Tune ranking weights based on results
4. Add news article matching (Phase 2)
