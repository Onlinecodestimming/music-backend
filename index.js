import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// --------------------------------------------------
// 🔍 SEARCH (returns { items: [...] } for your frontend)
// --------------------------------------------------
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
        let data = await fetch(url).then(r => r.json());

        // Normalize to array
        const arr = Array.isArray(data) ? data : [data];

        // Convert ChocolateMoo → your frontend format
        const items = arr.map(item => ({
            id: item.videoId,        // your frontend uses item.id
            videoId: item.videoId,   // keep original too
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
// 🎵 STREAM (your frontend calls /video/:id)
// --------------------------------------------------
app.get("/video/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const url = `https://yt.chocolatemoo53.com/api/v1/streams/${id}`;
        const data = await fetch(url).then(r => r.json());

        const audioUrl =
            data.audioStreams?.find(s => s.url)?.url || null;

        res.json({
            id,
            videoId: id,
            url: audioUrl
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
        const data = await fetch(url).then(r => r.json());
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
