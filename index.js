import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import { spawn } from "child_process";

const app = express();
app.use(cors());

// Cache to avoid repeated searches
const cache = new Map();

/*
|--------------------------------------------------------------------------
| APPLE MUSIC METADATA + YOUTUBE STREAMING SEARCH
|--------------------------------------------------------------------------
| This endpoint:
| 1. Fetches REAL metadata from Apple Music (via iTunes API)
| 2. Searches YouTube for the best matching video
| 3. Returns Apple-Music-style objects with YouTube play URLs
|--------------------------------------------------------------------------
*/
app.get("/search", async (req, res) => {
  const q = req.query.q;
  if (!q) return res.json({ data: [] });

  if (cache.has(q)) return res.json({ data: cache.get(q) });

  // 1. Apple Music metadata (iTunes API)
  const appleUrl =
    "https://itunes.apple.com/search?term=" +
    encodeURIComponent(q) +
    "&entity=song&limit=10";

  const appleData = await fetch(appleUrl).then((r) => r.json());

  const results = [];

  for (const track of appleData.results) {
    const name = track.trackName;
    const artist = track.artistName;

    // 2. YouTube search for streaming
    const ytUrl =
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(`${name} ${artist}`);

    const html = await fetch(ytUrl).then((r) => r.text());
    const jsonMatch = html.match(/ytInitialData"\s*:\s*(\{.*?\})\s*[,<]/s);

    let youtubeUrl = null;

    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const items =
        data.contents?.twoColumnSearchResultsRenderer?.primaryContents
          ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents ||
        [];

      for (const item of items) {
        const v = item.videoRenderer;
        if (!v) continue;
        youtubeUrl = "https://youtube.com/watch?v=" + v.videoId;
        break;
      }
    }

    // 3. Apple Music–style object
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
          height: 600,
        },
        playUrl: youtubeUrl, // YouTube streaming
      },
    });
  }

  cache.set(q, results);
  res.json({ data: results });
});

/*
|--------------------------------------------------------------------------
| STREAM ENDPOINT (YouTube → yt-dlp → audio)
|--------------------------------------------------------------------------
| This streams audio directly from YouTube using yt-dlp.
|--------------------------------------------------------------------------
*/
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
    url,
  ]);

  ytdlp.on("error", (err) => {
    console.log("yt-dlp failed:", err);
    res.status(500).send("yt-dlp is not installed");
  });

  ytdlp.stdout.pipe(res);
  ytdlp.stderr.on("data", () => {});
  ytdlp.on("close", () => {
    try {
      res.end();
    } catch {}
  });
});

/*
|--------------------------------------------------------------------------
| START SERVER
|--------------------------------------------------------------------------
*/
app.listen(8080, () => console.log("Backend running"));
