// Diagnostic endpoint: test Gamma API tag strategies
// Hit /api/tags to see what works, verify slug→ID resolution

import { TAG_IDS, TAG_SLUGS } from './config.js';

const GAMMA_API = 'https://gamma-api.polymarket.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // 1. Resolve all our curated slugs to tag IDs (this is the critical test)
  results.slugResolution = {};
  await Promise.all(
    TAG_SLUGS.map(async (slug) => {
      try {
        const r = await fetch(`${GAMMA_API}/tags/slug/${slug}`);
        if (!r.ok) {
          results.slugResolution[slug] = { status: r.status, resolved: false };
          return;
        }
        const tag = await r.json();
        results.slugResolution[slug] = {
          resolved: true,
          id: tag.id,
          label: tag.label,
          slug: tag.slug,
        };
      } catch (err) {
        results.slugResolution[slug] = { error: err.message, resolved: false };
      }
    })
  );

  // 2. For each resolved slug, fetch 3 sample markets via tag_id
  results.tagIdSamples = {};
  const resolved = Object.entries(results.slugResolution)
    .filter(([, v]) => v.resolved)
    .map(([slug, v]) => ({ slug, id: v.id, label: v.label }));

  await Promise.all(
    [...resolved, ...TAG_IDS].map(async (tag) => {
      const key = tag.slug || tag.label;
      try {
        const r = await fetch(
          `${GAMMA_API}/markets?tag_id=${tag.id}&active=true&closed=false&order=volume24hr&ascending=false&limit=5`
        );
        if (!r.ok) {
          results.tagIdSamples[key] = { status: r.status };
          return;
        }
        const markets = await r.json();
        results.tagIdSamples[key] = {
          tagId: tag.id,
          count: markets.length,
          markets: markets.slice(0, 3).map(m => ({
            question: (m.question || '').substring(0, 100),
            volume24hr: m.volume24hr,
            change: m.oneDayPriceChange,
          })),
        };
      } catch (err) {
        results.tagIdSamples[key] = { error: err.message };
      }
    })
  );

  // 3. Featured events (confirmed working)
  try {
    const r = await fetch(`${GAMMA_API}/events?featured=true&active=true&closed=false&limit=20`);
    const events = r.ok ? await r.json() : [];
    results.featured = {
      count: events.length,
      events: events.map(e => ({
        title: e.title,
        order: e.featuredOrder,
        volume24hr: e.volume24hr,
        tags: (e.tags || []).map(t => t.label || t),
        marketCount: (e.markets || []).length,
      })),
    };
  } catch (err) {
    results.featured = { error: err.message };
  }

  // 4. Summary
  const resolvedCount = Object.values(results.slugResolution).filter(v => v.resolved).length;
  results.summary = {
    slugsConfigured: TAG_SLUGS.length,
    slugsResolved: resolvedCount,
    slugsFailed: TAG_SLUGS.length - resolvedCount,
    topLevelTagIds: TAG_IDS.length,
    failedSlugs: Object.entries(results.slugResolution)
      .filter(([, v]) => !v.resolved)
      .map(([slug]) => slug),
  };

  res.status(200).json(results);
}
