/**
 * Vercel serverless: proxy RSS/Atom feeds so the frontend doesn't hit CORS.
 * GET /api/feed?url=https%3A%2F%2Fwww.eurogamer.net%2Ffeed
 * Only allows known feed hosts.
 */

const ALLOWED_HOSTS = [
  "www.pcgamer.com",
  "pcgamer.com",
  "www.polygon.com",
  "polygon.com",
  "feeds.feedburner.com",
  "www.eurogamer.net",
  "eurogamer.net",
  "data.rito.news",
];

function isAllowedUrl(urlString) {
  try {
    const u = new URL(urlString);
    return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "Missing url" });
  }

  let feedUrl;
  try {
    feedUrl = decodeURIComponent(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  if (!isAllowedUrl(feedUrl)) {
    return res.status(400).json({ error: "URL not allowed" });
  }

  try {
    const r = await fetch(feedUrl, {
      headers: { "User-Agent": "GamePulse/1.0 (RSS reader)" },
    });
    if (!r.ok) {
      return res.status(r.status).send(r.statusText);
    }
    const xml = await r.text();
    res.setHeader("Content-Type", r.headers.get("Content-Type") || "application/xml");
    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
    return res.status(200).send(xml);
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "Upstream error" });
  }
}
