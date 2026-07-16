import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ytdl from "@distube/ytdl-core";

const app = express();
app.use(cors());

// YOUTUBE SEARCH (Piped API)
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ items: [] });

  try {
    const url = `https://pipedapi.kavin.rocks/search?q=${encodeURIComponent(q)}`;
    const data = await fetch(url).then(r => r.json());

    const items = data.items.map(v => ({
      id: v.id,
      title: v.title,
      channel: v.uploader
    }));

    res.json({ items });
  } catch (err) {
    console.error(err);
    res.json({ items: [] });
  }
});

// YOUTUBE STREAM
app.get("/stream", async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send("Missing id");

  try {
    const info = await ytdl.getInfo(id);
    const format = ytdl.chooseFormat(info.formats, { quality: "highestaudio" });

    res.redirect(format.url);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error streaming");
  }
});

app.listen(3000, () => console.log("Backend running on Railway"));
