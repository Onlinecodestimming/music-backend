// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// your OAuth token from Railway Variables
const TIDAL_OAUTH = process.env.TIDAL_OAUTH;

if (!TIDAL_OAUTH) {
    console.warn("⚠️ TIDAL_OAUTH is not set. Set it in Railway Variables.");
}

app.use(cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// helper: call TIDAL API with your OAuth
async function tidalFetch(path, params = "") {
    // TODO: replace with the real base URL you see in DevTools
    const base = "https://api.tidal.com/v1";
    const url = `${base}${path}${params ? `?${params}` : ""}`;

    const res = await fetch(url, {
        headers: {
            Authorization: TIDAL_OAUTH
        }
    });

    if (!res.ok) {
        throw new Error(`TIDAL error: ${res.status}`);
    }

    return res.json();
}

// 🔍 search tracks
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        // TODO: adjust params to match the real search endpoint you see
        const data = await tidalFetch(
            "/search",
            `query=${encodeURIComponent(q)}&types=TRACKS&limit=20`
        );

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

// 🎧 get stream URL for a track
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // TODO: replace with the real track/stream endpoint you see in DevTools
        const track = await tidalFetch(`/tracks/${id}`, "");

        // TODO: map the actual field that contains the stream URL
        const streamUrl =
            track.streamUrl ||
            track.url ||
            track.playbackUrl ||
            null;

        if (!streamUrl) {
            return res.json({
                id,
                url: null,
                error: "No stream available"
            });
        }

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
