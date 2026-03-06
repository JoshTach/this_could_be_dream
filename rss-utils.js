/**
 * Shared RSS helpers for GamePulse (used by app.js and article.js without pulling in the main app).
 */

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = String(html);
  return (div.textContent || "").trim();
}

function clampText(s, maxLen) {
  const t = String(s ?? "").trim();
  if (maxLen <= 0 || t.length <= maxLen) return t;
  return t.slice(0, maxLen).trim().replace(/\s+\S*$/, "") + "…";
}

const CORS_PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?url=",
];

async function fetchFeedXml(url, { signal } = {}) {
  const apiUrl = `${window.location.origin}/api/feed?url=${encodeURIComponent(url)}`;
  try {
    const res = await fetch(apiUrl, { signal });
    if (res.ok) return await res.text();
  } catch {
    // Same-origin API not available (e.g. local dev without Vercel)
  }
  let lastError;
  for (const proxy of CORS_PROXIES) {
    try {
      const res = await fetch(proxy + encodeURIComponent(url), { signal });
      if (res.ok) return await res.text();
      lastError = new Error(`Fetch failed (${res.status})`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

function parseRssItems(xmlText, feedMeta) {
  const doc = new DOMParser().parseFromString(xmlText, "text/xml");

  const rssItems = Array.from(doc.querySelectorAll("item"));
  const atomEntries = Array.from(doc.querySelectorAll("entry"));

  if (rssItems.length === 0 && atomEntries.length === 0) {
    const parserError = doc.querySelector("parsererror");
    if (parserError) throw new Error("Invalid XML");
    return [];
  }

  const items = [];

  for (const it of rssItems) {
    const title = stripHtml(it.querySelector("title")?.textContent ?? "");
    const link = (it.querySelector("link")?.textContent ?? "").trim();
    const pubDateRaw = (it.querySelector("pubDate")?.textContent ?? "").trim();
    const dateMs = Date.parse(pubDateRaw);
    const desc = stripHtml(it.querySelector("description")?.textContent ?? "");
    const enclosure = it.querySelector("enclosure");
    const imageUrl = (enclosure?.getAttribute("url") ?? "").trim();

    if (!title || !link) continue;
    items.push({
      sourceId: feedMeta.id,
      sourceName: feedMeta.name,
      title,
      url: link,
      dateMs: Number.isNaN(dateMs) ? 0 : dateMs,
      excerpt: clampText(desc, 220),
      imageUrl: imageUrl || undefined,
    });
  }

  for (const it of atomEntries) {
    const title = stripHtml(it.querySelector("title")?.textContent ?? "");
    const linkEl = it.querySelector("link");
    const link =
      (linkEl?.getAttribute("href") ?? linkEl?.textContent ?? "").trim();
    const updatedRaw =
      (it.querySelector("updated")?.textContent ??
        it.querySelector("published")?.textContent ??
        "").trim();
    const dateMs = Date.parse(updatedRaw);
    const summary = stripHtml(it.querySelector("summary")?.textContent ?? "");
    const enclosure = it.querySelector("enclosure");
    const imageUrl = (enclosure?.getAttribute("url") ?? "").trim();

    if (!title || !link) continue;
    items.push({
      sourceId: feedMeta.id,
      sourceName: feedMeta.name,
      title,
      url: link,
      dateMs: Number.isNaN(dateMs) ? 0 : dateMs,
      excerpt: clampText(summary, 220),
      imageUrl: imageUrl || undefined,
    });
  }

  return items;
}

function chooseBestRssItem(items, keywords) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const ks = (keywords ?? []).map((k) => String(k).toLowerCase());
  let best = items[0];
  let bestScore = -1;
  for (const it of items) {
    const title = String(it?.title ?? "").toLowerCase();
    const excerpt = String(it?.excerpt ?? "").toLowerCase();
    const combined = `${title}\n${excerpt}`;
    let score = 0;
    for (const k of ks) {
      if (combined.includes(k)) score += 2;
    }
    if (title.includes("patch") || title.includes("update") || title.includes("notes")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

export { stripHtml, clampText, fetchFeedXml, parseRssItems, chooseBestRssItem };
