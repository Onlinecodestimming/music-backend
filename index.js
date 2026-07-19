import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// SPOTIFY CLIENT CREDENTIALS
// ===============================
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let spotifyToken = null;
let spotifyTokenExpires = 0;

// ===============================
// GET SPOTIFY TOKEN (FREE)
// ===============================
async function getSpotifyToken() {
    if (spotifyToken && Date.now() < spotifyTokenExpires) {
        return spotifyToken;
    }

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization:
                "Basic " +
                Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
    });

    const data = await res.json();
    spotifyToken = data.access_token;
    spotifyTokenExpires = Date.now() + data.expires_in * 1000;

    return spotifyToken;
}

// ===============================
// SPOTIFY SEARCH ROUTE
// ===============================
app.get("/api/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });

    try {
        const token = await getSpotifyToken();

        const r = await fetch(
            "https://api.spotify.com/v1/search?" +
                new URLSearchParams({
                    q,
                    type: "track",
                    limit: "10",
                }),
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        );

        const data = await r.json();

        const tracks = (data.tracks?.items || []).map((t) => ({
            id: t.id,
            name: t.name,
            artists: t.artists.map((a) => a.name),
            albumArt: t.album.images[0]?.url,
        }));

        res.json({ tracks });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Search failed" });
    }
});

// ===============================
// ROOT
// ===============================
app.get("/", (req, res) => {
    res.send("Hybrid backend running");
});

// ===============================
// START SERVER
// ===============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("Backend running on port", PORT);
});
