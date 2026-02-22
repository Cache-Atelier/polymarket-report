// Vercel Serverless Function — Polymarket Report data pipeline
// Fetches from Gamma API using tag_id + featured events, ranks, generates AI headlines

import {
  GAMMA_API,
  DATA_API,
  AI_PROVIDERS,
  TOTAL_MARKETS,
  LLM_CANDIDATE_POOL,
  TAG_IDS,
  TAG_SLUGS,
  WHALE_TRADE_THRESHOLD,
  WHALE_LOOKBACK_MINUTES,
  WEIGHTS,
  RED_THRESHOLDS,
  CACHE_TTL_MS,
  NOISE_PATTERNS,
  VOLUME_FLOOR,
  VOLUME_FLOOR_PENALTY,
  EXPIRY_DRIFT,
  EDITORIAL_SYSTEM_PROMPT,
  buildEditorialUserPrompt,
} from './config.js';

// ============================================
// IN-MEMORY CACHES (persist across warm invocations)
// ============================================
let cache = { data: null, timestamp: 0 };
let slugIdCache = null; // slug → tag_id mapping, resolved once per cold start

// ============================================
// SLUG → TAG_ID RESOLVER
// The /markets?tag=slug endpoint is broken (returns unfiltered results
// regardless of slug). The /markets?tag_id=N endpoint works correctly.
// So we resolve our curated slugs to numeric IDs via /tags/slug/{slug},
// then fetch markets using tag_id.
// ============================================
async function resolveTagSlugs() {
  if (slugIdCache) return slugIdCache;

  const results = await Promise.all(
    TAG_SLUGS.map(async (slug) => {
      try {
        const res = await fetch(`${GAMMA_API}/tags/slug/${slug}`);
        if (!res.ok) {
          console.log(`  slug "${slug}": ${res.status} (not found)`);
          return null;
        }
        const tag = await res.json();
        return { slug, id: tag.id, label: tag.label };
      } catch (err) {
        console.log(`  slug "${slug}": error (${err.message})`);
        return null;
      }
    })
  );

  slugIdCache = results.filter(Boolean);
  console.log(`Resolved ${slugIdCache.length}/${TAG_SLUGS.length} tag slugs to IDs`);
  slugIdCache.forEach(t => console.log(`  ${t.slug} → ${t.id} (${t.label})`));
  return slugIdCache;
}

// ============================================
// STRATEGY 1: Featured events (Polymarket's editorial picks)
// ============================================
async function fetchFeaturedEvents() {
  try {
    const res = await fetch(
      `${GAMMA_API}/events?featured=true&active=true&closed=false&limit=30`
    );
    if (!res.ok) {
      console.log(`  Featured events: ${res.status}`);
      return [];
    }
    const events = await res.json();
    // Extract nested markets from events
    const markets = [];
    for (const evt of events) {
      if (evt.markets && Array.isArray(evt.markets)) {
        for (const m of evt.markets) {
          markets.push({ ...m, _isFeatured: true });
        }
      }
    }
    console.log(`  Featured: ${events.length} events → ${markets.length} markets`);
    return markets;
  } catch (err) {
    console.log(`  Featured events: error (${err.message})`);
    return [];
  }
}

// ============================================
// STRATEGY 2: Markets by tag_id (works correctly, unlike tag=slug)
// ============================================
async function fetchMarketsByTagId(id, label, limit = 50) {
  try {
    const res = await fetch(
      `${GAMMA_API}/markets?tag_id=${id}&active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}`
    );
    if (!res.ok) {
      console.log(`  tag_id ${id} (${label}): ${res.status}`);
      return [];
    }
    const markets = await res.json();
    if (markets.length > 0) {
      console.log(`  tag_id ${id} (${label}): ${markets.length} markets`);
    }
    return markets;
  } catch (err) {
    console.log(`  tag_id ${id} (${label}): error (${err.message})`);
    return [];
  }
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
// COMBINED FETCH: resolve slugs, then fetch all in parallel
// ============================================
async function fetchAllMarkets() {
  console.log('Phase 1: Resolving tag slugs to IDs...');
  const resolvedTags = await resolveTagSlugs();

  // Build full list of tag_ids: top-level + resolved sub-tags
  const allTagIds = [
    ...TAG_IDS.map(t => ({ ...t, limit: 50 })),
    ...resolvedTags.map(t => ({ id: t.id, label: `${t.label} [${t.slug}]`, limit: 30 })),
  ];

  console.log(`Phase 2: Fetching from ${allTagIds.length} tag_ids + featured events...`);
  const [featured, ...tagResults] = await Promise.all([
    fetchFeaturedEvents(),
    ...allTagIds.map(t => fetchMarketsByTagId(t.id, t.label, t.limit)),
  ]);

  const tagMarkets = tagResults.flat();
  console.log(`Strategy totals: ${featured.length} featured, ${tagMarkets.length} from tag_ids`);

  return [...featured, ...tagMarkets];
}

// ============================================
// NOISE FILTER — Lightweight safety net
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

  // Deduplicate by market ID
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
      marketMap.get(id)._isFeatured = true;
    }
  }

  // Safety net noise filter
  let noiseCount = 0;
  for (const [id, m] of marketMap) {
    if (isNoiseMarket(m)) {
      marketMap.delete(id);
      noiseCount++;
    }
  }

  const scorable = Array.from(marketMap.values());
  console.log(`${allMarkets.length} raw → ${scorable.length} unique (${noiseCount} noise filtered)`);

  if (scorable.length === 0) return [];

  // Normalization
  const maxAbsChange = Math.max(...scorable.map(m => m._absPriceChange), 0.001);
  const maxVolume = Math.max(...scorable.map(m => m.volume24hr || 0), 1);

  // Score each market
  for (const m of scorable) {
    const id = m.id || m.conditionId;
    const whale = whaleIndex[id];

    let priceSignal = m._absPriceChange / maxAbsChange;
    const volumeSignal = (m.volume24hr || 0) / maxVolume;
    const whaleSignal = whale ? Math.min(whale.count / 3, 1) : 0;
    const newTrendingSignal = isNewAndTrending(m) ? 1 : 0;

    // Expiry drift dampener: markets near deadline naturally resolve toward
    // 0% or 100%. A big price swing there isn't news — it's just a clock
    // running out. Dampen the price signal for these.
    if (m.endDate) {
      const daysToExpiry = (new Date(m.endDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      let yesPrice = 0.5;
      try {
        if (m.outcomePrices) {
          const prices = typeof m.outcomePrices === 'string'
            ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          yesPrice = parseFloat(prices[0]) || 0.5;
        } else if (m.bestBid != null) {
          yesPrice = m.bestBid;
        }
      } catch { /* use default */ }

      if (daysToExpiry <= EXPIRY_DRIFT.daysThreshold
          && (yesPrice < EXPIRY_DRIFT.priceExtremeBelow || yesPrice > EXPIRY_DRIFT.priceExtremeAbove)) {
        priceSignal *= EXPIRY_DRIFT.dampener;
      }
    }

    m._score = (volumeSignal * WEIGHTS.volume)
             + (priceSignal * WEIGHTS.priceChange)
             + (whaleSignal * WEIGHTS.whale)
             + (newTrendingSignal * WEIGHTS.newTrending);

    // Volume floor: a big swing in a tiny market is illiquidity, not news
    if ((m.volume24hr || 0) < VOLUME_FLOOR) {
      m._score *= VOLUME_FLOOR_PENALTY;
    }

    // Stale market penalty: no movement + no whale = not newsworthy
    if (Math.abs(m.oneDayPriceChange || 0) < 0.005 && !whale) {
      m._score *= 0.5;
    }

    // Featured boost: Polymarket's editorial picks
    if (m._isFeatured) {
      m._score *= WEIGHTS.featuredBoost;
    }

    if (whale) {
      const dominantSide = getMajoritySide(whale.sides);
      m._whaleInfo = whale;
      m.whaleSignal = `${whale.count} large trade(s) totaling ~$${Math.round(whale.totalUsd).toLocaleString()}, mostly ${dominantSide}`;
    }
  }

  // Sort by composite score
  scorable.sort((a, b) => b._score - a._score);

  // Event-level dedup: keep one representative per eventSlug
  const eventSeen = new Map(); // eventSlug → { rep, count }
  const deduped = [];
  for (const m of scorable) {
    const eSlug = m.events?.[0]?.slug || m.eventSlug || m.slug;
    if (eventSeen.has(eSlug)) {
      // Already have a rep for this event — just bump the count
      eventSeen.get(eSlug).count++;
      // Steal whale signal if this sibling has one and the rep doesn't
      if (m.whaleSignal && !eventSeen.get(eSlug).rep.whaleSignal) {
        eventSeen.get(eSlug).rep.whaleSignal = m.whaleSignal;
        eventSeen.get(eSlug).rep._whaleInfo = m._whaleInfo;
      }
      continue;
    }
    eventSeen.set(eSlug, { rep: m, count: 1 });
    deduped.push(m);
  }
  // Tag representatives with their group size
  for (const { rep, count } of eventSeen.values()) {
    rep._eventGroupSize = count;
  }
  console.log(`Event dedup: ${scorable.length} → ${deduped.length} markets (${scorable.length - deduped.length} dupes removed)`);

  const poolSize = Math.min(deduped.length, LLM_CANDIDATE_POOL);
  const candidates = deduped.slice(0, poolSize);

  // Log top candidates
  console.log(`Candidate pool: ${candidates.length} markets for LLM curation`);
  candidates.slice(0, 8).forEach((m, i) => {
    const q = (m.question || '').substring(0, 70);
    const feat = m._isFeatured ? ' [FEAT]' : '';
    console.log(`  #${i + 1}: [${m._score.toFixed(3)}] "${q}"${feat}`);
  });

  return candidates.map(m => {
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
      isFeatured: !!m._isFeatured,
      score: Math.round(m._score * 1000) / 1000,
      eventGroupSize: m._eventGroupSize || 1,
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
// LLM EDITORIAL CURATION — Race all providers in parallel
// First valid response wins. Logs timing for every provider.
// ============================================
async function curateWithLLM(candidates) {
  const userPrompt = buildEditorialUserPrompt(candidates);

  // Build a lookup so we can reconstruct full market objects from LLM's picks
  const candidateMap = new Map();
  for (const m of candidates) {
    candidateMap.set(String(m.id), m);
  }

  // Filter to providers with API keys
  const runnableProviders = AI_PROVIDERS.filter(p => {
    const key = process.env[p.envKey];
    if (!key) console.log(`AI curation ${p.name}: no API key (${p.envKey}), skipping`);
    return !!key;
  });

  if (runnableProviders.length === 0) {
    console.log('No AI providers configured');
    return null;
  }

  console.log(`Racing ${runnableProviders.length} AI providers in parallel...`);

  // Race: fire all providers at once, first valid parse wins
  const raceResults = runnableProviders.map(provider => {
    const apiKey = process.env[provider.envKey];
    const t0 = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50_000);

    return fetch(provider.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: provider.model,
        messages: [
          { role: 'system', content: EDITORIAL_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.7,
        max_tokens: provider.maxTokens || 4000,
      }),
      signal: controller.signal,
    })
    .then(async res => {
      const elapsed = Date.now() - t0;
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${res.status}: ${errText}`);
      }
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content
        || data.choices?.[0]?.message?.text
        || data.choices?.[0]?.text
        || (typeof data.result === 'string' ? data.result : null);
      if (!content) {
        const msg = data.choices?.[0]?.message;
        throw new Error(
          `empty response. finish_reason=${data.choices?.[0]?.finish_reason}` +
          `, reasoning_content length=${(msg?.reasoning_content || '').length}`
        );
      }
      const cleaned = content.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      let picks = JSON.parse(cleaned);
      if (picks && !Array.isArray(picks) && typeof picks === 'object') {
        const arrVal = Object.values(picks).find(v => Array.isArray(v));
        if (arrVal) picks = arrVal;
      }
      if (!Array.isArray(picks) || picks.length === 0) {
        throw new Error('invalid JSON (not an array or empty)');
      }
      console.log(`  ${provider.name}: responded in ${(elapsed / 1000).toFixed(1)}s (${picks.length} picks)`);
      return { provider, picks, elapsed };
    })
    .catch(err => {
      clearTimeout(timeout);
      const elapsed = Date.now() - t0;
      console.error(`  ${provider.name}: failed in ${(elapsed / 1000).toFixed(1)}s — ${err.message}`);
      throw err; // re-throw so Promise.any skips it
    })
    .finally(() => clearTimeout(timeout));
  });

  try {
    const { provider, picks, elapsed } = await Promise.any(raceResults);

    // Reconstruct full market objects in the LLM's chosen order
    const curated = [];
    for (const pick of picks) {
      const original = candidateMap.get(String(pick.id));
      if (!original) {
        console.log(`  LLM picked unknown id "${pick.id}", skipping`);
        continue;
      }
      curated.push({
        ...original,
        headline: pick.headline || null,
        isRed: !!pick.isRed,
      });
    }

    if (curated.length < TOTAL_MARKETS * 0.5) {
      console.error(`AI curation ${provider.name}: only matched ${curated.length}/${picks.length} IDs, too few`);
      return null;
    }

    console.log(`AI curation winner: ${provider.name} in ${(elapsed / 1000).toFixed(1)}s — ${curated.length} markets (${curated.filter(m => m.isRed).length} red)`);
    curated.slice(0, 5).forEach((m, i) => {
      const red = m.isRed ? ' [RED]' : '';
      console.log(`  #${i + 1}: "${(m.headline || m.question).substring(0, 70)}"${red}`);
    });

    return { markets: curated.slice(0, TOTAL_MARKETS), aiProvider: provider.name, aiResponseMs: elapsed };
  } catch {
    // All providers rejected
    console.log('All AI providers failed');
    return null;
  }
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
    const now = Date.now();
    const ttl = parseInt(process.env.CACHE_TTL_MS) || CACHE_TTL_MS;

    if (cache.data && (now - cache.timestamp) < ttl) {
      console.log(`Cache hit (age: ${Math.round((now - cache.timestamp) / 1000)}s)`);
      res.status(200).json(cache.data);
      return;
    }

    console.log('Cache miss — fetching fresh data');

    // Fetch all markets + whale trades in parallel
    const [allMarkets, whaleTrades] = await Promise.all([
      fetchAllMarkets(),
      fetchWhaleTrades(),
    ]);

    console.log(`Total: ${allMarkets.length} markets, ${whaleTrades.length} whale trades`);

    // Phase 1: Algorithmic scoring → candidate pool (~42 markets)
    const candidates = rankMarkets(allMarkets, whaleTrades);
    console.log(`Candidate pool: ${candidates.length} markets`);

    // Phase 2: LLM editorial curation (race all providers in parallel)
    const curationResult = await curateWithLLM(candidates);
    let markets, aiMode, aiProvider = null, aiResponseMs = null;

    if (curationResult) {
      markets = curationResult.markets;
      aiMode = 'curated';
      aiProvider = curationResult.aiProvider;
      aiResponseMs = curationResult.aiResponseMs;
    } else {
      console.log('All AI providers failed — using algorithmic order');
      markets = candidates.slice(0, TOTAL_MARKETS).map((m, i) => ({
        ...m,
        headline: null,
        isRed: i < Math.floor(TOTAL_MARKETS * RED_THRESHOLDS.topPercentile),
      }));
      aiMode = 'fallback';
    }

    console.log(`Final: ${markets.length} markets (mode: ${aiMode})`);

    const result = {
      markets,
      meta: {
        generated: new Date().toISOString(),
        tagIds: TAG_IDS.map(t => t.label),
        resolvedSlugs: (slugIdCache || []).map(t => `${t.slug}→${t.id}`),
        sources: { totalMarkets: allMarkets.length, whaleTrades: whaleTrades.length },
        aiMode,
        aiProvider,
        aiResponseMs,
      },
    };

    cache = { data: result, timestamp: now };
    res.status(200).json(result);
  } catch (error) {
    console.error('Pipeline error:', error);

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
