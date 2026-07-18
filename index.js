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
app.get("/video/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const url = `https://yt.chocolatemoo53.com/api/v1/streams/${id}`;

        const response = await fetch(url);

        // If ChocolateMoo returns non-JSON, avoid crashing
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

        // Try every possible ChocolateMoo audio format
        const audioUrl =
            data.audioStreams?.find(s => s.url)?.url ||
            data.audioStreams?.[0]?.url ||
            data.audio?.[0]?.url ||
            data.formats?.find(f => f.mimeType?.includes("audio"))?.url ||
            null;

        if (!audioUrl) {
            return res.json({
                id,
                videoId: id,
                url: null,
                error: "No audio stream found"
            });
        }

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
