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

  const ytSearch = async (query) => {
    // Use yt-dlp's ytsearch to reliably find YouTube results instead of scraping HTML
    return new Promise((resolve) => {
      try {
        const args = ["--no-warnings", "--dump-json", "ytsearch10:" + query];
        // include cookies if available
        if (ytdlpCookiesPath) {
          args.unshift(ytdlpCookiesPath);
          args.unshift("--cookies");
        }
        const proc = spawn("yt-dlp", args);
        let outBuf = "";
        let errBuf = "";
        proc.stdout.on("data", d => { outBuf += d.toString(); });
        proc.stderr.on("data", d => { errBuf += d.toString(); });
        proc.on("close", () => {
          if (!outBuf || outBuf.trim().length === 0) {
            console.log("yt-dlp search produced no output, stderr:", errBuf);
            return resolve([]);
          }
          const lines = outBuf.trim().split(/\r?\n/);
          const out = [];
          for (const line of lines) {
            try {
              const v = JSON.parse(line);
              const id = v.id || v.video_id || v.webpage_url?.split('v=')?.pop();
              out.push({
                type: "songs",
                id: id,
                attributes: {
                  name: v.title || query,
                  artistName: v.uploader || v.channel || "Unknown Artist",
                  albumName: "YouTube",
                  genre: "Unknown",
                  releaseDate: v.upload_date || null,
                  durationInMillis: v.duration ? Math.floor(v.duration * 1000) : 0,
                  artwork: { url: v.thumbnail || null, width: 600, height: 600 },
                  playUrl: id ? "https://youtube.com/watch?v=" + id : (v.webpage_url || null)
                }
              });
            } catch (e) {
              console.log("Failed to parse yt-dlp json line:", e, line.slice(0,200));
            }
          }
          resolve(out);
        });
        // safety: kill after 12s
        setTimeout(() => { try { proc.kill(); } catch {} }, 12000);
      } catch (e) {
        console.log("ytSearch spawn failed:", e);
        resolve([]);
      }
    });
  };

  // Deezer returned nothing → YouTube fallback
  if (!deezerData.data || deezerData.data.length === 0) {
    const ytResults = await ytSearch(q);
    cache.set(q, ytResults);
    return res.json({ data: ytResults });
  }

  // Deezer results → attach YouTube stream
  const results = [];

  // helper: try a fast yt-dlp ytsearch1 for a single reliable result, with timeout
  const findYtPlayUrl = async (query, timeoutMs = 7000) => {
    return new Promise((resolve) => {
      try {
        const args = ["--no-warnings", "--dump-json", "ytsearch1:" + query];
        // include cookies if available
        if (ytdlpCookiesPath) args.unshift(ytdlpCookiesPath), args.unshift("--cookies");
        const proc = spawn("yt-dlp", args);
        let out = "";
        let err = "";
        proc.stdout.on("data", d => out += d.toString());
        proc.stderr.on("data", d => err += d.toString());
        const kill = setTimeout(() => { try { proc.kill(); } catch {} }, timeoutMs);
        proc.on("close", () => {
          clearTimeout(kill);
          if (!out) {
            console.log("ytsearch produced no output for:", query, "err:", err.slice(0,200));
            return resolve(null);
          }
          try {
            const v = JSON.parse(out.trim().split(/\r?\n/)[0]);
            const id = v.id || v.video_id || (v.webpage_url && v.webpage_url.split('v=')?.pop());
            if (id) return resolve("https://youtube.com/watch?v=" + id);
            return resolve(v.webpage_url || null);
          } catch (e) {
            console.log("failed parse ytsearch json:", e, out.slice(0,200));
            return resolve(null);
          }
        });
      } catch (e) {
        console.log("findYtPlayUrl spawn failed:", e);
        resolve(null);
      }
    });
  };

  // Try Invidious instances to find a direct audio URL for a query
  const findInvidiousPlayUrl = async (query, timeoutMs = 3000) => {
    for (const inst of INVIDIOUS_INSTANCES) {
      try {
        const sUrl = `${inst}/api/v1/search?q=${encodeURIComponent(query)}&type=video&per_page=1`;
        const sr = await fetch(sUrl).then(r => { if (!r.ok) throw new Error('bad'); return r.json(); }).catch(() => null);
        if (!sr) continue;
        // support multiple search response shapes
        let first = null;
        if (Array.isArray(sr) && sr.length > 0) first = sr[0];
        else if (Array.isArray(sr.data) && sr.data.length > 0) first = sr.data[0];
        else if (Array.isArray(sr.videos) && sr.videos.length > 0) first = sr.videos[0];
        if (!first) continue;
        const vid = first.videoId || first.id || first.videoId || first.videoId;
        if (!vid) continue;
        const vinfoUrl = `${inst}/api/v1/videos/${vid}`;
        const vinfo = await fetch(vinfoUrl).then(r => { if (!r.ok) throw new Error('bad'); return r.json() }).catch(() => null);
        if (!vinfo) continue;
        const fmts = vinfo.formats || vinfo.formats || vinfo.adaptiveFormats || vinfo.playlist || (vinfo.videoDetails && vinfo.videoDetails.formats) || null;
        if (!fmts || !Array.isArray(fmts)) continue;
        // prefer audio-only formats
        let candidate = fmts.find(f => ((f.mimeType && /audio/.test(f.mimeType)) || (f.type && /audio/.test(f.type))) && f.url) || fmts.find(f => f.url);
        if (candidate && candidate.url) return candidate.url;
      } catch (e) {
        // try next instance
      }
    }
    return null;
  };

  const queries = [];
  for (const track of deezerData.data) {
    const name = track.title;
    const artist = track.artist && track.artist.name ? track.artist.name : '';
    const album = track.album && track.album.title ? track.album.title : null;

    // prefer the HTML ytSearch results if present
    let ytResults = await ytSearch(`${name} ${artist}`);
    let best = ytResults[0];
    let playUrl = best ? best.attributes.playUrl : null;

    // store query list and provisional result
    queries.push({ query: `${name} ${artist}`, playUrl });

    // choose best artwork available
    let artworkUrl = null;
    if (track.album) {
      artworkUrl = track.album.cover_xl || track.album.cover_big || track.album.cover_medium || track.album.cover;
    }

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
        playUrl: playUrl || null,
        playable: !!playUrl
      }
    });
  }

  // Run parallel short yt-dlp searches for items without playUrl (keeps latency bounded)
  const tasks = queries.map((qObj, idx) => {
    if (qObj.playUrl) return Promise.resolve(null);
    return findYtPlayUrl(qObj.query, 3000);
  });

  try {
    const settled = await Promise.allSettled(tasks);
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'fulfilled' && s.value) {
        results[i].attributes.playUrl = s.value;
        results[i].attributes.playable = true;
      }
    }
  } catch (e) {
    console.log('Parallel ytsearch failed:', e);
  }

  // For any remaining items without playUrl, try Invidious instances as a fallback
  const tryInvidiousTasks = results.map(async (r) => {
    if (r.attributes && r.attributes.playUrl) return null;
    const qstr = `${r.attributes.name} ${r.attributes.artistName}`;
    try {
      const inUrl = await findInvidiousPlayUrl(qstr, 3000);
      if (inUrl) {
        r.attributes.playUrl = inUrl;
        r.attributes.playable = true;
      }
    } catch (e) {
      // ignore
    }
    return null;
  });

  try {
    await Promise.allSettled(tryInvidiousTasks);
  } catch (e) {
    console.log('Invidious fallback failed:', e);
  }

  cache.set(q, results);
  res.json({ data: results });
});

app.get("/stream", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2000) return res.status(400).send("Invalid URL");

 // If the URL is a direct audio file or from an Invidious instance, proxy it directly
 const isDirectAudio = /\.(mp3|m4a|aac|ogg|webm)(\?|$)/i.test(url) || INVIDIOUS_INSTANCES.some(inst => url.startsWith(inst));
 if (isDirectAudio) {
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
     return;
   } catch (e) {
     console.log("Direct audio fetch failed:", e);
     // fall through to yt-dlp fallback
   }
 }

 // Use yt-dlp for YouTube/other URLs
 res.setHeader("Content-Type", "audio/mpeg");
 res.setHeader("Transfer-Encoding", "chunked");
 res.setHeader("Accept-Ranges", "none");

 const baseArgs = [
   "-f", "bestaudio[ext=m4a]/bestaudio/best",
   "--no-playlist",
   "--geo-bypass",
   "--no-check-certificate",
   "--user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36",
   "-o", "-",
   url
 ];

 const args = Array.from(baseArgs);
 if (ytdlpCookiesPath) {
   args.unshift(ytdlpCookiesPath);
   args.unshift("--cookies");
 }

 let ytdlp = spawn("yt-dlp", args);

 ytdlp.on("error", err => {
   console.log("yt-dlp spawn failed:", err);
   // fallback to python -m yt_dlp when yt-dlp binary is not available
   const py = spawn("python", ["-m", "yt_dlp", ...args]);
   py.on("error", err2 => {
     console.log("python yt_dlp spawn failed:", err2);
     if (!res.headersSent) {
       res.status(500).send("yt-dlp is not available");
     } else {
       res.end();
     }
   });
   py.stdout.pipe(res);
   py.stderr.on("data", d => console.log("python yt_dlp stderr:", d.toString().slice(0, 200)));
   py.on("close", () => { try { res.end(); } catch {} });
 });

 ytdlp.stdout.pipe(res);

 ytdlp.stderr.on("data", data => {
   console.log("yt-dlp stderr:", data.toString().slice(0, 200));
 });

 ytdlp.on("close", () => {
   try { res.end(); } catch {}
 });
});

app.listen(process.env.PORT || 8080, () => console.log("Backend running on port", process.env.PORT || 8080));
