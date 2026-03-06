/**
 * Vercel serverless: fetch a remote article page and return extracted main content as plain text.
 * GET ?url=<encoded-url>
 * Allowlisted hosts: leagueoflegends.com, playvalorant.com (and www subdomains).
 * Returns: { content: string } or { error: string }
 */

const ALLOWED_HOSTS = [
  "www.leagueoflegends.com",
  "leagueoflegends.com",
  "www.playvalorant.com",
  "playvalorant.com",
  "teamfighttactics.leagueoflegends.com",
];

function getHost(url) {
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function stripScriptsAndStyles(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
}

function extractFromNextData(html) {
  const match = html.match(/<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const props = data?.props?.pageProps ?? data?.pageProps ?? data;
    if (!props) return null;
    const walk = (obj, out = []) => {
      if (typeof obj === "string" && obj.length > 20) out.push(obj);
      else if (Array.isArray(obj)) obj.forEach((v) => walk(v, out));
      else if (obj && typeof obj === "object") Object.values(obj).forEach((v) => walk(v, out));
      return out;
    };
    const parts = walk(props);
    return parts.length ? parts.join("\n\n") : null;
  } catch {
    return null;
  }
}

function extractText(html) {
  const cleaned = stripScriptsAndStyles(html);
  // Prefer article/main; otherwise use body
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  const contentBlock = articleMatch
    ? articleMatch[1]
    : mainMatch
      ? mainMatch[1]
      : cleaned.replace(/^[\s\S]*<body[^>]*>/i, "").replace(/<\/body>[\s\S]*$/i, "");
  // Preserve paragraph/block structure: block-level closers become newlines
  let block = contentBlock
    .replace(/<\/(?:p|div|h[1-6]|li|tr|section|article|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  let text = block
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length < 500) {
    const fromNext = extractFromNextData(html);
    if (fromNext && fromNext.length > text.length) text = fromNext;
  }
  return text.slice(0, 150000); // cap size
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string") {
    return res.status(400).json({ error: "Missing url query" });
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: "Invalid url" });
  }

  const host = getHost(url.toString());
  if (!host || !ALLOWED_HOSTS.some((h) => host === h || host.endsWith("." + h))) {
    return res.status(403).json({ error: "URL not allowlisted" });
  }

  try {
    const response = await fetch(url.toString(), {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; rv:109.0) Gecko/20100101 Firefox/119.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: "Upstream fetch failed" });
    }

    const html = await response.text();
    const content = extractText(html);

    if (!content || content.length < 100) {
      return res.status(200).json({ content: "", note: "No extractable content" });
    }

    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    return res.status(200).json({ content });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "Fetch failed" });
  }
}
