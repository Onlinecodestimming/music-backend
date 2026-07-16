import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";
import yts from "yt-search";

const app = express();
app.use(cors());

// HOME ROUTE (optional)
app.get("/", (req, res) => {
  res.send("Rhema Music Backend is running");
});

// SEARCH ROUTE
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ items: [] });

  try {
    const r = await yts(q);

    const items = r.videos.slice(0, 10).map(v => ({
      id: v.videoId,
      title: v.title,
      channel: v.author.name
    }));

    res.json({ items });
  } catch (err) {
    console.error("SEARCH ERROR:", err);
    res.json({ items: [] });
  }
});

// STREAM ROUTE
app.get("/stream", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");

  try {
    const info = await ytdl.getInfo(id);

    // Try audio-only formats first
    let format = ytdl.chooseFormat(info.formats, { filter: "audioonly" });

    // Fallback: highest audio quality
    if (!format || !format.url) {
      format = ytdl.chooseFormat(info.formats, { quality: "highestaudio" });
    }

    // Final fallback: ANY playable format
    if (!format || !format.url) {
      format = info.formats.find(f => f.url);
    }

    if (!format || !format.url) {
      return res.status(500).send("No playable audio stream found");
    }

    res.redirect(format.url);
  } catch (err) {
    console.error("STREAM ERROR:", err);
    res.status(500).send("Error streaming");
  }
});

// START SERVER
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
