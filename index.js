import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";
import pkg from "yt-search";

const yts = pkg;

const app = express();
app.use(cors());

// HOME ROUTE
app.get("/", (req, res) => {
  res.send("Rhema Music Backend is running");
});

// SEARCH ROUTE
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ items: [] });

  try {
    const r = await yts.search(q);

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

    let format = ytdl.chooseFormat(info.formats, { filter: "audioonly" });

    if (!format || !format.url) {
      format = ytdl.chooseFormat(info.formats, { quality: "highestaudio" });
    }

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
