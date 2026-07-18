// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const TIDAL_OAUTH = process.env.TIDAL_OAUTH;

if (!TIDAL_OAUTH) {
    console.warn("⚠️ TIDAL_OAUTH is not set. Set it in Railway Variables.");
}

app.use(cors({
    origin: "*",
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

// generic helper for TIDAL v2
async function tidalFetch(path, params = "") {
    const base = "https://tidal.com/v2";
    const url = `${base}${path}${params ? `?${params}` : ""}`;

    const res = await fetch(url, {
        headers: {
            Authorization: TIDAL_OAUTH,
            Accept: "application/json"
        }
    });

    if (!res.ok) {
        throw new Error(`TIDAL error: ${res.status}`);
    }

    return res.json();
}

// 🔍 search tracks using your captured request pattern
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const params = new URLSearchParams({
            includeContributors: "true",
            includeDidYouMean: "true",
            includeUserPlaylists: "true",
            limit: "50",
            query: q,
            supportsUserData: "true",
            types: "ARTISTS,ALBUMS,TRACKS,VIDEOS,PLAYLISTS,UPLOADS",
            countryCode: "US",
            locale: "en_US",
            deviceType: "BROWSER"
        }).toString();

        const data = await tidalFetch("/search/", params);

        const items = (data?.tracks?.items || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown",
            album: track.album?.title || "",
            cover: track.album?.cover || null
        }));

        res.json({ items });
    } catch (err) {
        console.error("Search error:", err.message);
        res.status(500).json({ error: "Search failed" });
    }
});

// 🎧 placeholder stream endpoint – you’ll wire this once you capture a play request
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        // TODO: capture the real playback request from DevTools (like you did for search)
        // and mirror its path + params here.
        //
        // Example shape (you will replace with the real one):
        // const params = new URLSearchParams({
        //   countryCode: "US",
        //   deviceType: "BROWSER"
        // }).toString();
        //
        // const track = await tidalFetch(`/tracks/${id}`, params);

        const track = {}; // placeholder until you grab the real endpoint

        const streamUrl =
            track.streamUrl ||
            track.url ||
            track.playbackUrl ||
            null;

        if (!streamUrl) {
            return res.json({
                id,
                url: null,
                error: "No stream available"
            });
        }

        res.json({
            id,
            url: streamUrl,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", ") || "Unknown"
        });
    } catch (err) {
        console.error("Stream error:", err.message);
        res.status(500).json({ error: "Stream lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
