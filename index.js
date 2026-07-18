// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// use the client_id that works for /tracks + /search
const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

async function scFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SoundCloud error: ${res.status}`);
    return res.json();
}

// 🔍 search tracks
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q || "";

        const url =
            "https://api-v2.soundcloud.com/search/tracks?" +
            new URLSearchParams({
                q,
                client_id: CLIENT_ID,
                limit: "20"
            }).toString();

        const data = await scFetch(url);

        const items = (data.collection || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.user?.username || "Unknown",
            artwork: track.artwork_url || track.user?.avatar_url || null,
            durationMs: track.duration
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// 🎧 track + HLS URL
app.get("/track/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const url =
            `https://api-v2.soundcloud.com/tracks/${id}?` +
            new URLSearchParams({ client_id: CLIENT_ID }).toString();

        const track = await scFetch(url);

        const transcodings = track.media?.transcodings || [];

        // prefer HLS
        const hls = transcodings.find(t => t.format?.protocol === "hls");

        let hlsUrl = null;

        if (hls) {
            // this URL usually returns a JSON with the final playlist.m3u8
            const resolveRes = await fetch(hls.url + "?" + new URLSearchParams({
                client_id: CLIENT_ID
            }).toString());

            if (resolveRes.ok) {
                const resolved = await resolveRes.json();
                hlsUrl = resolved.url || null;
            }
        }

        res.json({
            id: track.id,
            title: track.title,
            artist: track.user?.username || "Unknown",
            artwork: track.artwork_url || track.user?.avatar_url || null,
            durationMs: track.duration,
            hlsUrl
        });
    } catch (err) {
        console.error("Track error:", err);
        res.status(500).json({ error: "Track lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`HLS SoundCloud backend running on port ${PORT}`);
});
