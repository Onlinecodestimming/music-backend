import express from "express";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

const searchLimiter = rateLimit({
    windowMs: 60000,
    max: 30
});

// CORS
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Safe JSON fetch
async function safeJSON(url) {
    try {
        const res = await fetch(url);
        return await res.json();
    } catch {
        return { results: [] };
    }
}

// SEARCH (Monochrome only)
app.get("/search", searchLimiter, async (req, res) => {
    try {
        const q = (req.query.q || "").trim();
        if (!q) return res.status(400).json({ error: "Missing q" });

        const mono = await safeJSON(`https://monochrome.tf/search/${encodeURIComponent(q)}`);

        const items = mono.results.map(item => {
            const preview = item.preview || "";
            const format = preview.split(".").pop(); // flac, m4a, etc.

            return {
                id: item.id,
                title: item.title,
                artist: item.artist,
                thumbnail: item.thumbnail,
                preview,
                format
            };
        });

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// PLAY (Monochrome only)
app.get("/play/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const mono = await safeJSON(`https://monochrome.tf/track/${id}`);

        if (!mono.preview) {
            return res.status(500).json({ error: "No preview available" });
        }

        const preview = mono.preview;
        const format = preview.split(".").pop(); // flac, m4a, etc.

        res.json({
            url: preview,
            format
        });
    } catch (err) {
        console.error("Play error:", err);
        res.status(500).json({ error: "Play failed" });
    }
});

app.listen(PORT, HOST, () => {
    console.log(`Monochrome-only backend with FLAC support running at http://${HOST}:${PORT}`);
});
