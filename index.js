import express from "express";
import cors from "cors";
import ytdl from "@distube/ytdl-core";

let yts;
try {
  // Safe import for CommonJS package under ESM
  const pkg = await import("yt-search").catch(e => { throw e; });
  yts = pkg.default ?? pkg;
  console.log("yt-search loaded");
} catch (err) {
  console.error("IMPORT ERROR yt-search:", err && err.stack ? err.stack : err);
  // Keep server running so logs are visible; search will return an error message
  yts = null;
}

const app = express();
app.use(cors());

app.get("/", (req, res) => res.send("Rhema Music Backend is running"));

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ items: [] });

  if (!yts) {
    console.error("SEARCH CALLED but yt-search not loaded");
    return res.status(500).json({ error: "Search engine not available" });
  }

  try {
    const r = await yts.search(q);
    const items = (r.videos || []).slice(0, 10).map(v => ({
      id: v.videoId,
      title: v.title,
      channel: v.author?.name || v.author
    }));
    res.json({ items });
  } catch (err) {
    console.error("SEARCH ERROR:", err && err.stack ? err.stack : err);
    res.status(500).json({ items: [] });
  }
});

app.get("/stream", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");
  try {
    const info = await ytdl.getInfo(id);
    let format = ytdl.chooseFormat(info.formats, { filter: "audioonly" });
    if (!format || !format.url) format = ytdl.chooseFormat(info.formats, { quality: "highestaudio" });
    if (!format || !format.url) format = info.formats.find(f => f.url);
    if (!format || !format.url) return res.status(500).send("No playable audio stream found");
    res.redirect(format.url);
  } catch (err) {
    console.error("STREAM ERROR:", err && err.stack ? err.stack : err);
    res.status(500).send("Error streaming");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
