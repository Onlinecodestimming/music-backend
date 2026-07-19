// spotify-search.js (part of your backend)
import express from "express";
import fetch from "node-fetch";

const router = express.Router();

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let spotifyToken = null;
let spotifyTokenExpires = 0;

async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpires) return spotifyToken;

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: "Basic " + Buffer.from(
                `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
            ).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
    });

    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpires = Date.now() + data.expires_in * 1000;
    return spotifyToken;
}

router.get("/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });

    const token = await getSpotifyToken();

    const r = await fetch(
        "https://api.spotify.com/v1/search?" +
        new URLSearchParams({ q, type: "track", limit: "10" }),
        { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await r.json();
    const tracks = (data.tracks?.items || []).map(t => ({
        id: t.id,
        name: t.name,
        artists: t.artists.map(a => a.name),
        albumArt: t.album.images[0]?.url,
    }));

    res.json({ tracks });
});

export default router;
