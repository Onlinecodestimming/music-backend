import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// SEARCH
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const url = `https://yt.chocolatemoo53.com/api/v1/search?q=${encodeURIComponent(q)}&type=video`;
        const data = await fetch(url).then(r => r.json());

        // Always return an array so frontend forEach never breaks
        const safe = Array.isArray(data) ? data : [data];

        res.json(safe);
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});



// LYRICS
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

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
