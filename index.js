// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// TODO: put your real TIDAL API base + token here
const TIDAL_API_BASE = "https://api.tidal.com/v1";
const TIDAL_TOKEN = process.env.TIDAL_TOKEN; // or hardcode if you want

app.use(cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// 🔍 search tracks
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        // TODO: replace with real TIDAL search endpoint
        const url = `${TIDAL_API_BASE}/search?query=${encodeURIComponent(q)}&types=TRACKS&limit=20&token=${TIDAL_TOKEN}`;

        const response = await fetch(url);
        const data = await response.json();

        const items = (data.tracks?.items || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown",
            album: track.album?.title || "",
            cover: track.album?.cover || null
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// 🎧 get preview URL for a track
app.get("/preview/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // TODO: replace with real TIDAL track/preview endpoint
        const url = `${TIDAL_API_BASE}/tracks/${id}?token=${TIDAL_TOKEN}`;

        const response = await fetch(url);
        const track = await response.json();

        // many TIDAL-like APIs expose a previewUrl field
        const previewUrl = track.previewUrl || null;

        if (!previewUrl) {
            return res.json({
                id,
                url: null,
                error: "No preview available"
            });
        }

        res.json({
            id,
            url: previewUrl,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown"
        });
    } catch (err) {
        console.error("Preview error:", err);
        res.status(500).json({ error: "Preview lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
