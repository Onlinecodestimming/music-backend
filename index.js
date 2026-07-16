import express from "express";
import process from "process";
import crypto from "crypto";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Default to the instance you requested
const INVIDIOUS_BASE_URL = (process.env.INVIDIOUS_BASE_URL || "https://invidious.nerdvpn.de").replace(/\/+$/, "");

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 60_000);

function cacheKey(prefix, q, opts = {}) {
  const hash = crypto.createHash("sha1").update(JSON.stringify({ q, opts })).digest("hex");
  return `${prefix}:${hash}`;
}
function setCache(key, value) { cache.set(key, { value, ts: Date.now() }); }
function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.value;
}

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("ok"));

app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing query parameter q" });

    const key = cacheKey("search", q);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const url = `${INVIDIOUS_BASE_URL}/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
    const r = await fetch(url, { headers: { "User-Agent": "invidious-proxy/1.0" } });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("Invidious search error", r.status, text);
      return res.status(502).json({ error: "Upstream search failed", status: r.status });
    }

    const data = await r.json();
    const items = (Array.isArray(data) ? data : []).map(v => ({
      id: v.videoId || v.video_id || v.id,
      title: v.title,
      author: v.author || v.uploader || v.channelTitle,
      lengthSeconds: v.lengthSeconds || v.duration || null,
      published: v.published || v.publishedText || null,
      viewCount: v.viewCount || v.views || null,
      thumbnails: (v.videoThumbnails || v.thumbnails || []).map(t => ({
        url: t.url || t,
        width: t.width || null,
        height: t.height || null
      })),
      description: v.description || null
    }));

    const payload = { items };
    setCache(key, payload);
    res.json(payload);
  } catch (err) {
    console.error("Search handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/video/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const key = cacheKey("video", id);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const url = `${INVIDIOUS_BASE_URL}/api/v1/videos/${encodeURIComponent(id)}`;
    const r = await fetch(url, { headers: { "User-Agent": "invidious-proxy/1.0" } });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      console.error("Invidious video error", r.status, text);
      return res.status(502).json({ error: "Upstream video fetch failed", status: r.status });
    }
    const data = await r.json();
    setCache(key, data);
    res.json(data);
  } catch (err) {
    console.error("Video handler error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, HOST, () => {
  console.log(`Diagnostic server listening on http://${HOST}:${PORT}`);
  console.log(`Using Invidious base URL: ${INVIDIOUS_BASE_URL}`);
});
