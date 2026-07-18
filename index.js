// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// Your SoundCloud client_id (public, safe to use)
const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

// Helper: GET JSON
async function scFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SoundCloud error: ${res.status}`);
    return res.json();
}

// 🔍 SEARCH ENDPOINT
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q || "";

        const url =
            "https://api-v2.soundcloud.com/search?" +
            new URLSearchParams({
                q,
                client_id: CLIENT_ID,
                limit: "30"
            }).toString();

        const data = await scFetch(url);

        const items = (data.collection || [])
            .filter(item => item.kind === "track")
            .map(track => ({
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

// 🎧 TRACK METADATA
app.get("/track/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const url =
            `https://api-v2.soundcloud.com/tracks/${id}?` +
            new URLSearchParams({ client_id: CLIENT_ID }).toString();

        const track = await scFetch(url);

        res.json({
            id: track.id,
            title: track.title,
            artist: track.user?.username || "Unknown",
            artwork: track.artwork_url || track.user?.avatar_url || null,
            durationMs: track.duration,
            streamable: track.streamable
        });
    } catch (err) {
        console.error("Track error:", err.message);
        res.status(500).json({ error: "Track lookup failed" });
    }
});

// 🎧 FULL MP3 STREAM RESOLVER (POST FIX APPLIED)
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // 1) Fetch track metadata
        const trackUrl =
            `https://api-v2.soundcloud.com/tracks/${id}?` +
            new URLSearchParams({ client_id: CLIENT_ID }).toString();

        const track = await scFetch(trackUrl);

        if (!track.streamable) {
            return res.json({
                id,
                url: null,
                error: "Track is not streamable"
            });
        }

        // 2) Find progressive transcoding (MP3)
        const transcoding = (track.media?.transcodings || []).find(t =>
            t.format?.protocol === "progressive"
        );

        if (!transcoding) {
            return res.json({
                id,
                url: null,
                error: "No progressive stream available"
            });
        }

        // 3) Resolve transcoding → MUST BE POST
        const resolveUrl = transcoding.url;

        const resolved = await fetch(resolveUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ client_id: CLIENT_ID })
        }).then(r => r.json());

        const mp3Url = resolved.url;

        if (!mp3Url) {
            return res.json({
                id,
                url: null,
                error: "No stream URL returned"
            });
        }

        // 4) Return final MP3 URL
        res.json({
            id,
            url: mp3Url,
            title: track.title,
            artist: track.user?.username || "Unknown"
        });

    } catch (err) {
        console.error("Stream error:", err.message);
        res.status(500).json({ error: "Stream lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`SoundCloud backend running on port ${PORT}`);
});
