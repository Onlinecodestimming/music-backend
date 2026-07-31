import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const app = express();
app.use(helmet());
app.use(cors());
// Allow CORS preflight and explicit CORS headers for /stream (audio proxy)
app.options('/stream', (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  res.sendStatus(204);
});

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30 // limit per IP
});
app.use(limiter);

const cache = new Map();

// If user supplied YTDLP_COOKIES_B64 in env, write it to a temporary cookies file for yt-dlp to use
let ytdlpCookiesPath = null;

// Invidious instances used as fallbacks for YouTube audio (server proxies the audio URL)
const INVIDIOUS_INSTANCES = (process.env.INVIDIOUS_INSTANCES ? process.env.INVIDIOUS_INSTANCES.split(",") : [
  "https://yewtu.cafe",
  "https://yewtu.eu",
  "https://yewtu.snopyta.org",
  "https://yewtu.kavin.rocks",
  "https://yewtu.burnash.net"
]).map(u => u.replace(/\/$/, ""));

if (process.env.YTDLP_COOKIES_B64) {
  try {
    const buff = Buffer.from(process.env.YTDLP_COOKIES_B64, "base64");
    ytdlpCookiesPath = path.join(os.tmpdir(), "yt-cookies.txt");
    fs.writeFileSync(ytdlpCookiesPath, buff, { mode: 0o600 });
    console.log("Wrote yt-dlp cookies to", ytdlpCookiesPath);
  } catch (e) {
    console.error("Failed to write yt-dlp cookies:", e);
    ytdlpCookiesPath = null;
  }
}

app.get("/search", async (req, res) => {
  let q = req.query.q;
  if (!q) return res.json({ data: [] });

  q = q.toString().trim();
  if (q.length > 200) return res.status(400).json({ error: "Query too long" });

  if (cache.has(q)) return res.json({ data: cache.get(q) });

  const deezerUrl = "https://api.deezer.com/search?q=" + encodeURIComponent(q) + "&limit=10";

  let deezerData;
  try {
    deezerData = await fetch(deezerUrl).then(r => r.json());
  } catch {
    deezerData = { data: [] };
  }

  const results = [];

  // If no Deezer results, return empty
  if (!deezerData.data || deezerData.data.length === 0) {
    cache.set(q, results);
    return res.json({ data: results });
  }

  // Map Deezer results with preview URLs
  for (const track of deezerData.data) {
    const name = track.title;
    const artist = track.artist && track.artist.name ? track.artist.name : '';
    const album = track.album && track.album.title ? track.album.title : null;

    let artworkUrl = null;
    if (track.album) {
      artworkUrl = track.album.cover_xl || track.album.cover_big || track.album.cover_medium || track.album.cover;
    }

    // Use Deezer preview URL if available (30s MP3)
    const playUrl = track.preview || null;

    results.push({
      type: "songs",
      id: track.id,
      attributes: {
        name: name,
        artistName: artist,
        albumName: album,
        genre: null,
        releaseDate: track.release_date || null,
        durationInMillis: (track.duration || 0) * 1000,
        artwork: {
          url: artworkUrl || null,
          width: 600,
          height: 600
        },
        playUrl: playUrl,
        playable: !!playUrl
      }
    });
  }

  cache.set(q, results);
  res.json({ data: results });
});

app.get("/stream", async (req, res) => {
 let url = req.query.url;
 if (!url) return res.status(400).send("Missing URL");
 if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2000) return res.status(400).send("Invalid URL");

 // Ensure proper CORS so browsers can load proxied audio
 res.setHeader("Access-Control-Allow-Origin", "*");
 res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
 res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
 res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range");
 res.setHeader("Content-Type", "audio/mpeg");
 res.setHeader("Cache-Control", "public, max-age=3600");

 try {
   const upstream = await fetch(url);
   if (!upstream.ok) return res.status(502).send("Upstream fetch failed");
   const ctype = upstream.headers.get("content-type") || "audio/mpeg";
   res.setHeader("Content-Type", ctype);
   if (upstream.body) {
     upstream.body.pipe(res);
   } else {
     res.end();
   }
 } catch (e) {
   console.log("Stream fetch failed:", e);
   res.status(500).send("Failed to fetch stream");
 }
});

app.listen(process.env.PORT || 8080, () => console.log("Backend running on port", process.env.PORT || 8080));
