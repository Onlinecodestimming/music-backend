import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

// --------------------------------------------------
// ✅ FIXED CORS (Railway-compatible)
// --------------------------------------------------
app.use(cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// --------------------------------------------------
// 🔍 SEARCH (returns { items: [...] } for your frontend)
// --------------------------------------------------
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
        const response = await fetch(url);

        let data;
        try {
            data = await response.json();
        } catch {
            return res.json({ items: [] });
        }

        const arr = Array.isArray(data) ? data : [data];

        const items = arr.map(item => ({
            id: item.videoId,
            videoId: item.videoId,
            title: item.title,
            author: item.author
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// --------------------------------------------------
// 🎥 VIDEO STREAM (actual video playback)
// --------------------------------------------------
app.get("/video/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // Use the correct ChocolateMoo endpoint for video
        const url = `https://yt.chocolatemoo53.com/api/v1/videos/${id}`;
        const response = await fetch(url);

        let data;
        try {
            data = await response.json();
        } catch {
            return res.json({
                id,
                videoId: id,
                url: null,
                error: "Invalid JSON from upstream"
            });
        }

        // Try to get a real video stream first
        const videoUrl =
            data.videoStreams?.find(v => v.url)?.url ||
            data.videoStreams?.[0]?.url ||
            null;

        // Fallback to audio if video is missing
        const audioUrl =
            data.audioStreams?.find(a => a.url)?.url ||
            data.audioStreams?.[0]?.url ||
            null;

        const finalUrl = videoUrl || audioUrl;

        if (!finalUrl) {
            return res.json({
                id,
                videoId: id,
                url: null,
                error: "No video or audio stream found"
            });
        }

        res.json({
            id,
            videoId: id,
            url: finalUrl
        });

    } catch (err) {
        console.error("Video error:", err);
        res.status(500).json({ error: "Video lookup failed" });
    }
});

// --------------------------------------------------
// 🎤 LYRICS (optional)
// --------------------------------------------------
app.get("/lyrics/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const url = `https://yt.chocolatemoo53.com/api/v1/lyrics/${id}`;

        const response = await fetch(url);

        let data;
        try {
            data = await response.json();
        } catch {
            return res.json({ error: "Invalid JSON from upstream" });
        }

        res.json(data);
    } catch (err) {
        console.error("Lyrics error:", err);
        res.status(500).json({ error: "Lyrics lookup failed" });
    }
});

// --------------------------------------------------
// 🚀 START SERVER
// --------------------------------------------------
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
