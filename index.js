import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// ENV VARIABLES
// ===============================
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("ERROR: Missing Spotify credentials in Railway!");
}

// ===============================
// TOKEN CACHE
// ===============================
let spotifyToken = null;
let spotifyTokenExpires = 0;

// ===============================
// GET SPOTIFY TOKEN (FREE)
// ===============================
async function getSpotifyToken() {
    // Use cached token if still valid
    if (spotifyToken && Date.now() < spotifyTokenExpires) {
        return spotifyToken;
    }

    // Request new token
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

    const raw = await res.text();
    console.log("Spotify token response:", raw);

    let data;
    try {
        data = JSON.parse(raw);
    } catch (err) {
        console.error("Failed to parse token JSON:", err);
        throw new Error("Invalid Spotify credentials");
    }

    if (!data.access_token) {
        console.error("Spotify error:", data);
        throw new Error("Spotify rejected credentials");
    }

    spotifyToken = data.access_token;
    spotifyTokenExpires = Date.now() + data.expires_in * 1000;

    return spotifyToken;
}

// ===============================
// SEARCH ROUTE
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

        const raw = await r.text();
        console.log("Spotify search response:", raw);

        let data;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            console.error("Failed to parse search JSON:", err);
            return res.status(500).json({
                error: "Spotify search returned invalid JSON",
                raw,
            });
        }

        if (!data.tracks || !data.tracks.items) {
            console.error("Spotify search error:", data);
            return res.status(500).json({
                error: "Spotify search failed",
                details: data,
            });
        }

        const tracks = data.tracks.items.map((t) => ({
            id: t.id,
            name: t.name,
            artists: t.artists.map((a) => a.name),
            albumArt: t.album.images[0]?.url,
        }));

        res.json({ tracks });
    } catch (err) {
        console.error("Backend error:", err);
        res.status(500).json({
            error: "Server crashed",
            details: err.toString(),
        });
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
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("Backend running on port", PORT);
});
