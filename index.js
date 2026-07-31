import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { spawn } from "child_process";

const app = express();
app.use(cors());

const API_KEY = process.env.SERPAPI_KEY;
const cache = new Map();

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  if (cache.has(q)) return res.json(cache.get(q));

  const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(q)}&api_key=${API_KEY}`;
  const r = await fetch(url);
  const data = await r.json();

  const results = (data.video_results || []).map(v => ({
    title: v.title,
    videoId: v.video_id,
    url: v.link,
    thumbnail: v.thumbnail,
    channel: v.channel,
    duration: v.duration
  }));

  cache.set(q, results);
  res.json(results);
});

app.get("/stream", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  const ytdlp = spawn("yt-dlp", ["-f", "bestaudio", "-o", "-", url]);

  res.setHeader("Content-Type", "audio/mpeg");
  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on("data", d => console.log("yt-dlp:", d.toString()));
});

app.listen(8080, () => console.log("Backend running"));
