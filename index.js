// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// your SoundCloud client_id (you already found this)
const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

// helper: call SoundCloud API v2
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

// 🎧 get track metadata
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

// 🎧 get actual MP3 stream URL
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // 1) get track metadata
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

        // 2) find progressive/mp3 transcoding
        const transcoding = (track.media?.transcodings || []).find(t =>
            t.format?.protocol === "progressive" ||
            t.format?.mime_type === "audio/mpeg"
        );

        if (!transcoding) {
            return res.json({
                id,
                url: null,
                error: "No progressive stream available"
            });
        }

        // 3) resolve transcoding to actual MP3 URL
        const resolveUrl =
            transcoding.url +
            (transcoding.url.includes("?") ? "&" : "?") +
            `client_id=${CLIENT_ID}`;

        const resolved = await scFetch(resolveUrl);

        const mp3Url = resolved.url;

        if (!mp3Url) {
            return res.json({
                id,
                url: null,
                error: "No stream URL returned"
            });
        }

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
