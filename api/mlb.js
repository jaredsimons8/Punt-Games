// api/mlb.js — Vercel Serverless Function
// Proxies requests to statsapi.mlb.com to bypass browser CORS restrictions.
//
// Called from frontend as:
//   /api/mlb?path=/schedule%3FsportId%3D1%26date%3D2026-03-26
// The 'path' param is the MLB API path AFTER /api/v1, URL-encoded.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Get the raw URL to extract everything after ?path=
  const rawUrl = req.url || '';
  const pathIndex = rawUrl.indexOf('?path=');

  if (pathIndex === -1) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  // Decode the path — e.g. /schedule?sportId=1&date=2026-03-26
  const encodedPath = rawUrl.slice(pathIndex + 6);
  const mlbPath = decodeURIComponent(encodedPath);

  // Build full MLB URL
  const mlbUrl = `https://statsapi.mlb.com/api/v1${mlbPath}`;

  try {
    const response = await fetch(mlbUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MLBPuntGames/1.0)',
        'Accept': 'application/json',
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `MLB API returned ${response.status}`,
        detail: text.slice(0, 300),
        url: mlbUrl,
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: 'MLB API returned non-JSON', detail: text.slice(0, 300) });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({
      error: 'Failed to reach MLB API',
      detail: err.message,
      url: mlbUrl,
    });
  }
}
