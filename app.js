import { GAMES, NEWS_FEEDS } from "./sources.js";
import { parseRssItems, chooseBestRssItem, fetchFeedXml } from "./rss-utils.js";

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours – reduces load on Steam; stale fallback covers failures
const MAX_NEWS_ITEMS = 30;
const MAX_FEED_ITEMS_PER_SOURCE = 8;
const STEAM_COUNT = 8;

// CORS proxies (tried in order if one fails – public proxies can be down or rate-limited)
const CORS_PROXIES = [
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?url=",
];
let corsProxyIndex = 0;

// --- Supabase config (your project values) ---
// These are public in the browser; keep database rules locked down with RLS.
const SUPABASE_URL = "https://yajktqxbxytbnxzavago.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlhamt0cXhieHl0Ym54emF2YWdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4MTk1MzEsImV4cCI6MjA4ODM5NTUzMX0.ZWWuT5qQTao4q_8latW1WQrDmS4z6o6EjCW07oCIudg";

let supabaseClient = null;
let supabaseTablesOk = true; // set false after 404 so we stop spamming failed requests
if (
  typeof window !== "undefined" &&
  window.supabase &&
  SUPABASE_URL.startsWith("https://") &&
  Boolean(SUPABASE_ANON_KEY)
) {
  supabaseClient = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
  );
}

const $ = (sel) => document.querySelector(sel);

const gamesGrid = $("#gamesGrid");
const newsList = $("#newsList");
const statusText = $("#statusText");
const lastUpdatedText = $("#lastUpdatedText");
const gameSearch = $("#gameSearch");
const clearSearchBtn = $("#clearSearchBtn");
const authContainer = $("#authContainer");

function nowMs() {
  return Date.now();
}

function fmtDate(msOrDateLike) {
  const d = msOrDateLike instanceof Date ? msOrDateLike : new Date(msOrDateLike);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function stripHtml(input) {
  const div = document.createElement("div");
  div.innerHTML = input ?? "";
  return (div.textContent || "").trim();
}

function clampText(s, max) {
  const t = (s ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

function setStatus(msg) {
  statusText.textContent = msg;
}

function setLastUpdated(ts) {
  const d = new Date(ts);
  lastUpdatedText.textContent = Number.isNaN(d.getTime())
    ? ""
    : `Last updated: ${d.toLocaleTimeString()}`;
}

function cacheGet(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.ts !== "number") return null;
    if (nowMs() - parsed.ts > CACHE_TTL_MS) return null;
    return parsed.data ?? null;
  } catch {
    return null;
  }
}

/** Returns last known data even if expired – use when fetch fails so we never show error if we have any prior good data. */
function cacheGetStale(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed.data ?? null;
    if (!data || typeof data !== "object" || !data.title || !data.url) return null;
    return data;
  } catch {
    return null;
  }
}

function cacheSet(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: nowMs(), data }));
  } catch {
    // ignore storage errors (private mode, quota, etc)
  }
}

async function fetchViaProxy(url, { signal } = {}) {
  let lastError;
  for (let i = 0; i < CORS_PROXIES.length; i++) {
    const proxy = CORS_PROXIES[(corsProxyIndex + i) % CORS_PROXIES.length];
    const proxied = `${proxy}${encodeURIComponent(url)}`;
    try {
      const res = await fetch(proxied, { signal });
      if (res.ok) {
        if (i > 0) corsProxyIndex = (corsProxyIndex + i) % CORS_PROXIES.length;
        return await res.text();
      }
      lastError = new Error(`Fetch failed (${res.status})`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

async function fetchJsonViaProxy(url, { signal } = {}) {
  const txt = await fetchViaProxy(url, { signal });
  try {
    return JSON.parse(txt);
  } catch {
    throw new Error("Invalid JSON response");
  }
}

function pLimit(concurrency) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= concurrency) return;
    const item = queue.shift();
    if (!item) return;
    active += 1;
    item()
      .catch(() => {})
      .finally(() => {
        active -= 1;
        next();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push(async () => {
        try {
          resolve(await fn());
        } catch (e) {
          reject(e);
        }
      });
      next();
    });
}

const STEAM_LANG = "english"; // request English so users see native language (Steam store uses l=english)

function steamNewsUrl(appId) {
  const u = new URL("https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/");
  u.searchParams.set("appid", String(appId));
  u.searchParams.set("count", String(STEAM_COUNT));
  u.searchParams.set("maxlength", "380");
  u.searchParams.set("format", "json");
  u.searchParams.set("l", STEAM_LANG);
  return u.toString();
}

/** True if text is mostly Latin/ASCII (e.g. English); used to prefer native-language news. */
function isLikelyEnglish(text) {
  const t = String(text ?? "");
  if (!t.length) return true;
  const cyrillic = /[\u0400-\u04FF]/;
  if (cyrillic.test(t)) return false;
  const latinOrAscii = (t.match(/[a-zA-Z0-9\s.,'":;!?\-()]/g) || []).length;
  return latinOrAscii / t.length >= 0.5;
}

function chooseBestSteamItem(items, keywords) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const ks = (keywords ?? []).map((k) => k.toLowerCase());

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
    for (const k of ks) {
      if (combined.includes(k)) score += 2;
    }
    if (title.includes("patch") || title.includes("update")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  return best;
}

let steamApiAvailable = true; // set false after 404 so we don't spam same-origin API

async function fetchSteamNews(appId, { signal } = {}) {
  if (steamApiAvailable) {
    const apiUrl = `${window.location.origin}/api/steam-news?appid=${appId}&l=${encodeURIComponent(STEAM_LANG)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(apiUrl, { signal });
        if (res.ok) return await res.json();
        if (res.status === 404) {
          steamApiAvailable = false;
          break;
        }
      } catch {
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
    }
  }
  return fetchJsonViaProxy(steamNewsUrl(appId), { signal });
}

const CACHE_VERSION = "en1"; // bump when language or feed logic changes so old cache is dropped

async function getLatestGameUpdate(game, { forceRefresh, signal } = {}) {
  const cacheKey = game.steamAppId
    ? `cache:steam:${CACHE_VERSION}:${game.steamAppId}`
    : `cache:game:${game.id}`;

  if (!game.steamAppId) {
    if (!forceRefresh) {
      const cached = cacheGet(cacheKey);
      if (cached) return cached;
    }
    if (game.rssUrl) {
      try {
        const xml = await fetchFeedXml(game.rssUrl, { signal });
        const items = parseRssItems(xml, { id: game.id, name: game.name });
        const chosen = chooseBestRssItem(items, game.keywords);
        if (chosen) {
          const data = {
            source: chosen.sourceName ?? "Riot News",
            title: String(chosen.title ?? "Untitled"),
            url: String(chosen.url ?? game.officialUrl ?? "#"),
            dateMs: Number(chosen.dateMs) || 0,
            excerpt: clampText(String(chosen.excerpt ?? ""), 220),
          };
          cacheSet(cacheKey, data);
          return data;
        }
      } catch (e) {
        const stale = cacheGetStale(cacheKey);
        if (stale) return stale;
        throw e;
      }
    }
    const data = {
      source: "Official site",
      title: `${game.name} – news & updates`,
      url: String(game.officialUrl ?? "#"),
      dateMs: 0,
      excerpt: "Visit the official site for the latest patches and news.",
    };
    cacheSet(cacheKey, data);
    return data;
  }

  if (!forceRefresh) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let json;
  try {
    json = await fetchSteamNews(game.steamAppId, { signal });
  } catch (e) {
    try {
      await new Promise((r) => setTimeout(r, 800));
      json = await fetchSteamNews(game.steamAppId, { signal });
    } catch {
      const stale = cacheGetStale(cacheKey);
      if (stale) return stale;
      throw e;
    }
  }

  const items = json?.appnews?.newsitems ?? [];
  const chosen = chooseBestSteamItem(items, game.keywords);
  if (!chosen) {
    const stale = cacheGetStale(cacheKey);
    if (stale) return stale;
    throw new Error("No news items returned");
  }

  const data = {
    source: "Steam News",
    title: String(chosen.title ?? "Untitled"),
    url: String(chosen.url ?? game.officialUrl ?? ""),
    dateMs: (Number(chosen.date) || 0) * 1000,
    excerpt: clampText(stripHtml(String(chosen.contents ?? "")), 220),
  };

  cacheSet(cacheKey, data);
  return data;
}

async function fetchFeed(feed, { forceRefresh, signal } = {}) {
  const cacheKey = `cache:rss:${feed.url}`;
  if (!forceRefresh) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  let xml;
  const apiUrl = `${window.location.origin}/api/feed?url=${encodeURIComponent(feed.url)}`;
  try {
    const res = await fetch(apiUrl, { signal });
    if (res.ok) xml = await res.text();
  } catch {
    // Same-origin API not available (e.g. local dev without Vercel)
  }
  if (!xml) xml = await fetchViaProxy(feed.url, { signal });

  const items = parseRssItems(xml, feed)
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
    .slice(0, MAX_FEED_ITEMS_PER_SOURCE);

  cacheSet(cacheKey, items);
  return items;
}

function renderGameCard(game, update, { error, subscribed, currentUser } = {}) {
  const el = document.createElement("article");
  el.className = "card";
  el.dataset.gameId = game.id;
  el.dataset.gameName = game.name.toLowerCase();

  const bgUrl =
    game.splashUrl ||
    (game.steamAppId
      ? `http://cdn.akamai.steamstatic.com/steam/apps/${game.steamAppId}/header.jpg`
      : null);
  if (bgUrl) {
    el.classList.add("card--has-bg");
    el.style.setProperty("--card-bg-image", `url("${bgUrl}")`);
  }

  const pillClass = error ? "pill pill--bad" : "pill pill--good";
  const pillText = error ? "Unavailable" : "Latest";
  const titleText = error ? "Couldn’t load update" : update.title;
  const dateText = error ? "" : fmtDate(update.dateMs);
  const articleUrl = `/article.html?game=${encodeURIComponent(game.id)}`;
  const source = error ? "Check official site" : update.source;
  const excerpt = error
    ? "This can happen if a source blocks the public proxy. You can still click through to the official site."
    : update.excerpt;

  const showSubscribe = Boolean(currentUser && !error);
  const subLabel = subscribed ? "Subscribed" : "Subscribe";
  const subBtnClass = subscribed ? "btn btn--ghost btn--sm btn--subscribed" : "btn btn--sm btn--subscribe";

  el.innerHTML = `
    <a class="card__clickable" href="${escapeAttr(articleUrl)}" aria-label="${escapeAttr(game.name)}: ${escapeAttr(titleText)}"></a>
    <div class="card__top">
      <div>
        <div class="card__title">${escapeHtml(game.name)}</div>
        <div class="card__meta">
          <span>${escapeHtml(source)}</span>
          ${dateText ? `<span>•</span><span>${escapeHtml(dateText)}</span>` : ""}
        </div>
      </div>
      <div class="card__badges">
        ${showSubscribe ? `<button type="button" class="${subBtnClass}" data-game-id="${escapeAttr(game.id)}" data-game-name="${escapeAttr(game.name)}">${escapeHtml(subLabel)}</button>` : ""}
        <span class="${pillClass}">${escapeHtml(pillText)}</span>
      </div>
    </div>
    <div class="card__headline">${escapeHtml(titleText)}</div>
    <div class="card__body">${escapeHtml(excerpt)}</div>
  `;

  if (showSubscribe) {
    const btn = el.querySelector(".btn--subscribe, .btn--subscribed");
    if (btn) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        if (subscribed) void unsubscribeGame(game.id, el);
        else void subscribeGame(game.id, game.name, el);
      });
    }
  }

  return el;
}

function renderNewsItem(item) {
  const el = document.createElement("div");
  el.className = "newsItem";
  el.innerHTML = `
    <div class="newsItem__top">
      <a class="newsItem__title" href="${escapeAttr(item.url)}" target="_blank" rel="noreferrer">
        ${escapeHtml(item.title)}
      </a>
      <div class="newsItem__meta">${escapeHtml(item.sourceName)} • ${escapeHtml(
    fmtDate(item.dateMs)
  )}</div>
    </div>
    ${
      item.excerpt
        ? `<div class="card__body">${escapeHtml(item.excerpt)}</div>`
        : ""
    }
  `;
  return el;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(s) {
  return escapeHtml(s).replaceAll("`", "&#096;");
}

// --- Subscriptions (DM notifications) ---
let currentAuthUser = null;
let subscribedGameIds = new Set();

async function fetchSubscriptions() {
  if (!supabaseClient || !currentAuthUser?.id || !supabaseTablesOk) {
    subscribedGameIds = new Set();
    return;
  }
  try {
    const { data } = await supabaseClient
      .from("subscriptions")
      .select("game_id")
      .eq("user_id", currentAuthUser.id);
    subscribedGameIds = new Set((data ?? []).map((r) => r.game_id));
  } catch {
    subscribedGameIds = new Set();
    supabaseTablesOk = false;
  }
}

async function subscribeGame(gameId, gameName, cardEl) {
  if (!supabaseClient || !currentAuthUser?.id || !supabaseTablesOk) return;
  const btn = cardEl?.querySelector(".btn--subscribe, .btn--subscribed");
  if (btn) btn.disabled = true;
  try {
    await supabaseClient.from("subscriptions").insert({ user_id: currentAuthUser.id, game_id: gameId });
    subscribedGameIds.add(gameId);
    if (btn) {
      btn.textContent = "Subscribed";
      btn.classList.remove("btn--subscribe");
      btn.classList.add("btn--subscribed", "btn--ghost");
    }
  } catch {
    supabaseTablesOk = false;
  }
  if (btn) btn.disabled = false;
}

async function unsubscribeGame(gameId, cardEl) {
  if (!supabaseClient || !currentAuthUser?.id || !supabaseTablesOk) return;
  const btn = cardEl?.querySelector(".btn--subscribe, .btn--subscribed");
  if (btn) btn.disabled = true;
  try {
    await supabaseClient.from("subscriptions").delete().eq("user_id", currentAuthUser.id).eq("game_id", gameId);
    subscribedGameIds.delete(gameId);
    if (btn) {
      btn.textContent = "Subscribe";
      btn.classList.remove("btn--subscribed", "btn--ghost");
      btn.classList.add("btn--subscribe");
    }
  } catch {
    supabaseTablesOk = false;
  }
  if (btn) btn.disabled = false;
}

function applySearchFilter() {
  const q = (gameSearch.value ?? "").trim().toLowerCase();
  const cards = gamesGrid.querySelectorAll(".card");
  let shown = 0;
  for (const card of cards) {
    const name = card.dataset.gameName ?? "";
    const match = !q || name.includes(q);
    card.style.display = match ? "" : "none";
    if (match) shown += 1;
  }
  const total = cards.length;
  if (total > 0) {
    setStatus(q ? `Showing ${shown}/${total} games` : `Showing ${total} games`);
  }
}

async function logVisit() {
  if (!supabaseClient || !supabaseTablesOk) return;
  try {
    const { error } = await supabaseClient.from("visits").insert({
      path: window.location.pathname,
      created_at: new Date().toISOString(),
    });
    if (error) supabaseTablesOk = false;
  } catch {
    supabaseTablesOk = false;
  }
}

// --- Discord auth (Supabase Auth) ---
function getDisplayName(user) {
  const m = user?.user_metadata ?? {};
  return m.full_name ?? m.name ?? m.user_name ?? user?.email ?? "Player";
}

function getAvatarUrl(user) {
  const m = user?.user_metadata ?? {};
  let url = m.avatar_url ?? m.picture;
  if (url && url.startsWith("https://cdn.discordapp.com/") && !url.includes("?")) {
    url += "?size=64";
  }
  return url || null;
}

function getDiscordId(user) {
  const discordIdentity = user?.identities?.find((i) => i.provider === "discord");
  if (discordIdentity?.id) return String(discordIdentity.id);
  const m = user?.user_metadata ?? {};
  const id = m.provider_id ?? m.sub ?? m.id;
  return id ? String(id) : null;
}

function updateAuthUI(user) {
  if (!authContainer) return;
  if (user) {
    const name = escapeHtml(getDisplayName(user));
    const avatarUrl = getAvatarUrl(user);
    const avatarHtml = avatarUrl
      ? `<img class="auth-user__avatar" src="${escapeAttr(avatarUrl)}" alt="" width="28" height="28" />`
      : `<span class="auth-user__avatar auth-user__avatar--fallback">${escapeHtml(String(name).slice(0, 1).toUpperCase())}</span>`;
    authContainer.innerHTML = `
      <div class="auth-user-wrap">
        <div class="auth-user">
          ${avatarHtml}
          <span class="auth-user__name">${name}</span>
          <button id="testNotifyBtn" class="btn btn--ghost btn--sm" type="button" title="Send a test notification to your Discord">Test DM</button>
          <button id="signOutBtn" class="btn btn--ghost btn--sm" type="button">Sign out</button>
        </div>
        <span id="testNotifyStatus" class="auth-test-status" aria-live="polite" hidden></span>
      </div>`;
    const signOutBtn = document.getElementById("signOutBtn");
    if (signOutBtn) signOutBtn.addEventListener("click", handleSignOut);
    const testNotifyBtn = document.getElementById("testNotifyBtn");
    if (testNotifyBtn) testNotifyBtn.addEventListener("click", handleTestNotify);
  } else {
    authContainer.innerHTML = `
      <button id="discordSignInBtn" class="btn btn--discord" type="button">
        <svg class="btn__discord-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C2.504 6.898 2.03 9.41 2.03 11.917c0 2.507.475 5.02 1.617 7.52a.076.076 0 0 0 .032.028 19.9 19.9 0 0 0 5.993 3.03.077.077 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 18.41 18.41 0 0 1-2.609-1.257.075.075 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.075.075 0 0 1-.006.127 18.36 18.36 0 0 1-2.61 1.257.076.076 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.9 19.9 0 0 0 6.002-3.03.075.075 0 0 0 .032-.028c1.142-2.5 1.617-5.012 1.617-7.52 0-2.507-.475-5.02-1.617-7.52a.076.076 0 0 0-.032-.027zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
        Sign in with Discord
      </button>`;
    const discordBtn = document.getElementById("discordSignInBtn");
    if (discordBtn) discordBtn.addEventListener("click", handleLoginWithDiscord);
  }
}

async function handleLoginWithDiscord() {
  if (!supabaseClient) return;
  try {
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "discord",
      options: {
        redirectTo: window.location.origin + window.location.pathname,
      },
    });
    if (error) console.error("Discord sign-in error:", error);
  } catch (e) {
    console.error("Discord sign-in error:", e);
  }
}

async function handleSignOut() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
}

async function handleTestNotify() {
  const btn = document.getElementById("testNotifyBtn");
  const statusEl = document.getElementById("testNotifyStatus");
  if (!supabaseClient || !btn) return;
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session?.access_token) {
    if (statusEl) {
      statusEl.textContent = "Sign in with Discord first.";
      statusEl.hidden = false;
      statusEl.classList.remove("auth-test-status--ok");
      statusEl.classList.add("auth-test-status--err");
    }
    return;
  }
  btn.disabled = true;
  if (statusEl) {
    statusEl.textContent = "Sending…";
    statusEl.hidden = false;
    statusEl.classList.remove("auth-test-status--ok", "auth-test-status--err");
  }
  try {
    const res = await fetch(`${window.location.origin}/api/test-notify`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (statusEl) {
      statusEl.hidden = false;
      if (res.ok) {
        statusEl.textContent = "Test DM sent. Check Discord.";
        statusEl.classList.add("auth-test-status--ok");
        statusEl.classList.remove("auth-test-status--err");
      } else {
        statusEl.textContent = data?.error || `Failed (${res.status})`;
        statusEl.classList.add("auth-test-status--err");
        statusEl.classList.remove("auth-test-status--ok");
      }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = "Network error. Try again.";
      statusEl.hidden = false;
      statusEl.classList.add("auth-test-status--err");
      statusEl.classList.remove("auth-test-status--ok");
    }
  }
  btn.disabled = false;
}

async function upsertProfile(user) {
  if (!supabaseClient || !user?.id || !supabaseTablesOk) return;
  const username = getDisplayName(user);
  const avatar_url = getAvatarUrl(user);
  const discord_id = getDiscordId(user);
  try {
    await supabaseClient.from("profiles").upsert(
      {
        id: user.id,
        username,
        avatar_url,
        discord_id: discord_id ?? undefined,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" }
    );
  } catch {
    supabaseTablesOk = false;
  }
}

function initAuth() {
  if (!supabaseClient || !authContainer) return;
  supabaseClient.auth.getSession().then(({ data: { session } }) => {
    currentAuthUser = session?.user ?? null;
    updateAuthUI(currentAuthUser);
    if (session?.user) void upsertProfile(session.user);
    void fetchSubscriptions();
  });
  supabaseClient.auth.onAuthStateChange((event, session) => {
    const user = session?.user ?? null;
    currentAuthUser = user;
    updateAuthUI(user);
    if (event === "SIGNED_IN" && user) void upsertProfile(user);
    if (event === "INITIAL_SESSION" && user) void upsertProfile(user);
    void fetchSubscriptions();
  });
}

async function loadAll() {
  const controller = new AbortController();
  const { signal } = controller;
  const limiter = pLimit(4);

  // Show cached data immediately (don't wait for auth – avoids failures after Discord redirect)
  const cachedGameResults = [];
  for (const g of GAMES) {
    const cacheKey = g.steamAppId ? `cache:steam:${CACHE_VERSION}:${g.steamAppId}` : `cache:game:${g.id}`;
    const cached = cacheGet(cacheKey) || cacheGetStale(cacheKey);
    if (cached) {
      cachedGameResults.push({ game: g, update: cached });
    } else {
      cachedGameResults.push({ game: g, error: true });
    }
  }
  const cachedNewsByFeed = [];
  for (const f of NEWS_FEEDS) {
    const cached = cacheGet(`cache:rss:${f.url}`);
    cachedNewsByFeed.push(Array.isArray(cached) ? cached : []);
  }
  const cachedMerged = cachedNewsByFeed
    .flat()
    .filter((x) => x && x.title && x.url)
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
    .slice(0, MAX_NEWS_ITEMS);

  const hasAnyCache = cachedGameResults.some((r) => !r.error) || cachedMerged.length > 0;
  if (hasAnyCache) {
    gamesGrid.innerHTML = "";
    newsList.innerHTML = "";
    for (const r of cachedGameResults) {
      const subscribed = subscribedGameIds.has(r.game.id);
      const card = r.error
        ? renderGameCard(r.game, null, { error: true, currentUser: currentAuthUser })
        : renderGameCard(r.game, r.update, { subscribed, currentUser: currentAuthUser });
      gamesGrid.appendChild(card);
    }
    if (cachedMerged.length > 0) {
      for (const item of cachedMerged) {
        newsList.appendChild(renderNewsItem(item));
      }
    } else {
      newsList.innerHTML =
        '<div class="newsItem"><div class="card__body">Loading news…</div></div>';
    }
    setStatus(`Showing ${GAMES.length} games`);
    setLastUpdated(nowMs());
    applySearchFilter();
  } else {
    gamesGrid.innerHTML = "";
    newsList.innerHTML = "";
    setStatus("Loading games and news…");
    lastUpdatedText.textContent = "";
  }

  // Auth must not block or break data load (after Discord redirect getSession can throw/hang)
  const sessionPromise = supabaseClient
    ? supabaseClient.auth
        .getSession()
        .then(({ data: { session } }) => {
          currentAuthUser = session?.user ?? null;
          if (currentAuthUser) return fetchSubscriptions();
        })
        .catch(() => {
          currentAuthUser = null;
          subscribedGameIds = new Set();
        })
    : Promise.resolve();

  const gamePromises = GAMES.map((g) =>
    limiter(async () => {
      try {
        const update = await getLatestGameUpdate(g, { forceRefresh: false, signal });
        return { game: g, update };
      } catch (e) {
        return { game: g, error: e };
      }
    })
  );
  const feedPromises = NEWS_FEEDS.map((f) =>
    limiter(async () => {
      try {
        return await fetchFeed(f, { forceRefresh: false, signal });
      } catch {
        return [];
      }
    })
  );

  let gameResults;
  try {
    [, gameResults] = await Promise.all([
      sessionPromise,
      Promise.all(gamePromises),
    ]);
  } catch (e) {
    if (hasAnyCache) {
      setStatus("Couldn't load latest. Showing cached data.");
      return;
    }
    setStatus("Couldn't load data. Check your connection or try again.");
    renderFallbackCards();
    return;
  }

  gamesGrid.innerHTML = "";
  newsList.innerHTML = '<div class="newsItem"><div class="card__body">Loading news…</div></div>';
  for (const r of gameResults) {
    const subscribed = subscribedGameIds.has(r.game.id);
    const card = r.error
      ? renderGameCard(r.game, null, { error: true, currentUser: currentAuthUser })
      : renderGameCard(r.game, r.update, { subscribed, currentUser: currentAuthUser });
    gamesGrid.appendChild(card);
  }

  setLastUpdated(nowMs());
  applySearchFilter();
  if (!gameSearch.value?.trim()) setStatus(`Showing ${GAMES.length} games`);
  void logVisit();

  Promise.all(feedPromises)
    .then((feedResults) => {
      const merged = feedResults
        .flat()
        .filter((x) => x && x.title && x.url)
        .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0))
        .slice(0, MAX_NEWS_ITEMS);
      newsList.innerHTML = "";
      if (merged.length === 0) {
        newsList.innerHTML =
          '<div class="newsItem"><div class="card__body">No news items loaded. The proxy or sources may be temporarily unavailable.</div></div>';
      } else {
        for (const item of merged) {
          newsList.appendChild(renderNewsItem(item));
        }
      }
    })
    .catch(() => {
      newsList.innerHTML =
        '<div class="newsItem"><div class="card__body">News feed couldn’t load. The public CORS proxy may be temporarily unavailable.</div></div>';
    });
}

function renderFallbackCards() {
  gamesGrid.innerHTML = "";
  newsList.innerHTML = "";
  for (const g of GAMES) {
    const card = renderGameCard(g, null, { error: true, currentUser: currentAuthUser });
    gamesGrid.appendChild(card);
  }
  newsList.innerHTML =
    '<div class="newsItem"><div class="card__body">News feed couldn’t load. Reload the page or check your connection. If it keeps failing, the public CORS proxy may be down (see README for alternatives).</div></div>';
  applySearchFilter();
}

function wireUi() {
  gameSearch.addEventListener("input", applySearchFilter);
  clearSearchBtn.addEventListener("click", () => {
    gameSearch.value = "";
    applySearchFilter();
    gameSearch.focus();
  });
}

wireUi();
initAuth();
loadAll().catch(() => {
  setStatus("Couldn't load data. Check your connection or try again.");
  if (gamesGrid) renderFallbackCards();
});


