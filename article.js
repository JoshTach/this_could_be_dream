import { GAMES } from "./sources.js";
import { parseRssItems, chooseBestRssItem, fetchFeedXml } from "./rss-utils.js";

// Support ?game=id (preferred) or #game=id in case query is stripped
const search = window.location.search || (window.location.hash && window.location.hash.includes("=") ? "?" + window.location.hash.slice(1) : "");
const params = new URLSearchParams(search);
const gameId = params.get("game");

function stripHtml(html) {
  if (!html) return "";
  const div = document.createElement("div");
  div.innerHTML = String(html);
  return (div.textContent || "").trim();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isLikelyEnglish(text) {
  const t = String(text ?? "");
  if (!t.length) return true;
  if (/[\u0400-\u04FF]/.test(t)) return false;
  const latin = (t.match(/[a-zA-Z0-9\s.,'":;!?\-()]/g) || []).length;
  return latin / t.length >= 0.5;
}

function chooseBestSteamItem(items, keywords = []) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const ks = keywords.map((k) => String(k).toLowerCase());
  const english = items.filter((it) => {
    const title = String(it?.title ?? "");
    const content = stripHtml(String(it?.contents ?? ""));
    return isLikelyEnglish(title) && isLikelyEnglish(content);
  });
  const pool = english.length > 0 ? english : items;
  let best = pool[0];
  let bestScore = -1;
  for (const it of pool) {
    const title = String(it?.title ?? "").toLowerCase();
    const content = stripHtml(String(it?.contents ?? "")).toLowerCase();
    const combined = `${title}\n${content}`;
    let score = 0;
    for (const k of ks) if (combined.includes(k)) score += 2;
    if (title.includes("patch") || title.includes("update")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

function fmtDate(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const articlePageEl = document.getElementById("articlePage");
const heroEl = document.getElementById("articleHero");
const loadingEl = document.getElementById("articleLoading");
const errorEl = document.getElementById("articleError");
const contentEl = document.getElementById("articleContent");
const ogLink = document.getElementById("articleOgLink");
const metaEl = document.getElementById("articleMeta");
const titleEl = document.getElementById("articleTitle");
const summaryEl = document.getElementById("articleSummary");
const bodyEl = document.getElementById("articleBody");

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return "gp_summary_" + Math.abs(h).toString(36);
}

async function fetchAndShowSummary(content, gameName, title) {
  if (!summaryEl || !content) return;
  const cacheKey = simpleHash(content);
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.summary === "string") {
        summaryEl.innerHTML = `<span class="article__summary-label">At a glance</span><p class="article__summary-text">${escapeHtml(parsed.summary)}</p>`;
        summaryEl.hidden = false;
        return;
      }
    }
  } catch {}

  try {
    const r = await fetch(`${window.location.origin}/api/summarize-patch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 12000), gameName, title }),
    });
    if (!r.ok) return;
    const data = await r.json();
    const summary = data?.summary;
    if (!summary || typeof summary !== "string") return;
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ summary }));
    } catch {}
    summaryEl.innerHTML = `<span class="article__summary-label">At a glance</span><p class="article__summary-text">${escapeHtml(summary)}</p>`;
    summaryEl.hidden = false;
  } catch {
    // Summary optional; leave hidden on failure
  }
}

function setGameTheme(game) {
  if (!articlePageEl || !heroEl) return;
  const headerUrl = game.steamAppId
    ? `https://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`
    : null;
  if (headerUrl) {
    articlePageEl.classList.add("articlePage--themed");
    articlePageEl.style.setProperty("--article-bg", `url("${headerUrl}")`);
    heroEl.innerHTML = `<img src="${escapeHtml(headerUrl)}" alt="" />`;
    heroEl.hidden = false;
  } else {
    articlePageEl.classList.remove("articlePage--themed");
    articlePageEl.style.removeProperty("--article-bg");
    heroEl.innerHTML = "";
    heroEl.hidden = true;
  }
}

function showError(msg) {
  loadingEl.hidden = true;
  contentEl.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = msg;
  ogLink.hidden = true;
}

function showContent(game, item) {
  setGameTheme(game);
  loadingEl.hidden = true;
  errorEl.hidden = true;
  contentEl.hidden = false;
  ogLink.href = item.url || game.officialUrl || "#";
  ogLink.hidden = false;
  metaEl.textContent = `${item.source || "Steam News"} • ${fmtDate((Number(item.date) || 0) * 1000)}`;
  titleEl.textContent = item.title || "Patch notes";
  const body = stripHtml(String(item.contents ?? ""));
  if (!body.trim()) {
    bodyEl.innerHTML = "<p>No content available. Use the link above to read the original.</p>";
    return;
  }
  const rawBlocks = body.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const paragraphs = [];
  for (const block of rawBlocks) {
    if (/\bFixed\s+/i.test(block)) {
      const parts = block.split(/(?=Fixed\s+)/i).map((s) => s.trim()).filter(Boolean);
      paragraphs.push(...parts);
    } else {
      paragraphs.push(block);
    }
  }
  bodyEl.innerHTML = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  void fetchAndShowSummary(body, game.name, titleEl.textContent);
}

function showNonSteamPlaceholder(game) {
  setGameTheme(game);
  loadingEl.hidden = true;
  errorEl.hidden = true;
  contentEl.hidden = false;
  ogLink.href = game.officialUrl || "#";
  ogLink.textContent = "Visit official site →";
  ogLink.hidden = false;
  metaEl.textContent = game.name;
  titleEl.textContent = `${game.name} – news & updates`;
  bodyEl.innerHTML = "<p>Patch notes and updates for this game are not on Steam. Use the link above to check the official site.</p>";
}

function fmtDateFromMs(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

function showRssArticle(game, item) {
  setGameTheme(game);
  loadingEl.hidden = true;
  errorEl.hidden = true;
  contentEl.hidden = false;
  ogLink.href = item.url || game.officialUrl || "#";
  ogLink.textContent = "Read original →";
  ogLink.hidden = false;
  metaEl.textContent = `${item.sourceName ?? "Riot News"} • ${fmtDateFromMs(item.dateMs)}`;
  titleEl.textContent = item.title || "Patch notes";
  const excerpt = String(item.excerpt ?? "").trim();
  bodyEl.innerHTML = excerpt
    ? `<p>${escapeHtml(excerpt)}</p><p><a href="${escapeHtml(item.url || "#")}" rel="noopener">Read the full article on the official site →</a></p>`
    : "<p>No excerpt available. Use the link above to read the original.</p>";
  if (summaryEl) summaryEl.hidden = true;
}

async function loadArticle() {
  if (!gameId) {
    showError("Missing game. Open an article from the main page.");
    return;
  }

  const game = GAMES.find((g) => g.id === gameId);
  if (!game) {
    showError("Unknown game.");
    return;
  }

  if (!game.steamAppId) {
    if (game.rssUrl) {
      try {
        const xml = await fetchFeedXml(game.rssUrl);
        const items = parseRssItems(xml, { id: game.id, name: game.name });
        const chosen = chooseBestRssItem(items, game.keywords || ["patch", "update", "notes"]);
        if (chosen) {
          showRssArticle(game, chosen);
          return;
        }
      } catch {
        // Fall through to placeholder
      }
    }
    showNonSteamPlaceholder(game);
    return;
  }

  const maxlength = 5000;
  const apiUrl = `${window.location.origin}/api/steam-news?appid=${game.steamAppId}&l=english&maxlength=${maxlength}`;

  try {
    const res = await fetch(apiUrl);
    if (!res.ok) throw new Error(`API ${res.status}`);
    const json = await res.json();
    const items = json?.appnews?.newsitems ?? [];
    const chosen = chooseBestSteamItem(items, game.keywords || ["patch", "update"]);
    if (!chosen) {
      showError("No patch notes found for this game.");
      return;
    }
    showContent(game, chosen);
  } catch (e) {
    showError("Couldn’t load the article. Try again or use the main page.");
  }
}

loadArticle();
