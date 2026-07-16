// Rhema Music Backend — YouTubei.js Version (Self-Hosted, No Blocks)

import express from "express";
import { Innertube } from "youtubei.js";
import rateLimit from "express-rate-limit";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// Initialize YouTube client
let yt;
(async () => {
    yt = await Innertube.create({
        generate_session_locally: true,
        retrieve_player: true,
        retrieve_pbp: true
    });
    console.log("YouTubei.js initialized");
})();

// Rate limit
const searchLimiter = rateLimit({
    windowMs: 60000,
    max: 30,
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

// SEARCH endpoint
app.get("/search", searchLimiter, async (req, res) => {
    try {
        const q = (req.query.q || "").trim();
        if (!q) return res.status(400).json({ error: "Missing q" });

        const results = await yt.search(q, { type: "video" });

        const items = results.videos.map(v => ({
            id: v.id,
           title: v.title?.text || v.title || "Unknown",
author: v.author?.name || "Unknown",
            thumbnails: v.thumbnails
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// VIDEO endpoint (audio stream)
app.get("/video/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const info = await yt.getInfo(id);
        const streaming = info.streaming_data;

        if (!streaming || !streaming.adaptive_formats) {
            return res.status(500).json({ error: "No audio streams found" });
        }

        const audio = streaming.adaptive_formats.find(f => f.mime_type.includes("audio"));

        if (!audio) {
            return res.status(500).json({ error: "No audio stream available" });
        }

        res.json({
            url: audio.url,
            bitrate: audio.bitrate,
            mime: audio.mime_type
        });
    } catch (err) {
        console.error("Video error:", err);
        res.status(500).json({ error: "Video fetch failed" });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Rhema Music backend running at http://${HOST}:${PORT}`);
});
