// index.js (HLS/MP3/DASH)
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

async function scFetch(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`SoundCloud error: ${res.status}`);
    return res.json();
}

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
        console.error(err);
        res.status(500).json({ error: "Track lookup failed" });
    }
});

app.listen(PORT, () => {
    console.log(`HLS/MP3/DASH SoundCloud backend running on port ${PORT}`);
});
