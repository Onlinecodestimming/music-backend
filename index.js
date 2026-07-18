// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// Your working SoundCloud client_id
const CLIENT_ID = "emAJdGEj1mm9yjoCD2jkixmgqrGIyfpi";

app.use(cors({ origin: "*", methods: ["GET"] }));
app.use(express.json());

// Safe fetch wrapper
async function scFetch(url) {
    const res = await fetch(url);
    const raw = await res.text();

    // HTML = Cloudflare / SoundCloud error page
    if (raw.trim().startsWith("<")) {
        throw new Error("SoundCloud returned HTML instead of JSON");
    }

    try {
        return JSON.parse(raw);
    } catch {
        throw new Error("SoundCloud returned invalid JSON");
    }
}

/* -------------------------------------------------------
   SEARCH ENDPOINT (CRASH-PROOF)
------------------------------------------------------- */
app.get("/search", async (req, res) => {
    const q = req.query.q || "";
    const limit = req.query.limit || "20";
    const offset = req.query.offset || "0";

    const params = new URLSearchParams({
        q,
        client_id: CLIENT_ID,
        limit,
        offset,
        app_version: "1784221259",
        app_locale: "en",
        variant_ids: "core"
    });

    const url = `https://api-v2.soundcloud.com/search/tracks?${params.toString()}`;

    try {
        const data = await scFetch(url);

        const items = Array.isArray(data.collection)
            ? data.collection.map(track => ({
                  id: track.id,
                  title: track.title,
                  artist: track.user?.username || "Unknown",
                  artwork: track.artwork_url || track.user?.avatar_url || null,
                  durationMs: track.duration
              }))
            : [];

        return res.json({
            items,
            nextOffset: Number(offset) + Number(limit)
        });

    } catch (err) {
        console.error("Search error:", err.message);
        return res.status(502).json({
            error: "SoundCloud search failed",
            details: err.message
        });
    }
});

/* -------------------------------------------------------
   TRACK RESOLVER (HLS → MP3 → DASH fallback)
------------------------------------------------------- */
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
                protocol: null,
                error: "No playable formats available"
            });
        }

        const resolveUrl = chosen.url + `?client_id=${CLIENT_ID}`;
        const resolved = await scFetch(resolveUrl);

        return res.json({
            id,
            title: track.title,
            artist: track.user?.username,
            url: resolved.url,
            protocol: chosen.format.protocol
        });

    } catch (err) {
        console.error("Track error:", err.message);
        return res.status(502).json({
            error: "Track lookup failed",
            details: err.message
        });
    }
});

/* -------------------------------------------------------
   START SERVER
------------------------------------------------------- */
app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
