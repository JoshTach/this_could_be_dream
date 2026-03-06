/**
 * Vercel serverless: fetch Steam news for an app (no CORS, so more reliable than public proxy).
 * GET /api/steam-news?appid=570
 * When the site is deployed here, the frontend uses this instead of the public CORS proxy.
 */

const STEAM_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/";
const COUNT = 12;
const MAX_LENGTH = 400;
const LANG = "english";

async function fetchSteam(appid, lang = LANG, maxlength = MAX_LENGTH) {
  const url = `${STEAM_URL}?appid=${appid}&count=${COUNT}&maxlength=${maxlength}&format=json&l=${encodeURIComponent(lang)}`;
  const r = await fetch(url, {
    headers: { "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!r.ok) throw new Error(`Steam API ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const appid = req.query.appid;
  const lang = (req.query.l && String(req.query.l).trim()) || LANG;
  const maxlength = Math.min(Number(req.query.maxlength) || MAX_LENGTH, 10000);
  if (!appid || !/^\d+$/.test(String(appid))) {
    return res.status(400).json({ error: "Missing or invalid appid" });
  }
  try {
    let json = await fetchSteam(appid, lang, maxlength);
    return res.status(200).json(json);
  } catch (e) {
    try {
      await new Promise((r) => setTimeout(r, 500));
      const json = await fetchSteam(appid, lang, maxlength);
      return res.status(200).json(json);
    } catch (e2) {
      return res.status(502).json({ error: (e2 && e2.message) || "Upstream error" });
    }
  }
}
