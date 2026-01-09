// Vercel Serverless Function to proxy Polymarket API
// This bypasses CORS restrictions by fetching server-side

export default async function handler(req, res) {
  // Set CORS headers to allow browser access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    // Handle preflight request
    res.status(200).end();
    return;
  }

  try {
    // Fetch from Polymarket Gamma API (server-side, no CORS issue)
    // Fetch 500 events to get better coverage of high-movement markets
    const response = await fetch(
      'https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500',
      {
        headers: {
          'Accept': 'application/json',
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Polymarket API returned ${response.status}`);
    }

    const data = await response.json();

    // Return data to browser
    res.status(200).json(data);

  } catch (error) {
    console.error('API proxy error:', error);
    res.status(500).json({
      error: 'Failed to fetch markets',
      message: error.message
    });
  }
}
