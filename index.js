import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// ===============================
// iTunes Search Route
// ===============================
app.get("/api/search", async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });

    try {
        const r = await fetch(
            "https://itunes.apple.com/search?" +
                new URLSearchParams({
                    term: q,
                    media: "music",
                    limit: "10",
                })
        );

        const data = await r.json();

        const tracks = data.results.map((t) => ({
            id: t.trackId,
            name: t.trackName,
            artists: [t.artistName],
            albumArt: t.artworkUrl100?.replace("100x100", "600x600"),
            preview: t.previewUrl,
        }));

        res.json({ tracks });
    } catch (err) {
        console.error("Backend error:", err);
        res.status(500).json({ error: "Search failed" });
    }
});

// ===============================
// Root
// ===============================
app.get("/", (req, res) => {
    res.send("Hybrid iTunes backend running");
});

// ===============================
// Start Server
// ===============================
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("Backend running on port", PORT);
});
