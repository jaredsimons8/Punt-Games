// api/mlb.js — Vercel Serverless Function
// Proxies all requests to statsapi.mlb.com, bypassing browser CORS restrictions.
// Called from the frontend as: /api/mlb?path=/schedule?sportId=1&date=...

export default async function handler(req, res) {
  // Allow requests from any origin (your site's own domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract the MLB API path from query string
  // e.g. /api/mlb?path=/schedule%3FsportId%3D1%26date%3D2026-03-26
  const { path } = req.query;

  if (!path) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const mlbUrl = `https://statsapi.mlb.com/api/v1${path}`;

  try {
    const response = await fetch(mlbUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PuntGameTracker/1.0)',
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `MLB API returned ${response.status}`,
        url: mlbUrl,
      });
    }

    const data = await response.json();

    // Cache responses for 5 minutes to avoid hammering the MLB API
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    console.error('MLB proxy error:', err);
    return res.status(500).json({
      error: 'Failed to reach MLB API',
      detail: err.message,
      url: mlbUrl,
    });
  }
}
