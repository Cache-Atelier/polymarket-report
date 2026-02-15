#!/usr/bin/env node
// Polymarket Tag Discovery Script
// Run: node api/discover-tags.js
//
// Fetches ALL tags from the Gamma API /tags endpoint, then cross-references
// with live markets/events to produce a report of every tag with:
//   - tag_id, label, slug
//   - active market count
//   - 2-3 example market questions
//
// The Gamma API has ~9,000 tags. This script paginates through all of them,
// then samples markets for the most-used tags.

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchAllTags() {
  const allTags = [];
  const limit = 100;
  let offset = 0;
  let batch;

  console.log('Fetching all tags from /tags endpoint...');
  do {
    const url = `${GAMMA_API}/tags?limit=${limit}&offset=${offset}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`Failed at offset ${offset}: ${res.status}`);
      break;
    }
    batch = await res.json();
    allTags.push(...batch);
    offset += limit;
    if (batch.length > 0) {
      process.stdout.write(`  ...fetched ${allTags.length} tags so far\r`);
    }
  } while (batch.length === limit);

  console.log(`\nTotal tags fetched: ${allTags.length}`);
  return allTags;
}

async function fetchMarketsByTag(tagId, limit = 10) {
  const url = `${GAMMA_API}/events?tag_id=${tagId}&active=true&closed=false&order=volume24hr&ascending=false&limit=${limit}&related_tags=true`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function fetchMarketsWithTagSlug(tagSlug, limit = 200) {
  // Alternative: use the ?tag= parameter with a slug string
  const url = `${GAMMA_API}/markets?tag=${encodeURIComponent(tagSlug)}&active=true&closed=false&limit=${limit}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}

async function fetchDiverseMarkets() {
  // Fetch markets with different sort orders to discover tags from market data
  const sorts = [
    { order: 'volume24hr', ascending: false, label: 'by volume' },
    { order: 'createdAt', ascending: false, label: 'by newest' },
    { order: 'oneDayPriceChange', ascending: false, label: 'by price rise' },
    { order: 'oneDayPriceChange', ascending: true, label: 'by price drop' },
    { order: 'liquidityNum', ascending: false, label: 'by liquidity' },
  ];

  const allMarkets = [];
  for (const sort of sorts) {
    const url = `${GAMMA_API}/markets?active=true&closed=false&order=${sort.order}&ascending=${sort.ascending}&limit=200`;
    console.log(`  Fetching markets ${sort.label}...`);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const markets = await res.json();
        allMarkets.push(...markets);
        console.log(`    Got ${markets.length} markets`);
      }
    } catch (err) {
      console.error(`    Error: ${err.message}`);
    }
  }

  return allMarkets;
}

function extractTagsFromMarketData(markets) {
  // Markets may embed tag info in various fields
  const tagMap = new Map();

  for (const m of markets) {
    // Check for tags array on market objects
    const tags = m.tags || [];
    for (const tag of tags) {
      const label = tag.label || tag.name || tag;
      const id = tag.id || tag.tag_id || 'unknown';
      const slug = tag.slug || label.toLowerCase().replace(/\s+/g, '-');
      const key = String(id);
      if (!tagMap.has(key)) {
        tagMap.set(key, {
          id,
          label,
          slug,
          markets: [],
        });
      }
      tagMap.get(key).markets.push({
        question: m.question || m.title || 'N/A',
        volume24hr: m.volume24hr || 0,
      });
    }

    // Check for events[].tags
    if (m.events) {
      for (const evt of m.events) {
        for (const tag of (evt.tags || [])) {
          const label = tag.label || tag.name || tag;
          const id = tag.id || 'unknown';
          const slug = tag.slug || '';
          const key = String(id);
          if (!tagMap.has(key)) {
            tagMap.set(key, { id, label, slug, markets: [] });
          }
          tagMap.get(key).markets.push({
            question: m.question || m.title || 'N/A',
            volume24hr: m.volume24hr || 0,
          });
        }
      }
    }
  }

  return tagMap;
}

async function main() {
  console.log('=== Polymarket Tag Discovery ===\n');

  // Step 1: Fetch all tags from /tags endpoint
  const allTags = await fetchAllTags();

  // Filter to visible tags (not hidden)
  const visibleTags = allTags.filter(t => !t.forceHide);
  const carouselTags = allTags.filter(t => t.isCarousel);
  const forceShowTags = allTags.filter(t => t.forceShow);

  console.log(`\nVisible tags: ${visibleTags.length}`);
  console.log(`Carousel tags: ${carouselTags.length}`);
  console.log(`Force-show tags: ${forceShowTags.length}`);

  // Step 2: Fetch diverse markets and extract embedded tags
  console.log('\nFetching diverse markets to discover tag usage...');
  const diverseMarkets = await fetchDiverseMarkets();
  const marketTagMap = extractTagsFromMarketData(diverseMarkets);

  // Step 3: For the major categories, fetch events with tag_id
  const majorCategories = [
    { label: 'Politics', tagId: 2 },
    { label: 'Finance', tagId: 120 },
    { label: 'Crypto', tagId: 21 },
    { label: 'Sports', tagId: 100639 },
    { label: 'Tech', tagId: 1401 },
    { label: 'Culture', tagId: 596 },
    { label: 'Geopolitics', tagId: 100265 },
  ];

  console.log('\nFetching events for major categories...');
  for (const cat of majorCategories) {
    const events = await fetchMarketsByTag(cat.tagId, 5);
    console.log(`  ${cat.label} (tag_id=${cat.tagId}): ${events.length} sample events`);
    for (const evt of events.slice(0, 3)) {
      console.log(`    - "${evt.title || 'N/A'}"`);
    }
  }

  // Step 4: For tags your project uses (from config.js INTERESTING_TAGS),
  // try fetching by slug
  const projectTags = ['Politics', 'Elections', 'Science', 'AI', 'World', 'Economy'];
  console.log('\nFetching markets for project INTERESTING_TAGS...');
  for (const tagName of projectTags) {
    const slug = tagName.toLowerCase();
    const markets = await fetchMarketsWithTagSlug(slug, 10);
    console.log(`  "${tagName}" (slug: ${slug}): ${markets.length} markets`);
    for (const m of markets.slice(0, 3)) {
      console.log(`    - "${m.question || 'N/A'}"`);
    }
  }

  // Step 5: Print summary report
  console.log('\n\n=== TAG REPORT ===\n');

  // Print carousel/homepage tags first
  if (carouselTags.length > 0) {
    console.log('HOMEPAGE/CAROUSEL TAGS:');
    for (const t of carouselTags) {
      console.log(`  - ${t.label} (id: ${t.id}, slug: ${t.slug})`);
    }
    console.log('');
  }

  // Print force-show tags
  if (forceShowTags.length > 0) {
    console.log('FORCE-SHOW TAGS:');
    for (const t of forceShowTags) {
      console.log(`  - ${t.label} (id: ${t.id}, slug: ${t.slug})`);
    }
    console.log('');
  }

  // Print all visible tags, sorted alphabetically
  console.log(`ALL VISIBLE TAGS (${visibleTags.length} total):`);
  visibleTags
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
    .forEach(t => {
      console.log(`  ${t.id}\t${t.label}\t${t.slug}`);
    });

  // Print tags found from market data
  if (marketTagMap.size > 0) {
    console.log(`\nTAGS FOUND IN MARKET DATA (${marketTagMap.size} unique):`);
    const sorted = [...marketTagMap.values()].sort((a, b) => b.markets.length - a.markets.length);
    for (const tag of sorted) {
      console.log(`\n  ${tag.label} (id: ${tag.id}, slug: ${tag.slug}) - ${tag.markets.length} markets`);
      // Deduplicate and show top 3
      const seen = new Set();
      let shown = 0;
      for (const m of tag.markets) {
        if (!seen.has(m.question) && shown < 3) {
          console.log(`    - "${m.question}"`);
          seen.add(m.question);
          shown++;
        }
      }
    }
  }

  // Output JSON for further processing
  const outputPath = '/tmp/polymarket-tags.json';
  const fs = await import('fs');
  fs.writeFileSync(outputPath, JSON.stringify({
    totalTags: allTags.length,
    visibleTags: visibleTags.length,
    carouselTags: carouselTags.map(t => ({ id: t.id, label: t.label, slug: t.slug })),
    forceShowTags: forceShowTags.map(t => ({ id: t.id, label: t.label, slug: t.slug })),
    allVisibleTags: visibleTags.map(t => ({ id: t.id, label: t.label, slug: t.slug })),
    marketTagUsage: [...marketTagMap.entries()].map(([k, v]) => ({
      id: v.id, label: v.label, slug: v.slug, marketCount: v.markets.length,
      examples: [...new Set(v.markets.map(m => m.question))].slice(0, 3),
    })),
  }, null, 2));
  console.log(`\nFull tag data written to ${outputPath}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
