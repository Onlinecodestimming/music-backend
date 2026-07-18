import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// -----------------------------
// 🔍 SEARCH
// -----------------------------
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
        const data = await fetch(url).then(r => r.json());

        res.json(data);
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// -----------------------------
// 🎵 TRACK STREAMS
// -----------------------------
app.get("/track/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const url = `https://yt.chocolatemoo53.com/api/v1/streams/${id}`;

        const data = await fetch(url).then(r => r.json());
        res.json(data);
    } catch (err) {
        console.error("Track error:", err);
        res.status(500).json({ error: "Track lookup failed" });
    }
});

// -----------------------------
// 🎤 LYRICS
// -----------------------------
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

// -----------------------------
// 🚀 START SERVER
// -----------------------------
app.listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`);
});
