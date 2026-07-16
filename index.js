import express from "express";
import crypto from "crypto";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Instances to try (primary first). You can override with INVIDIOUS_BASE_URL env var.
const INVIDIOUS_INSTANCES = [
  (process.env.INVIDIOUS_BASE_URL || "https://invidious.nerdvpn.de").replace(/\/+$/, ""),
  "https://yewtu.cafe",
  "https://yewtu.eu"
];

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

// CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/", (req, res) => res.send("ok"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Helper to call fetch, with dynamic fallback to node-fetch if needed
async function doFetch(url, opts = {}) {
  if (typeof global.fetch === "function") {
    return global.fetch(url, opts);
  }
  // dynamic import of node-fetch for older Node versions
  const mod = await import("node-fetch");
  const fetchFn = mod.default || mod;
  return fetchFn(url, opts);
}

async function tryInstances(path) {
  for (const base of INVIDIOUS_INSTANCES) {
    try {
      const url = `${base}${path}`;
      const r = await doFetch(url, { headers: { "User-Agent": "invidious-proxy/1.0" } });
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

app.get("/search", async (req, res) => {
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
