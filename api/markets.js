// Vercel Serverless Function — Polymarket Report data pipeline
// Fetches from Gamma API + Data API, ranks, generates AI headlines, caches

import {
  GAMMA_API,
  DATA_API,
  AI_PROVIDERS,
  TOTAL_MARKETS,
  GAMMA_FETCH_LIMIT,
  WHALE_TRADE_THRESHOLD,
  WHALE_LOOKBACK_MINUTES,
  WEIGHTS,
  RED_THRESHOLDS,
  CACHE_TTL_MS,
  HEADLINE_SYSTEM_PROMPT,
  buildHeadlineUserPrompt,
} from './config.js';

// ============================================
// IN-MEMORY CACHE (persists across warm invocations)
// ============================================
let cache = { data: null, timestamp: 0 };

// ============================================
// GAMMA API — Fetch biggest movers (both directions)
// ============================================
async function fetchBiggestMovers() {
  // Fetch top gainers and top losers separately, merge by absolute change
  const [gainersRes, losersRes] = await Promise.all([
    fetch(`${GAMMA_API}/markets?active=true&closed=false&order=oneDayPriceChange&ascending=false&limit=${GAMMA_FETCH_LIMIT}`),
    fetch(`${GAMMA_API}/markets?active=true&closed=false&order=oneDayPriceChange&ascending=true&limit=${GAMMA_FETCH_LIMIT}`),
  ]);

  if (!gainersRes.ok || !losersRes.ok) {
    throw new Error(`Gamma API error: gainers=${gainersRes.status} losers=${losersRes.status}`);
  }

  const [gainers, losers] = await Promise.all([gainersRes.json(), losersRes.json()]);

  // Merge and deduplicate by market ID
  const seen = new Set();
  const merged = [];
  for (const m of [...gainers, ...losers]) {
    const id = m.id || m.conditionId;
    if (!seen.has(id) && m.oneDayPriceChange != null) {
      seen.add(id);
      merged.push(m);
    }
  }

  // Sort by absolute 24h price change
  merged.sort((a, b) => Math.abs(b.oneDayPriceChange) - Math.abs(a.oneDayPriceChange));
  return merged;
}

// ============================================
// GAMMA API — Fetch volume leaders
// ============================================
async function fetchVolumeLeaders() {
  const res = await fetch(
    `${GAMMA_API}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=${GAMMA_FETCH_LIMIT}`
  );
  if (!res.ok) throw new Error(`Gamma volume API error: ${res.status}`);
  return res.json();
}

// ============================================
// DATA API — Fetch recent whale trades
// ============================================
async function fetchWhaleTrades() {
  try {
    const res = await fetch(
      `${DATA_API}/trades?filterType=CASH&filterAmount=${WHALE_TRADE_THRESHOLD}`
    );
    if (!res.ok) {
      console.error(`Data API whale trades error: ${res.status}`);
      return [];
    }
    const trades = await res.json();

    // Filter to recent trades only
    const cutoff = Date.now() - WHALE_LOOKBACK_MINUTES * 60 * 1000;
    return (trades || []).filter(t => {
      const ts = new Date(t.timestamp || t.created_at || t.createdAt).getTime();
      return ts >= cutoff;
    });
  } catch (err) {
    console.error('Whale trade fetch failed (non-fatal):', err.message);
    return [];
  }
}

// ============================================
// MERGE & RANK — Combine all feeds into one ranked list
// ============================================
function mergeAndRank(movers, volumeLeaders, whaleTrades) {
  // Build whale trade index: marketId → { count, totalUsd, largestSide, contrarian }
  const whaleIndex = {};
  for (const trade of whaleTrades) {
    const mid = trade.market || trade.conditionId || trade.asset;
    if (!mid) continue;
    if (!whaleIndex[mid]) {
      whaleIndex[mid] = { count: 0, totalUsd: 0, sides: [] };
    }
    whaleIndex[mid].count += 1;
    whaleIndex[mid].totalUsd += parseFloat(trade.amount || trade.size || 0);
    whaleIndex[mid].sides.push(trade.side || trade.outcome);
  }

  // Build a unified market map by ID
  const marketMap = new Map();

  // Add movers (primary source)
  for (const m of movers) {
    const id = m.id || m.conditionId;
    marketMap.set(id, {
      ...m,
      _sources: ['movers'],
      _absPriceChange: Math.abs(m.oneDayPriceChange || 0),
    });
  }

  // Merge volume leaders
  for (const m of volumeLeaders) {
    const id = m.id || m.conditionId;
    if (marketMap.has(id)) {
      marketMap.get(id)._sources.push('volume');
    } else {
      marketMap.set(id, {
        ...m,
        _sources: ['volume'],
        _absPriceChange: Math.abs(m.oneDayPriceChange || 0),
      });
    }
  }

  // Compute normalization factors
  const allMarkets = Array.from(marketMap.values());
  const maxAbsChange = Math.max(...allMarkets.map(m => m._absPriceChange), 0.001);
  const maxVolume = Math.max(...allMarkets.map(m => m.volume24hr || 0), 1);

  // Score each market
  for (const m of allMarkets) {
    const id = m.id || m.conditionId;
    const whale = whaleIndex[id];

    // Normalized signals [0, 1]
    const priceSignal = m._absPriceChange / maxAbsChange;
    const volumeSignal = (m.volume24hr || 0) / maxVolume;
    const whaleSignal = whale ? Math.min(whale.count / 3, 1) : 0; // 3+ whale trades = max signal
    const newTrendingSignal = isNewAndTrending(m) ? 1 : 0;

    m._score = (priceSignal * WEIGHTS.priceChange)
             + (volumeSignal * WEIGHTS.volume)
             + (whaleSignal * WEIGHTS.whale)
             + (newTrendingSignal * WEIGHTS.newTrending);

    // Multi-source boost: appearing in both movers AND volume is extra signal
    if (m._sources.length > 1) {
      m._score *= 1.15;
    }

    // Attach whale info for headline generation
    if (whale) {
      const dominantSide = getMajoritySide(whale.sides);
      m._whaleInfo = whale;
      m.whaleSignal = `${whale.count} large trade(s) totaling ~$${Math.round(whale.totalUsd).toLocaleString()}, mostly ${dominantSide}`;
    }
  }

  // Sort by composite score, take top N
  allMarkets.sort((a, b) => b._score - a._score);

  // Determine red headline threshold (top percentile of those we'll show)
  const displayed = allMarkets.slice(0, TOTAL_MARKETS);
  const scoreThreshold = displayed.length > 0
    ? displayed[Math.floor(displayed.length * RED_THRESHOLDS.topPercentile)]._score
    : 0;

  // Prepare output
  return displayed.map(m => {
    const absPct = Math.abs((m.oneDayPriceChange || 0) * 100);
    const isRed = absPct >= RED_THRESHOLDS.priceChangePct
               || !!m._whaleInfo
               || m._score >= scoreThreshold;

    // Best YES price: outcomePrices is typically a JSON string "[0.55, 0.45]"
    let bestYesPrice = 0.5;
    try {
      if (m.outcomePrices) {
        const prices = typeof m.outcomePrices === 'string'
          ? JSON.parse(m.outcomePrices)
          : m.outcomePrices;
        bestYesPrice = parseFloat(prices[0]) || 0.5;
      } else if (m.bestBid != null) {
        bestYesPrice = m.bestBid;
      }
    } catch { /* use default */ }

    return {
      id: m.id || m.conditionId,
      question: m.question || m.title || 'Unknown Market',
      description: m.description || '',
      slug: m.slug,
      eventSlug: m.events?.[0]?.slug || m.eventSlug || m.slug,
      oneDayPriceChange: m.oneDayPriceChange || 0,
      volume24hr: m.volume24hr || 0,
      bestYesPrice,
      resolved: !!m.resolved,
      endDate: m.endDate,
      whaleSignal: m.whaleSignal || null,
      isRed,
      score: Math.round(m._score * 1000) / 1000,
    };
  });
}

function isNewAndTrending(market) {
  if (!market.createdAt) return false;
  const ageMs = Date.now() - new Date(market.createdAt).getTime();
  const threeDays = 3 * 24 * 60 * 60 * 1000;
  return ageMs < threeDays && (market.volume24hr || 0) > 5000;
}

function getMajoritySide(sides) {
  const counts = {};
  for (const s of sides) {
    const key = (s || 'unknown').toLowerCase();
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';
}

// ============================================
// AI HEADLINE GENERATION
// ============================================
async function generateHeadlines(markets) {
  const userPrompt = buildHeadlineUserPrompt(markets);

  for (const provider of AI_PROVIDERS) {
    const apiKey = process.env[provider.envKey];
    if (!apiKey) {
      console.log(`AI provider ${provider.name}: no API key (${provider.envKey}), skipping`);
      continue;
    }

    try {
      console.log(`Trying AI provider: ${provider.name}`);
      const res = await fetch(provider.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: 'system', content: HEADLINE_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 2000,
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.error(`AI provider ${provider.name} returned ${res.status}: ${errText}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        console.error(`AI provider ${provider.name}: empty response`);
        continue;
      }

      // Parse JSON array from response (handle markdown code fences)
      const cleaned = content.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      const headlines = JSON.parse(cleaned);

      if (Array.isArray(headlines) && headlines.length === markets.length) {
        console.log(`AI headlines generated via ${provider.name}`);
        return headlines;
      } else {
        console.error(`AI provider ${provider.name}: expected ${markets.length} headlines, got ${headlines?.length}`);
        continue;
      }
    } catch (err) {
      console.error(`AI provider ${provider.name} failed:`, err.message);
      continue;
    }
  }

  // Fallback: use raw market questions
  console.log('All AI providers failed, using raw market questions as headlines');
  return null;
}

// ============================================
// MAIN HANDLER
// ============================================
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  try {
    // Check cache
    const now = Date.now();
    const ttl = parseInt(process.env.CACHE_TTL_MS) || CACHE_TTL_MS;

    if (cache.data && (now - cache.timestamp) < ttl) {
      console.log(`Cache hit (age: ${Math.round((now - cache.timestamp) / 1000)}s)`);
      res.status(200).json(cache.data);
      return;
    }

    console.log('Cache miss — fetching fresh data');

    // Fetch all data sources in parallel
    const [movers, volumeLeaders, whaleTrades] = await Promise.all([
      fetchBiggestMovers(),
      fetchVolumeLeaders(),
      fetchWhaleTrades(),
    ]);

    console.log(`Fetched: ${movers.length} movers, ${volumeLeaders.length} volume leaders, ${whaleTrades.length} whale trades`);

    // Merge and rank
    const ranked = mergeAndRank(movers, volumeLeaders, whaleTrades);
    console.log(`Ranked: ${ranked.length} markets for display`);

    // Generate AI headlines
    const headlines = await generateHeadlines(ranked);

    // Attach headlines to markets
    const markets = ranked.map((m, i) => ({
      ...m,
      headline: headlines ? headlines[i] : null,
    }));

    const result = {
      markets,
      meta: {
        generated: new Date().toISOString(),
        sources: {
          movers: movers.length,
          volumeLeaders: volumeLeaders.length,
          whaleTrades: whaleTrades.length,
        },
        aiProvider: headlines ? 'active' : 'fallback',
      },
    };

    // Update cache
    cache = { data: result, timestamp: now };

    res.status(200).json(result);
  } catch (error) {
    console.error('Pipeline error:', error);

    // If we have stale cache, serve it rather than failing
    if (cache.data) {
      console.log('Serving stale cache after error');
      res.status(200).json({ ...cache.data, meta: { ...cache.data.meta, stale: true } });
      return;
    }

    res.status(500).json({
      error: 'Failed to fetch markets',
      message: error.message,
    });
  }
}
