// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// use the client_id that works for metadata/search
const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

async function scFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SoundCloud error: ${res.status}`);
    return res.json();
}

// FIXED SEARCH ENDPOINT
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q || "";
        const limit = req.query.limit || "20";
        const offset = req.query.offset || "0";

        const params = new URLSearchParams({
    q,
    client_id: CLIENT_ID,
    limit,
    offset,
    app_version: "1784221259",
    app_locale: "en",
    variant_ids: "core"
});

        const url = `https://api-v2.soundcloud.com/search/tracks?${params.toString()}`;

        const data = await scFetch(url);

        const items = (data.collection || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.user?.username || "Unknown",
            artwork: track.artwork_url || track.user?.avatar_url || null,
            durationMs: track.duration
        }));

        res.json({
            items,
            nextOffset: Number(offset) + Number(limit),
            raw: data
        });

    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// TRACK ENDPOINT WITH HLS/MP3/DASH FALLBACK
app.get("/track/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const track = await scFetch(
            `https://api-v2.soundcloud.com/tracks/${id}?client_id=${CLIENT_ID}`
        );

        const transcodings = track.media?.transcodings || [];

        const order = [
            t => t.format?.protocol === "hls",
            t => t.format?.protocol === "progressive",
            t => t.format?.protocol === "dash"
        ];

        let chosen = null;
        for (const pick of order) {
            chosen = transcodings.find(pick);
            if (chosen) break;
        }

        if (!chosen) {
            return res.json({
                id,
                title: track.title,
                artist: track.user?.username,
                url: null,
                protocol: null,
                error: "No playable formats available"
            });
        }

        const resolveUrl = chosen.url + `?client_id=${CLIENT_ID}`;
        const resolved = await fetch(resolveUrl).then(r => r.json());

        res.json({
            id,
            title: track.title,
            artist: track.user?.username,
            url: resolved.url,
            protocol: chosen.format.protocol
        });

    } catch (err) {
        console.error("Track error:", err);
        res.status(500).json({ error: "Track lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`HLS/MP3/DASH SoundCloud backend running on port ${PORT}`);
});
