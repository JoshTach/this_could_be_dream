/**
 * Vercel serverless: check for new game updates and DM Discord subscribers.
 * Set env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DISCORD_BOT_TOKEN, SITE_URL, OPENAI_API_KEY (optional, for AI DM).
 * Call via cron (e.g. every 6h) or GET /api/notify-subscribers.
 */

const GAMES = [
  { id: "dota2", name: "Dota 2", steamAppId: 570 },
  { id: "cs2", name: "Counter-Strike 2", steamAppId: 730 },
  { id: "eldenring", name: "ELDEN RING", steamAppId: 1245620 },
  { id: "apex", name: "Apex Legends", steamAppId: 1172470 },
  { id: "pubg", name: "PUBG: BATTLEGROUNDS", steamAppId: 578080 },
  { id: "warframe", name: "Warframe", steamAppId: 230410 },
  { id: "destiny2", name: "Destiny 2", steamAppId: 1085660 },
  { id: "helldivers2", name: "HELLDIVERS 2", steamAppId: 553850 },
  { id: "rust", name: "Rust", steamAppId: 252490 },
  { id: "valorant", name: "VALORANT", rssUrl: "https://data.rito.news/val/en-us/news.rss", keywords: ["patch", "update", "notes"] },
  { id: "lol", name: "League of Legends", rssUrl: "https://data.rito.news/lol/en-us/news.rss", keywords: ["patch", "update", "notes"] },
];

const STEAM_NEWS_URL = (appId) =>
  `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${appId}&count=8&maxlength=300&format=json&l=english`;

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseBestItem(items, keywords = ["patch", "update"]) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const k = keywords.map((x) => x.toLowerCase());
  let best = items[0];
  let bestScore = -1;
  for (const it of items) {
    const title = String(it?.title ?? "").toLowerCase();
    const content = stripHtml(String(it?.contents ?? "")).toLowerCase();
    const combined = title + " " + content;
    let score = 0;
    for (const kw of k) if (combined.includes(kw)) score += 2;
    if (title.includes("patch") || title.includes("update")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

function chooseBestRssItem(items, keywords = ["patch", "update", "notes"]) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const k = keywords.map((x) => String(x).toLowerCase());
  let best = items[0];
  let bestScore = -1;
  for (const it of items) {
    const title = String(it?.title ?? "").toLowerCase();
    const excerpt = String(it?.excerpt ?? "").toLowerCase();
    const combined = title + " " + excerpt;
    let score = 0;
    for (const kw of k) if (combined.includes(kw)) score += 2;
    if (title.includes("patch") || title.includes("update") || title.includes("notes")) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best;
}

function parseRssItems(xmlText) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xmlText)) !== null) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i) || [])[1];
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1];
    const pubDate = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1];
    if (!title || !link) continue;
    const cleanTitle = stripHtml((title || "").trim());
    const cleanLink = String(link || "").trim();
    const dateMs = pubDate ? Date.parse(pubDate.trim()) : NaN;
    items.push({
      title: cleanTitle,
      url: cleanLink,
      date: Number.isNaN(dateMs) ? null : Math.floor(dateMs / 1000),
      excerpt: "",
    });
  }
  return items;
}

async function fetchSteamNews(appId) {
  const res = await fetch(STEAM_NEWS_URL(appId));
  if (!res.ok) throw new Error(`Steam API ${res.status}`);
  const json = await res.json();
  const items = json?.appnews?.newsitems ?? [];
  return items;
}

async function fetchRssFeed(rssUrl) {
  const res = await fetch(rssUrl, {
    headers: { "User-Agent": "GamePulse-Notify/1.0" },
  });
  if (!res.ok) throw new Error(`RSS fetch ${res.status}`);
  const xml = await res.text();
  return parseRssItems(xml);
}

/** Returns { title, url, date } for cache comparison and message, or null. */
async function getLatestUpdate(game) {
  if (game.steamAppId) {
    const items = await fetchSteamNews(game.steamAppId);
    const chosen = chooseBestItem(items, game.keywords || ["patch", "update"]);
    if (!chosen) return null;
    return {
      title: String(chosen.title ?? "").trim(),
      url: String(chosen.url ?? "").trim(),
      date: chosen.date ? new Date(Number(chosen.date) * 1000).toISOString() : null,
    };
  }
  if (game.rssUrl) {
    const items = await fetchRssFeed(game.rssUrl);
    const chosen = chooseBestRssItem(items, game.keywords || ["patch", "update", "notes"]);
    if (!chosen) return null;
    return {
      title: String(chosen.title ?? "").trim(),
      url: String(chosen.url ?? "").trim(),
      date: chosen.date ? new Date(Number(chosen.date) * 1000).toISOString() : null,
    };
  }
  return null;
}

/** Generate a short, friendly Discord DM line via OpenAI. Returns null if no key or error. */
async function generateNotifyMessage(openaiKey, gameName, updateTitle, articleUrl) {
  if (!openaiKey || !gameName) return null;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You write one short, friendly sentence for a Discord direct message. Tone: casual and excited. No hashtags or emoji. Do not include any URLs—we will add the link separately. Write only that one sentence, nothing else.",
          },
          {
            role: "user",
            content: `Say that ${gameName} has received a new update. Mention the patch/update in a catchy way (e.g. "new patch is live" or "patch notes are here"). Do not include a link.`,
          },
        ],
        max_tokens: 80,
        temperature: 0.7,
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const line = data?.choices?.[0]?.message?.content?.trim();
    if (!line) return null;
    return `${line}\n\n📎 Patch notes: ${articleUrl}`;
  } catch {
    return null;
  }
}

async function sendDiscordDM(botToken, discordUserId, content) {
  const createChannelRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!createChannelRes.ok) {
    const err = await createChannelRes.text();
    throw new Error(`Discord create DM: ${createChannelRes.status} ${err}`);
  }
  const { id: channelId } = await createChannelRes.json();
  const sendRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content }),
  });
  if (!sendRes.ok) {
    const err = await sendRes.text();
    throw new Error(`Discord send: ${sendRes.status} ${err}`);
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const discordToken = process.env.DISCORD_BOT_TOKEN;
  const siteUrl = (process.env.SITE_URL || "https://your-app.vercel.app").replace(/\/$/, "");
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!supabaseUrl || !supabaseServiceKey || !discordToken) {
    return res.status(500).json({
      error: "Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or DISCORD_BOT_TOKEN",
    });
  }

  const supabaseHeaders = {
    apikey: supabaseServiceKey,
    Authorization: `Bearer ${supabaseServiceKey}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Prefer: "return=representation",
  };

  async function supabaseGet(table, query = "") {
    const q = query ? `?${query}` : "";
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}${q}`, {
      headers: { ...supabaseHeaders, Prefer: "return=representation" },
    });
    if (!r.ok) throw new Error(`Supabase ${table} ${r.status}`);
    return r.json();
  }

  async function supabaseUpsert(table, rows) {
    const r = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...supabaseHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
    });
    if (!r.ok) throw new Error(`Supabase upsert ${table} ${r.status}`);
  }

  const results = { gamesChecked: 0, notificationsSent: 0, errors: [] };

  const articleUrlForGame = (gameId) => `${siteUrl}/article?game=${encodeURIComponent(gameId)}`;

  for (const game of GAMES) {
    results.gamesChecked++;
    try {
      const update = await getLatestUpdate(game);
      if (!update) continue;

      const newTitle = update.title;
      const newUrl = update.url;
      const newDate = update.date;

      const cacheRows = await supabaseGet(
        "game_updates_cache",
        `select=last_title,last_date&game_id=eq.${encodeURIComponent(game.id)}&limit=1`
      );
      const cached = Array.isArray(cacheRows) ? cacheRows[0] : cacheRows;

      const isNew =
        cached &&
        ((newTitle && newTitle !== cached.last_title) ||
          (newDate && cached.last_date !== newDate));

      if (!isNew) {
        if (!cached) {
          await supabaseUpsert("game_updates_cache", {
            game_id: game.id,
            last_title: newTitle,
            last_url: newUrl,
            last_date: newDate,
            updated_at: new Date().toISOString(),
          });
        }
        continue;
      }

      const subs = await supabaseGet(
        "subscriptions",
        `game_id=eq.${encodeURIComponent(game.id)}&select=user_id`
      );
      const subList = Array.isArray(subs) ? subs : [];

      if (subList.length === 0) {
        await supabaseUpsert("game_updates_cache", {
          game_id: game.id,
          last_title: newTitle,
          last_url: newUrl,
          last_date: newDate,
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      const userIds = [...new Set(subList.map((s) => s.user_id))];
      const inParam = userIds.map((u) => encodeURIComponent(u)).join(",");
      const profilesRes = await fetch(
        `${supabaseUrl}/rest/v1/profiles?select=id,discord_id&id=in.(${inParam})&discord_id=not.is.null`,
        { headers: supabaseHeaders }
      );
      if (!profilesRes.ok) throw new Error(`Supabase profiles ${profilesRes.status}`);
      const profiles = await profilesRes.json();
      const profileList = Array.isArray(profiles) ? profiles : [];

      const articleUrl = articleUrlForGame(game.id);
      let message = await generateNotifyMessage(openaiKey, game.name, newTitle, articleUrl);
      if (!message) {
        message = [
          `**${game.name}** has a new update!`,
          newTitle ? `\n${newTitle}` : "",
          `\n\n📎 Patch notes: ${articleUrl}`,
        ]
          .filter(Boolean)
          .join("");
      }

      for (const p of profileList) {
        if (!p.discord_id) continue;
        try {
          await sendDiscordDM(discordToken, p.discord_id, message);
          results.notificationsSent++;
        } catch (e) {
          results.errors.push({ game: game.id, discordId: p.discord_id, error: e.message });
        }
      }

      await supabaseUpsert("game_updates_cache", {
        game_id: game.id,
        last_title: newTitle,
        last_url: newUrl,
        last_date: newDate,
        updated_at: new Date().toISOString(),
      });
    } catch (e) {
      results.errors.push({ game: game.id, error: e.message });
    }
  }

  return res.status(200).json(results);
}
