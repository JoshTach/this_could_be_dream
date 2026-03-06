import { GAMES } from "./sources.js";

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
const bodyEl = document.getElementById("articleBody");

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
  bodyEl.innerHTML = body
    ? body
        .split(/\n\n+/)
        .map((p) => `<p>${escapeHtml(p.trim())}</p>`)
        .join("")
    : "<p>No content available. Use the link above to read the original.</p>";
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
