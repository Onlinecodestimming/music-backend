import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";

const app = express();
app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30 // limit per IP
});
app.use(limiter);

const cache = new Map();

app.get("/search", async (req, res) => {
  let q = req.query.q;
  if (!q) return res.json({ data: [] });

  q = q.toString().trim();
  if (q.length > 200) return res.status(400).json({ error: "Query too long" });

  if (cache.has(q)) return res.json({ data: cache.get(q) });

  const appleUrl =
    "https://itunes.apple.com/search?term=" +
    encodeURIComponent(q) +
    "&entity=song&limit=10";

  let appleData;
  try {
    appleData = await fetch(appleUrl).then(r => r.json());
  } catch {
    appleData = { results: [] };
  }

  const ytSearch = async (query) => {
    const ytUrl =
      "https://www.youtube.com/results?search_query=" +
      encodeURIComponent(query);

    const html = await fetch(ytUrl).then(r => r.text());
    const jsonMatch = html.match(/ytInitialData"\s*:\s*(\{.*?\})\s*[,<]/s);
    if (!jsonMatch) return [];

    const data = JSON.parse(jsonMatch[1]);
    const items =
      data.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents || [];

    const out = [];

    for (const item of items) {
      const v = item.videoRenderer;
      if (!v) continue;

      out.push({
        type: "songs",
        id: v.videoId,
        attributes: {
          name: v.title?.runs?.[0]?.text || query,
          artistName: v.ownerText?.runs?.[0]?.text || "Unknown Artist",
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

    return out;
  };

  // Apple Music returned nothing → YouTube fallback
  if (!appleData.results || appleData.results.length === 0) {
    const ytResults = await ytSearch(q);
    cache.set(q, ytResults);
    return res.json({ data: ytResults });
  }

  // Apple Music results → attach YouTube stream
  const results = [];

  for (const track of appleData.results) {
    const name = track.trackName;
    const artist = track.artistName;

    const ytResults = await ytSearch(`${name} ${artist}`);
    const best = ytResults[0];

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
        playUrl: best ? best.attributes.playUrl : null
      }
    });
  }

  cache.set(q, results);
  res.json({ data: results });
});

app.get("/stream", (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2000) return res.status(400).send("Invalid URL");

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");
  res.setHeader("Accept-Ranges", "none");

  const args = ["-f", "bestaudio", "-o", "-", url];
  let ytdlp = spawn("yt-dlp", args);
n  ytdlp.on("error", err => {
    console.log("yt-dlp failed:", err);
    // fallback to python -m yt_dlp when yt-dlp binary is not available
    const py = spawn("python", ["-m", "yt_dlp", ...args]);
    py.on("error", err2 => {
      console.log("python yt_dlp failed:", err2);
      res.status(500).send("yt-dlp is not available on the server");
    });
    py.stdout.pipe(res);
    py.stderr.on("data", d => console.log("yt-dlp stderr:", d.toString()));
    py.on("close", () => { try { res.end(); } catch {} });
  });

  ytdlp.stdout.pipe(res);
n  ytdlp.stderr.on("data", data => {
    console.log("yt-dlp stderr:", data.toString());
  });

  ytdlp.on("close", () => {
    try { res.end(); } catch {}
  });
});

app.listen(process.env.PORT || 8080, () => console.log("Backend running on port", process.env.PORT || 8080));
