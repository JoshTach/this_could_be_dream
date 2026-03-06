/**
 * POST /api/test-notify — send a single test Discord DM to the authenticated user.
 * Request: Authorization: Bearer <supabase_access_token>
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DISCORD_BOT_TOKEN
 */

async function sendDiscordDM(botToken, discordUserId, content) {
  const createRes = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: discordUserId }),
  });
  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Discord create DM: ${createRes.status} ${err}`);
  }
  const { id: channelId } = await createRes.json();
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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header (Bearer token)" });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnon = process.env.SUPABASE_ANON_KEY;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const discordToken = process.env.DISCORD_BOT_TOKEN;

  if (!supabaseUrl || !supabaseAnon || !supabaseServiceKey || !discordToken) {
    return res.status(500).json({
      error: "Server missing env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, or DISCORD_BOT_TOKEN",
    });
  }

  try {
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: supabaseAnon,
      },
    });
    if (!userRes.ok) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
    const userData = await userRes.json();
    const userId = userData?.id;
    if (!userId) {
      return res.status(401).json({ error: "Invalid session" });
    }

    const profileRes = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=discord_id`,
      {
        headers: {
          apikey: supabaseServiceKey,
          Authorization: `Bearer ${supabaseServiceKey}`,
        },
      }
    );
    if (!profileRes.ok) {
      return res.status(502).json({ error: "Could not load profile" });
    }
    const profiles = await profileRes.json();
    const profile = Array.isArray(profiles) ? profiles[0] : profiles;
    const discordId = profile?.discord_id;
    if (!discordId) {
      return res.status(400).json({
        error: "No Discord account linked. Sign in with Discord and try again.",
      });
    }

    const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "") || req.headers.origin || "https://your-app.vercel.app";
    const testMessage = [
      "**GamePulse – Test notification**",
      "This is a test DM. When a game you’re subscribed to gets a new patch, you’ll get a message like this with a link to the patch notes.",
      "",
      `📎 Open GamePulse: ${siteUrl}`,
    ].join("\n");

    await sendDiscordDM(discordToken, discordId, testMessage);

    return res.status(200).json({ ok: true, message: "Test DM sent. Check your Discord." });
  } catch (e) {
    return res.status(502).json({ error: (e && e.message) || "Failed to send test DM" });
  }
}
