// Vercel Serverless Function — Polymarket Report data pipeline
// Fetches from Gamma API by tag, ranks, generates AI headlines, caches

import {
  GAMMA_API,
  DATA_API,
  AI_PROVIDERS,
  TOTAL_MARKETS,
  TAG_IDS,
  TAG_SLUGS,
  WHALE_TRADE_THRESHOLD,
  WHALE_LOOKBACK_MINUTES,
  WEIGHTS,
  RED_THRESHOLDS,
  CACHE_TTL_MS,
  NOISE_PATTERNS,
  HEADLINE_SYSTEM_PROMPT,
  buildHeadlineUserPrompt,
} from './config.js';

// ============================================
// IN-MEMORY CACHE (persists across warm invocations)
// ============================================
let cache = { data: null, timestamp: 0 };

// ============================================
// STRATEGY 1: Featured events (Polymarket's editorial picks)
// ============================================
async function fetchFeaturedEvents() {
  try {
    const res = await fetch(
      `${GAMMA_API}/events?featured=true&active=true&closed=false&limit=30`
    );
    if (!res.ok) {
      console.log(`  Featured events: ${res.status} (not supported or empty)`);
      return [];
    }
    const events = await res.json();
    // Events contain nested markets — extract them
    const markets = [];
    for (const evt of events) {
      if (evt.markets && Array.isArray(evt.markets)) {
        for (const m of evt.markets) {
          markets.push({ ...m, _source: 'featured' });
        }
      }
    }
    console.log(`  Featured events: ${events.length} events → ${markets.length} markets`);
    return markets;
  } catch (err) {
    console.log(`  Featured events: error (${err.message})`);
    return [];
  }
}

// ============================================
// STRATEGY 2: Top-level tag_id categories (numeric IDs)
// ============================================
async function fetchByTagIds() {
  const fetches = TAG_IDS.map(async ({ id, label }) => {
    try {
      // Try events endpoint with tag_id (returns events with nested markets)
      const res = await fetch(
        `${GAMMA_API}/events?tag_id=${id}&active=true&closed=false&order=volume24hr&ascending=false&limit=20`
      );
      if (!res.ok) {
        console.log(`  tag_id ${id} (${label}): events ${res.status}, trying markets...`);
        // Fallback: try markets endpoint with tag_id
        const res2 = await fetch(
          `${GAMMA_API}/markets?tag_id=${id}&active=true&closed=false&order=volume24hr&ascending=false&limit=50`
        );
        if (!res2.ok) return [];
        const markets = await res2.json();
        console.log(`  tag_id ${id} (${label}): ${markets.length} markets (via /markets)`);
        return markets;
      }
      const events = await res.json();
      const markets = [];
      for (const evt of events) {
        if (evt.markets && Array.isArray(evt.markets)) {
          for (const m of evt.markets) markets.push(m);
        }
      }
      console.log(`  tag_id ${id} (${label}): ${events.length} events → ${markets.length} markets`);
      return markets;
    } catch (err) {
      console.log(`  tag_id ${id} (${label}): error (${err.message})`);
      return [];
    }
  });
  return (await Promise.all(fetches)).flat();
}

// ============================================
// STRATEGY 3: Sub-tag slugs (curated specific topics)
// ============================================
async function fetchByTagSlugs() {
  const fetches = TAG_SLUGS.map(async (slug) => {
    try {
      const res = await fetch(
        `${GAMMA_API}/markets?active=true&closed=false&tag=${encodeURIComponent(slug)}&order=volume24hr&ascending=false&limit=30`
      );
      if (!res.ok) return [];
      const markets = await res.json();
      if (markets.length > 0) {
        console.log(`  tag "${slug}": ${markets.length} markets`);
      }
      return markets;
    } catch {
      return [];
    }
  });
  return (await Promise.all(fetches)).flat();
}

// ============================================
// COMBINED FETCH: Run all three strategies in parallel, merge results
// ============================================
async function fetchAllMarkets() {
  console.log('Fetching markets via 3 strategies...');
  const [featured, tagIdMarkets, tagSlugMarkets] = await Promise.all([
    fetchFeaturedEvents(),
    fetchByTagIds(),
    fetchByTagSlugs(),
  ]);
  console.log(`Strategy totals: ${featured.length} featured, ${tagIdMarkets.length} tag_id, ${tagSlugMarkets.length} tag_slug`);

  // Merge all, marking featured markets for score boost
  const all = [
    ...featured.map(m => ({ ...m, _isFeatured: true })),
    ...tagIdMarkets,
    ...tagSlugMarkets,
  ];
  return all;
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
// NOISE FILTER — Safety net for anything that slips through tags
// ============================================
function isNoiseMarket(market) {
  const question = market.question || market.title || '';
  return NOISE_PATTERNS.some(pattern => pattern.test(question));
}

// ============================================
// RANK — Deduplicate, score, and select top markets
// ============================================
function rankMarkets(allMarkets, whaleTrades) {
  // Build whale trade index
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

  // Deduplicate by market ID (same market can appear from multiple strategies/tags)
  const marketMap = new Map();
  for (const m of allMarkets) {
    const id = m.id || m.conditionId;
    if (!id || m.oneDayPriceChange == null) continue;
    if (!marketMap.has(id)) {
      marketMap.set(id, {
        ...m,
        _absPriceChange: Math.abs(m.oneDayPriceChange || 0),
        _isFeatured: !!m._isFeatured,
      });
    } else if (m._isFeatured) {
      // If we've seen this market before but now it's featured, mark it
      marketMap.get(id)._isFeatured = true;
    }
  }

  // Safety net: filter any noise that slipped through tags
  let noiseCount = 0;
  for (const [id, m] of marketMap) {
    if (isNoiseMarket(m)) {
      marketMap.delete(id);
      noiseCount++;
    }
  }

  const scorable = Array.from(marketMap.values());
  console.log(`${allMarkets.length} raw → ${scorable.length} unique markets (${noiseCount} noise filtered)`);

  if (scorable.length === 0) return [];

  // Compute normalization factors
  const maxAbsChange = Math.max(...scorable.map(m => m._absPriceChange), 0.001);
  const maxVolume = Math.max(...scorable.map(m => m.volume24hr || 0), 1);

  // Score each market
  for (const m of scorable) {
    const id = m.id || m.conditionId;
    const whale = whaleIndex[id];

    const priceSignal = m._absPriceChange / maxAbsChange;
    const volumeSignal = (m.volume24hr || 0) / maxVolume;
    const whaleSignal = whale ? Math.min(whale.count / 3, 1) : 0;
    const newTrendingSignal = isNewAndTrending(m) ? 1 : 0;

    m._score = (priceSignal * WEIGHTS.priceChange)
             + (volumeSignal * WEIGHTS.volume)
             + (whaleSignal * WEIGHTS.whale)
             + (newTrendingSignal * WEIGHTS.newTrending);

    // Featured boost: Polymarket's editorial picks get a significant boost
    if (m._isFeatured) {
      m._score *= 1.25;
    }

    // Attach whale info for headline generation
    if (whale) {
      const dominantSide = getMajoritySide(whale.sides);
      m._whaleInfo = whale;
      m.whaleSignal = `${whale.count} large trade(s) totaling ~$${Math.round(whale.totalUsd).toLocaleString()}, mostly ${dominantSide}`;
    }
  }

  // Sort by composite score, take top N
  scorable.sort((a, b) => b._score - a._score);

  const displayed = scorable.slice(0, TOTAL_MARKETS);
  const redCount = Math.floor(displayed.length * RED_THRESHOLDS.topPercentile);
  const scoreThreshold = displayed.length > 0
    ? displayed[redCount]._score
    : 0;

  // Log top markets for debugging
  console.log(`Displaying ${displayed.length} markets (${redCount} red)`);
  displayed.slice(0, 5).forEach((m, i) => {
    const q = (m.question || '').substring(0, 70);
    console.log(`  #${i + 1}: [${m._score.toFixed(3)}] "${q}"`);
  });

  return displayed.map(m => {
    const isRed = m._score >= scoreThreshold;

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

    // Fetch from all strategies + whale trades in parallel
    const [allTagMarkets, whaleTrades] = await Promise.all([
      fetchAllMarkets(),
      fetchWhaleTrades(),
    ]);

    console.log(`Total fetched: ${allTagMarkets.length} markets, ${whaleTrades.length} whale trades`);

    // Rank and select
    const ranked = rankMarkets(allTagMarkets, whaleTrades);
    console.log(`Final: ${ranked.length} markets for display`);

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
        tagIds: TAG_IDS.map(t => t.label),
        tagSlugs: TAG_SLUGS,
        sources: { totalMarkets: allTagMarkets.length, whaleTrades: whaleTrades.length },
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
