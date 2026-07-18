// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const TIDAL_OAUTH = process.env.TIDAL_OAUTH;

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

// helper for TIDAL v1/v2
async function tidalFetch(fullUrl) {
    const res = await fetch(fullUrl, {
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

// 🔍 SEARCH (your captured request)
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;

        const url =
            "https://tidal.com/v2/search/?" +
            new URLSearchParams({
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

        const data = await tidalFetch(url);

        const items = (data?.tracks?.items || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", "),
            album: track.album?.title,
            cover: track.album?.cover
        }));

        res.json({ items });
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

// 🎧 STREAM METADATA (NOT audio yet)
app.get("/stream/:id", async (req, res) => {
    try {
        const id = req.params.id;

        const url =
            `https://tidal.com/v1/tracks/${id}?` +
            new URLSearchParams({
                countryCode: "US",
                locale: "en_US",
                deviceType: "BROWSER"
            }).toString();

        const track = await tidalFetch(url);

        res.json({
            id: track.id,
            title: track.title,
            artist: track.artists?.map(a => a.name).join(", "),
            album: track.album?.title,
            cover: track.album?.cover,
            // placeholder until we capture the real playback endpoint
            url: null
        });
    } catch (err) {
        res.status(500).json({ error: "Stream lookup failed" });
    }
});

app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
