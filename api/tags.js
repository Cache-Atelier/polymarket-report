// Diagnostic endpoint: discover Gamma API tags and test different fetch strategies
// Hit /api/tags to see what's available, then use findings to curate INTERESTING_TAGS

const GAMMA_API = 'https://gamma-api.polymarket.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const results = {};

  // 1. Test the /tags endpoint — get carousel/homepage tags
  try {
    const tagRes = await fetch(`${GAMMA_API}/tags?limit=100&offset=0`);
    const tags = tagRes.ok ? await tagRes.json() : [];
    const carousel = tags.filter(t => t.isCarousel);
    const forceShow = tags.filter(t => t.forceShow && !t.forceHide);
    results.tagsEndpoint = {
      status: tagRes.status,
      totalFirstPage: tags.length,
      carousel: carousel.map(t => ({ id: t.id, label: t.label, slug: t.slug })),
      forceShow: forceShow.map(t => ({ id: t.id, label: t.label, slug: t.slug })),
      first20: tags.slice(0, 20).map(t => ({ id: t.id, label: t.label, slug: t.slug, isCarousel: t.isCarousel, forceShow: t.forceShow })),
    };
  } catch (err) {
    results.tagsEndpoint = { error: err.message };
  }

  // 2. Test featured=true on events
  try {
    const featRes = await fetch(`${GAMMA_API}/events?featured=true&active=true&closed=false&limit=20`);
    const events = featRes.ok ? await featRes.json() : [];
    results.featuredEvents = {
      status: featRes.status,
      count: events.length,
      events: events.slice(0, 10).map(e => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        volume24hr: e.volume24hr,
        featured: e.featured,
        featuredOrder: e.featuredOrder,
        tags: (e.tags || []).map(t => t.label || t),
        marketCount: (e.markets || []).length,
      })),
    };
  } catch (err) {
    results.featuredEvents = { error: err.message };
  }

  // 3. Test tag_id-based event fetching for known categories
  const categories = [
    { label: 'Politics', tagId: 2 },
    { label: 'Finance', tagId: 120 },
    { label: 'Crypto', tagId: 21 },
    { label: 'Sports', tagId: 100639 },
    { label: 'Tech', tagId: 1401 },
    { label: 'Culture', tagId: 596 },
    { label: 'Geopolitics', tagId: 100265 },
  ];

  results.tagIdEvents = {};
  for (const cat of categories) {
    try {
      const r = await fetch(`${GAMMA_API}/events?tag_id=${cat.tagId}&active=true&closed=false&order=volume24hr&ascending=false&limit=5`);
      const events = r.ok ? await r.json() : [];
      results.tagIdEvents[cat.label] = {
        status: r.status,
        tagId: cat.tagId,
        count: events.length,
        examples: events.slice(0, 3).map(e => e.title || 'N/A'),
      };
    } catch (err) {
      results.tagIdEvents[cat.label] = { error: err.message };
    }
  }

  // 4. Test tag slug-based market fetching (what we currently use)
  const slugTests = ['Politics', 'politics', 'Elections', 'elections', 'AI', 'ai', 'Science', 'Economy', 'World'];
  results.tagSlugMarkets = {};
  for (const slug of slugTests) {
    try {
      const r = await fetch(`${GAMMA_API}/markets?tag=${encodeURIComponent(slug)}&active=true&closed=false&limit=5&order=volume24hr&ascending=false`);
      const markets = r.ok ? await r.json() : [];
      results.tagSlugMarkets[slug] = {
        status: r.status,
        count: markets.length,
        examples: markets.slice(0, 3).map(m => ({
          question: (m.question || '').substring(0, 80),
          volume24hr: m.volume24hr,
          oneDayPriceChange: m.oneDayPriceChange,
        })),
      };
    } catch (err) {
      results.tagSlugMarkets[slug] = { error: err.message };
    }
  }

  // 5. Test exclude_tag_id (exclude sports + crypto from volume leaders)
  try {
    const exclUrl = `${GAMMA_API}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=10&exclude_tag_id=100639&exclude_tag_id=21`;
    const r = await fetch(exclUrl);
    const events = r.ok ? await r.json() : [];
    results.excludeTagTest = {
      status: r.status,
      url: exclUrl,
      count: events.length,
      events: events.slice(0, 10).map(e => ({
        title: e.title,
        volume24hr: e.volume24hr,
        tags: (e.tags || []).map(t => t.label || t),
      })),
    };
  } catch (err) {
    results.excludeTagTest = { error: err.message };
  }

  // 6. Test fetching markets by tag_id (not events)
  results.tagIdMarkets = {};
  for (const cat of [{ label: 'Politics', tagId: 2 }, { label: 'Tech', tagId: 1401 }, { label: 'Geopolitics', tagId: 100265 }]) {
    try {
      const r = await fetch(`${GAMMA_API}/markets?tag_id=${cat.tagId}&active=true&closed=false&order=volume24hr&ascending=false&limit=5`);
      const markets = r.ok ? await r.json() : [];
      results.tagIdMarkets[cat.label] = {
        status: r.status,
        count: markets.length,
        examples: markets.slice(0, 3).map(m => ({
          question: (m.question || '').substring(0, 80),
          volume24hr: m.volume24hr,
        })),
      };
    } catch (err) {
      results.tagIdMarkets[cat.label] = { error: err.message };
    }
  }

  res.status(200).json(results);
}
