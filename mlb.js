// api/mlb.js — Vercel Serverless Function (CommonJS)
// Proxies MLB Stats API requests to bypass browser CORS restrictions.
// Usage: /api/mlb?path=/schedule%3FsportId%3D1%26date%3D2026-04-01

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const pathParam = req.query?.path;
  if (!pathParam) {
    return res.status(400).json({ error: 'Missing path parameter' });
  }

  const mlbUrl = `https://statsapi.mlb.com/api/v1${pathParam}`;

  try {
    const response = await fetch(mlbUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ThePuntIndex/1.0)',
        'Accept': 'application/json',
      },
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `MLB API ${response.status}`,
        detail: text.slice(0, 300),
        url: mlbUrl,
      });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ error: 'Non-JSON response', detail: text.slice(0, 200) }); }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=30');
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: 'Proxy error', detail: err.message, url: mlbUrl });
  }
};
