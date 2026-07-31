import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { spawn } from "child_process";

const app = express();
app.use(cors());

const cache = new Map();

app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ data: [] });

  if (cache.has(q)) return res.json({ data: cache.get(q) });

  // Apple Music metadata (iTunes API)
  const appleUrl =
    "https://itunes.apple.com/search?term=" +
    encodeURIComponent(q) +
    "&entity=song&limit=10";

  const appleData = await fetch(appleUrl).then(r => r.json());

  // If Apple Music returns nothing → fallback to YouTube-only search
  if (!appleData.results || appleData.results.length === 0) {
    console.log("Fallback to YouTube search for:", q);

    const ytUrl =
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(q);

    const html = await fetch(ytUrl).then(r => r.text());
    const jsonMatch = html.match(/ytInitialData"\s*:\s*(\{.*?\})\s*[,<]/s);

    if (!jsonMatch) return res.json({ data: [] });

    const data = JSON.parse(jsonMatch[1]);
    const items =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const results = [];

    for (const item of items) {
      const v = item.videoRenderer;
      if (!v) continue;

      results.push({
        type: "songs",
        id: v.videoId,
        attributes: {
          name: v.title?.runs?.[0]?.text,
          artistName: v.ownerText?.runs?.[0]?.text,
          albumName: "YouTube",
          genre: "Unknown",
          releaseDate: null,
          durationInMillis: 0,
          artwork: {
            url: v.thumbnail?.thumbnails?.slice(-1)[0]?.url,
            width: 600,
            height: 600
          },
          playUrl: "https://youtube.com/watch?v=" + v.videoId
        }
      });
    }

    cache.set(q, results);
    return res.json({ data: results });
  }

  // Normal Apple Music + YouTube hybrid search
  const results = [];

  for (const track of appleData.results) {
    const name = track.trackName;
    const artist = track.artistName;

    const ytUrl =
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(`${name} ${artist}`);

    const html = await fetch(ytUrl).then(r => r.text());
    const jsonMatch = html.match(/ytInitialData"\s*:\s*(\{.*?\})\s*[,<]/s);

    let youtubeUrl = null;

    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const items =
        data.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

      for (const item of items) {
        const v = item.videoRenderer;
        if (!v) continue;
        youtubeUrl = "https://youtube.com/watch?v=" + v.videoId;
        break;
      }
    }

    results.push({
      type: "songs",
      id: track.trackId,
      attributes: {
        name: track.trackName,
        artistName: track.artistName,
        albumName: track.collectionName,
        genre: track.primaryGenreName,
        releaseDate: track.releaseDate,
        durationInMillis: track.trackTimeMillis,
        artwork: {
          url: track.artworkUrl100.replace("100x100", "600x600"),
          width: 600,
          height: 600
        },
        playUrl: youtubeUrl
      }
    });
  }

  cache.set(q, results);
  res.json({ data: results });
});

app.get("/stream", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");

  const ytdlp = spawn("/usr/bin/yt-dlp", [
    "--no-check-certificate",
    "--user-agent",
    "Mozilla/5.0",
    "-f",
    "bestaudio",
    "-o",
    "-",
    url
  ]);

  ytdlp.on("error", err => {
    console.log("yt-dlp failed:", err);
    res.status(500).send("yt-dlp is not installed");
  });

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on("data", () => {});
  ytdlp.on("close", () => {
    try { res.end(); } catch {}
  });
});

app.listen(8080, () => console.log("Backend running"));
