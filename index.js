// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ your OAuth token lives ONLY here
const TIDAL_OAUTH = process.env.TIDAL_OAUTH; // set in Railway env

if (!TIDAL_OAUTH) {
    console.warn("⚠️ TIDAL_OAUTH is not set. Set it in your env vars.");
}

app.use(cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// helper to call TIDAL with OAuth
async function tidalFetch(path, params = "") {
    const base = "https://api.tidal.com/v1"; // placeholder base
    const url = `${base}${path}${params ? `?${params}` : ""}`;

    const res = await fetch(url, {
        headers: {
            // OAuth token stays server-side
            Authorization: `Bearer ${TIDAL_OAUTH}`
        }
    });

    if (!res.ok) {
        throw new Error(`TIDAL error: ${res.status}`);
    }

    return res.json();
}

// 🔍 search tracks (you wire real endpoint)
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        // TODO: replace params with real TIDAL search query
        const data = await tidalFetch("/search", `query=${encodeURIComponent(q)}&types=TRACKS&limit=20`);

        const items = (data.tracks?.items || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown",
            album: track.album?.title || "",
            cover: track.album?.cover || null
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// 🎧 get stream URL for a track (proxy)
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // TODO: replace with real TIDAL track/stream endpoint
        const track = await tidalFetch(`/tracks/${id}`, "");

        // placeholder: you map whatever field TIDAL uses
        const streamUrl = track.streamUrl || track.url || null;

        if (!streamUrl) {
            return res.json({
                id,
                url: null,
                error: "No stream available"
            });
        }

        // you can either:
        // 1) return the URL for the browser to play directly
        // 2) proxy the audio through your server (more control)

        res.json({
            id,
            url: streamUrl,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown"
        });
    } catch (err) {
        console.error("Stream error:", err.message);
        res.status(500).json({ error: "Stream lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
