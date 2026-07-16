// index.js - robust Invidious proxy with thumbnail normalization, fallbacks, logging, caching, and safe JSON errors
import express from "express";
import crypto from "crypto";
import rateLimit from "express-rate-limit";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Primary instance from env, plus optional fallbacks (edit as needed)
const INVIDIOUS_BASE_URL = (process.env.INVIDIOUS_BASE_URL || "https://yt.chocolatemoo53.com").replace(/\/+$/, "");
const INVIDIOUS_INSTANCES = [
  INVIDIOUS_BASE_URL,
  (process.env.INVIDIOUS_FALLBACK_1 || "").replace(/\/+$/, ""),
  (process.env.INVIDIOUS_FALLBACK_2 || "").replace(/\/+$/, "")
].filter(Boolean);

// Configurable values
const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 300_000); // default 5 minutes
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 8000);
const SEARCH_RATE_LIMIT = Number(process.env.SEARCH_RATE_LIMIT || 30);

const cache = new Map();

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

// Rate limiter for /search
const searchLimiter = rateLimit({
  windowMs: 60_000,
  max: SEARCH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false
});

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// fetch helper with timeout and node-fetch fallback
async function doFetch(url, opts = {}, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  if (typeof global.fetch === "function") {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await global.fetch(url, { ...opts, signal: controller.signal });
      clearTimeout(id);
      return r;
    } catch (err) {
      clearTimeout(id);
      throw err;
    }
  }
  const mod = await import("node-fetch");
  const fetchFn = mod.default || mod;
  // AbortController fallback for older node-fetch
  let AC;
  try { AC = (await import("abort-controller")).AbortController; } catch { AC = global.AbortController; }
  const controller = new (AC)();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { ...opts, signal: controller.signal });
    clearTimeout(id);
    return r;
  } catch (err) {
    clearTimeout(id);
    throw err;
  }
}

// Normalize thumbnail URLs: make relative URLs absolute using the instance base
function normalizeThumbnailUrl(url, base) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url)) return url;
  // handle protocol-relative or root-relative paths
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${base.replace(/\/+$/, "")}${url}`;
  // otherwise treat as relative path
  return `${base.replace(/\/+$/, "")}/${url}`;
}

async function tryInstances(path) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const url = `${base}${path}`;
      const r = await doFetch(url, { headers: { "User-Agent": "invidious-proxy/1.0" } }, UPSTREAM_TIMEOUT_MS);
      if (!r.ok) {
        const text = await r.text().catch(() => "<no body>");
        console.warn("Upstream failed", base, r.status, text);
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

app.get("/search", searchLimiter, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "Missing query parameter q" });

    const key = cacheKey("search", q);
    const cached = getCache(key);
    if (cached) {
      res.setHeader("X-Invidious-Instance", INVIDIOUS_BASE_URL);
      return res.json(cached);
    }

    const { base, json } = await tryInstances(`/api/v1/search?q=${encodeURIComponent(q)}&type=video`);
    const baseHost = (base || INVIDIOUS_BASE_URL).replace(/\/+$/, "");

    const items = (Array.isArray(json) ? json : []).map(v => {
      const thumbs = (v.videoThumbnails || v.thumbnails || []).map(t => {
        // t may be an object or a string
        const url = (typeof t === "string") ? t : (t.url || t);
        return {
          url: normalizeThumbnailUrl(url, baseHost),
          width: (t && t.width) || null,
          height: (t && t.height) || null,
          quality: (t && t.quality) || null
        };
      });
      return {
        id: v.videoId || v.video_id || v.id || null,
        title: v.title || null,
        author: v.author || v.uploader || null,
        authorId: v.authorId || v.uploaderId || null,
        lengthSeconds: v.lengthSeconds || v.duration || null,
        published: v.published || v.publishedText || null,
        viewCount: v.viewCount || v.views || null,
        thumbnails: thumbs,
        description: v.description || null,
        raw: undefined // intentionally omit large raw fields; keep payload small
      };
    });

    const payload = { items };
    setCache(key, payload);
    res.setHeader("X-Invidious-Instance", baseHost);
    return res.json(payload);
  } catch (err) {
    console.error("Search handler error:", err && (err.stack || err.message || err));
    res.setHeader("Content-Type", "application/json");
    return res.status(502).json({
      error: "Upstream search failed",
      message: err && err.message ? err.message : null
    });
  }
});

app.get("/video/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: "Missing video id" });

    const key = cacheKey("video", id);
    const cached = getCache(key);
    if (cached) {
      res.setHeader("X-Invidious-Instance", INVIDIOUS_BASE_URL);
      return res.json(cached);
    }

    const { base, json } = await tryInstances(`/api/v1/videos/${encodeURIComponent(id)}`);
    const baseHost = (base || INVIDIOUS_BASE_URL).replace(/\/+$/, "");

    // If the upstream returns thumbnails with relative URLs, normalize them
    if (json && json.videoThumbnails) {
      json.videoThumbnails = json.videoThumbnails.map(t => {
        const url = (typeof t === "string") ? t : (t.url || t);
        return { ...(typeof t === "object" ? t : {}), url: normalizeThumbnailUrl(url, baseHost) };
      });
    }

    setCache(key, json);
    res.setHeader("X-Invidious-Instance", baseHost);
    return res.json(json);
  } catch (err) {
    console.error("Video handler error:", err && (err.stack || err.message || err));
    res.setHeader("Content-Type", "application/json");
    return res.status(502).json({ error: "Upstream video fetch failed", message: err && err.message ? err.message : null });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
  console.log(`Primary Invidious instance: ${INVIDIOUS_BASE_URL}`);
  console.log(`Fallback instances: ${INVIDIOUS_INSTANCES.filter(i => i !== INVIDIOUS_BASE_URL).join(", ") || "<none>"}`);
});
