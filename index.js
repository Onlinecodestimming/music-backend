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
        const scRes = await fetch(url);

        // Read raw text ALWAYS
        const raw = await scRes.text();

        // If SoundCloud returned HTML → fail gracefully
        if (raw.trim().startsWith("<")) {
            console.error("HTML returned from SoundCloud search");
            return res.status(502).json({
                error: "SoundCloud returned HTML instead of JSON",
                snippet: raw.substring(0, 300)
            });
        }

        // Try JSON parsing safely
        let data;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            console.error("JSON parse failed:", err);
            return res.status(502).json({
                error: "SoundCloud returned invalid JSON",
                snippet: raw.substring(0, 300)
            });
        }

        // If SoundCloud returned an error JSON
        if (!data || typeof data !== "object") {
            return res.status(502).json({
                error: "Unexpected SoundCloud response",
                snippet: raw.substring(0, 300)
            });
        }

        // Normalize results
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
        console.error("Search crashed:", err);
        return res.status(500).json({
            error: "Internal server error",
            details: err.message
        });
    }
});
