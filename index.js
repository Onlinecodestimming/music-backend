// Rhema Music Backend — Piped Version (Guaranteed Working)

import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Piped instances (stable)
const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.syncpundit.io",
  "https://pipedapi.mha.fi"
];

console.log("Using Piped instances:", PIPED_INSTANCES);

// Cache + limits
const CACHE_TTL_MS = 300000;
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

// Try multiple Piped instances
async function tryInstances(path) {
  for (const base of PIPED_INSTANCES) {
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

// SEARCH (Piped)
app.get("/search", searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const key = cacheKey("search", q);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { json } = await tryInstances(`/search?q=${encodeURIComponent(q)}`);

    const items = (json.items || []).map(v => ({
      id: v.id,
      title: v.title,
      author: v.uploader,
      thumbnails: v.thumbnails
    }));

    const payload = { items };
    setCache(key, payload);

    res.json(payload);
  } catch (err) {
    console.log("Search error:", err.message);
    res.status(502).json({ error: "Search failed" });
  }
});

// VIDEO (Piped)
app.get("/video/:id", async (req, res) => {
  try {
    const id = req.params.id;

    const key = cacheKey("video", id);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { json } = await tryInstances(`/streams/${id}`);

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
