import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Primary instance can be overridden with env var
const INVIDIOUS_INSTANCES = [
  (process.env.INVIDIOUS_BASE_URL || "https://invidious.nerdvpn.de").replace(/\/+$/, ""),
  "https://yewtu.cafe",
  "https://yewtu.eu"
];

// Simple in-memory cache
const cache = new Map();
const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 60_000);

// Rate limiter for /search to protect upstream instances
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.SEARCH_RATE_LIMIT || 60),
  standardHeaders: true,
  legacyHeaders: false
});

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
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// fetch helper with dynamic fallback and timeout
async function doFetch(url, opts = {}, timeoutMs = 8000) {
  const headers = opts.headers || {};
  if (typeof global.fetch === "function") {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await global.fetch(url, { ...opts, signal: controller.signal, headers });
      clearTimeout(id);
      return r;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }
  const mod = await import("node-fetch");
  const fetchFn = mod.default || mod;
  const { AbortController } = await import("abort-controller").catch(() => ({ AbortController: global.AbortController }));
  const controller = new (AbortController)();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { ...opts, signal: controller.signal, headers });
    clearTimeout(id);
    return r;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

async function tryInstances(path) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const url = `${base}${path}`;
      const r = await doFetch(url, { headers: { "User-Agent": "invidious-proxy/1.0" } }, Number(process.env.UPSTREAM_TIMEOUT_MS || 8000));
      if (!r.ok) {
        console.warn("Upstream failed", base, r.status);
        continue;
      }
      const json = await r.json();
      return { base, json };
    } catch (err) {
      console.warn("Instance error", base, err && err.message);
      continue;
    }
  }
  throw new Error("All upstream instances failed");
}

// /search with rate limiting and caching
app.get("/search", searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing query parameter q" });

    const key = cacheKey("search", q);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { base, json } = await tryInstances(`/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
    const items = (Array.isArray(json) ? json : []).map(v => ({
      id: v.videoId || v.video_id || v.id,
      title: v.title,
      author: v.author || v.uploader || null,
      lengthSeconds: v.lengthSeconds || v.duration || null,
      published: v.published || v.publishedText || null,
      viewCount: v.viewCount || v.views || null,
      thumbnails: (v.videoThumbnails || v.thumbnails || []).map(t => ({ url: t.url || t })),
      description: v.description || null
    }));

    const payload = { items };
    setCache(key, payload);
    res.setHeader("X-Invidious-Instance", base);
    res.json(payload);
  } catch (err) {
    console.error("Search handler error:", err);
    res.status(502).json({ error: "Upstream search failed" });
  }
});

// /video/:id proxy with caching
app.get("/video/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const key = cacheKey("video", id);
    const cached = getCache(key);
    if (cached) return res.json(cached);

    const { base, json } = await tryInstances(`/api/v1/videos/${encodeURIComponent(id)}`);
    setCache(key, json);
    res.setHeader("X-Invidious-Instance", base);
    res.json(json);
  } catch (err) {
    console.error("Video handler error:", err);
    res.status(502).json({ error: "Upstream video fetch failed" });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`Invidious instances: ${INVIDIOUS_INSTANCES.join(", ")}`);
});
