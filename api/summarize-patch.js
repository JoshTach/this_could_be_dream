/**
 * Vercel serverless: generate a short AI narrative summary of patch notes.
 * POST body: { content: string, gameName?: string, title?: string }
 * Returns: { summary: string }
 * Set OPENAI_API_KEY in Vercel env.
 */

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return res.status(503).json({ error: "Summary not configured (missing OPENAI_API_KEY)" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const content = String(body.content ?? "").trim();
  if (!content || content.length > 30000) {
    return res.status(400).json({ error: "Missing or too long content" });
  }

  const gameName = String(body.gameName ?? "the game").trim();
  const title = String(body.title ?? "Patch notes").trim();

  const systemPrompt = `You are a concise gaming patch-notes summarizer. Write a short narrative (2–4 sentences) for players: highlight what got buffed or nerfed, key changes, and why they might matter. Be specific when the notes mention items, heroes, or mechanics. Tone: helpful and neutral, no hype. Write only the summary, no intro like "Here's a summary."`;

  const userPrompt = `Game: ${gameName}. Patch: ${title}.\n\nPatch notes (excerpt):\n${content.slice(0, 12000)}`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 280,
        temperature: 0.4,
      }),
    });

    if (!r.ok) {
      const err = await r.text();
      return res.status(r.status).json({ error: r.status === 401 ? "Invalid API key" : err || "OpenAI error" });
    }

    const data = await r.json();
    const summary = data?.choices?.[0]?.message?.content?.trim();
    if (!summary) return res.status(502).json({ error: "No summary returned" });

    res.setHeader("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
    return res.status(200).json({ summary });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "Upstream error" });
  }
}
