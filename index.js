import express from "express";
import { spawn } from "child_process";
import cors from "cors";

const app = express();
app.use(cors());

// STREAM ENDPOINT
app.get("/stream", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  const ytdlp = spawn("yt-dlp", [
    "-f", "bestaudio",
    "-o", "-",
    url
  ]);

  res.setHeader("Content-Type", "audio/mpeg");

  ytdlp.stdout.pipe(res);

  ytdlp.stderr.on("data", d => console.log("yt-dlp:", d.toString()));
});

// SIMPLE SEARCH ENDPOINT (YouTube API or your own)
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  // You can plug in ANY search API here
  // YouTube Data API, Piped API, your own DB, etc.
  res.json([
    {
      title: "Royalty Free Lofi Beat",
      videoId: "abc123",
      url: "https://youtube.com/watch?v=abc123"
    }
  ]);
});

app.listen(8080, () => console.log("Backend running"));
