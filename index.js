// NEW CLEAN WORKING index.js — Rhema Music Backend

import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// WORKING Invidious instances
const INVIDIOUS_INSTANCES = [
  "https://yewtu.be",
  "https://yewtu.eu",
  "https://vid.puffyan.us"
];

// Cache + limits
const CACHE_TTL_MS = 300000; // 5 min
const UPSTREAM_TIMEOUT_MS = 8000;
const SEARCH_RATE_LIMIT = 30;

const cache = new Map();

function cacheKey(prefix, q) {
  const hash = crypto.createHash("sha1").update(q).digest("hex");
  return `${prefix}:${hash}`;
}

function setCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

// Rate limit
const searchLimiter = rateLimit({
  windowMs: 60000,
  max: SEARCH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Safe fetch with timeout
async function safeFetch(url) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "rhema-music/1.0" },
      signal: controller.signal
    });
    clearTimeout(id);
    return res;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Try multiple instances
async function tryInstances(path) {
  for (const base of INVIDIOUS_INSTANCES) {
    const url = `${base}${path}`;
    try {
      const res = await safeFetch(url);

      if (!res.ok) {
        console.log("Upstream failed:", base, res.status);
        continue;
      }

      const json = await res.json();
      return { base, json };
    } catch (err) {
      console.log("Instance error:", base, err.message);
      continue;
    }
  }

  throw new Error("All instances failed");
}

// Normalize thumbnails
function normalizeThumb(url, base) {
  if (!url) return url;
  if (url.startsWith("http")) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return base + url;
  return base + "/" + url;
}

// SEARCH
app.get("/search", searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const key = cacheKey("search", q);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { base, json } = await tryInstances(`/api/v1/search?q=${encodeURIComponent(q)}&type=video`);

    const items = (json || []).map(v => {
      const thumbs = (v.videoThumbnails || []).map(t => {
        const url = typeof t === "string" ? t : t.url;
        return { url: normalizeThumb(url, base) };
      });

      return {
        id: v.videoId,
        title: v.title,
        author: v.author,
        thumbnails: thumbs
      };
    });

    const payload = { items };
    setCache(key, payload);

    res.json(payload);
  } catch (err) {
    console.log("Search error:", err.message);
    res.status(502).json({ error: "Search failed" });
  }
});

// VIDEO
app.get("/video/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const key = cacheKey("video", id);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { base, json } = await tryInstances(`/api/v1/videos/${id}`);

    // Normalize thumbnails
    if (json.videoThumbnails) {
      json.videoThumbnails = json.videoThumbnails.map(t => {
        const url = typeof t === "string" ? t : t.url;
        return { url: normalizeThumb(url, base) };
      });
    }

    setCache(key, json);
    res.json(json);
  } catch (err) {
    console.log("Video error:", err.message);
    res.status(502).json({ error: "Video fetch failed" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Rhema Music backend running at http://${HOST}:${PORT}`);
});
