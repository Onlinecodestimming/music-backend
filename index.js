app.get("/search", async (req, res) => {
    try {
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

        const scRes = await fetch(url);

        // Read raw text first
        const raw = await scRes.text();

        // Detect HTML error page
        if (raw.startsWith("<")) {
            console.error("SoundCloud returned HTML instead of JSON");
            return res.status(502).json({
                error: "SoundCloud returned HTML instead of JSON",
                html: raw.slice(0, 200)
            });
        }

        // Try parsing JSON safely
        let data;
        try {
            data = JSON.parse(raw);
        } catch (err) {
            console.error("Failed to parse SoundCloud JSON:", err);
            return res.status(502).json({
                error: "Invalid JSON from SoundCloud",
                raw: raw.slice(0, 200)
            });
        }

        // Normalize results
        const items = (data.collection || []).map(track => ({
            id: track.id,
            title: track.title,
            artist: track.user?.username || "Unknown",
            artwork: track.artwork_url || track.user?.avatar_url || null,
            durationMs: track.duration
        }));

        return res.json({
            items,
            nextOffset: Number(offset) + Number(limit)
        });

    } catch (err) {
        console.error("Search crashed:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
