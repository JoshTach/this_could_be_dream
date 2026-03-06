/**
 * Local dev server: serves static files and /api/steam-news so you don't get 404s or CORS errors.
 * Run: node server.js   then open http://localhost:3000
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = Number(process.env.PORT) || 3000;
const STEAM_URL = "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/";

function serveFile(filePath, res) {
  const ext = path.extname(filePath);
  const types = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".ico": "image/x-icon",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
  };
  const contentType = types[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
}

async function fetchSteamNews(appid, lang = "english", maxlength = 400) {
  const u = `${STEAM_URL}?appid=${appid}&count=12&maxlength=${Math.min(Number(maxlength) || 400, 10000)}&format=json&l=${encodeURIComponent(lang)}`;
  const r = await fetch(u, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
  if (!r.ok) throw new Error(`Steam API ${r.status}`);
  return r.json();
}

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  const query = parsed.query || {};

  if (req.method === "GET" && (pathname === "/article" || pathname === "/article.html")) {
    serveFile(path.join(__dirname, "article.html"), res);
    return;
  }

  if (req.method === "GET" && pathname === "/api/steam-news") {
    const appid = query.appid;
    const lang = (query.l && String(query.l).trim()) || "english";
    const maxlength = Math.min(Number(query.maxlength) || 400, 10000);
    if (!appid || !/^\d+$/.test(String(appid))) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid appid" }));
      return;
    }
    try {
      const json = await fetchSteamNews(appid, lang, maxlength);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(json));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (e && e.message) || "Upstream error" }));
    }
    return;
  }

  let pathnameNorm = pathname.replace(/^\//, "") || "index.html";
  if (pathnameNorm === "article") pathnameNorm = "article.html";
  let filePath = path.join(__dirname, pathnameNorm === "index.html" && pathname === "/" ? "index.html" : pathnameNorm);
  if (!pathnameNorm.includes(".")) {
    try {
      const p = path.join(__dirname, pathnameNorm, "index.html");
      if (fs.existsSync(p)) filePath = p;
    } catch {}
  }
  const resolved = path.resolve(filePath);
  const resolvedDir = path.resolve(__dirname);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    res.writeHead(403);
    res.end();
    return;
  }
  serveFile(filePath, res);
}

function tryListen(port) {
  const server = http.createServer(handleRequest);
  server.listen(port, () => {
    console.log(`GamePulse dev server: http://localhost:${port}`);
    console.log("  /api/steam-news is available (no 404s or CORS for Steam).");
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORT + 5) {
      console.log(`Port ${port} in use, trying ${port + 1}…`);
      tryListen(port + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}
tryListen(PORT);
