import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { google } from "googleapis";

const app = express();
app.use(helmet());
app.use(cors());

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30 // limit per IP
});
app.use(limiter);

const cache = new Map();

// uploads directory for user-provided files
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

import multer from 'multer';
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const safe = Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    cb(null, safe);
  }
});
const upload = multer({ storage });

// Serve uploaded files and allow directory listing via API
app.use('/uploads', (req, res, next) => {
  // allow CORS for uploads
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.use('/uploads', express.static(UPLOADS_DIR));

// Upload endpoint (multipart/form-data field 'file')
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const localUrl = `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(req.file.filename)}`;

  // If Drive is configured, upload and return drive proxy URL
  let driveInfo = null;
  if (DRIVE_ENABLED) {
    try {
      driveInfo = await uploadToDrive(path.join(UPLOADS_DIR, req.file.filename), req.file.filename);
    } catch (e) {
      console.error('Drive upload error:', e);
    }
  }

  const driveProxy = driveInfo ? `${req.protocol}://${req.get('host')}/drive/stream?id=${encodeURIComponent(driveInfo.fileId)}` : null;

  res.json({ filename: req.file.filename, url: localUrl, drive: driveInfo ? { id: driveInfo.fileId, webViewLink: driveInfo.webViewLink, proxyUrl: driveProxy } : null });
});

// List uploaded files
app.get('/upload/list', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR).map(name => {
      const stat = fs.statSync(path.join(UPLOADS_DIR, name));
      return {
        name,
        url: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`,
        size: stat.size,
        mtime: stat.mtime
      };
    }).sort((a,b) => b.mtime - a.mtime);
    res.json({ data: files });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

// If user supplied YTDLP_COOKIES_B64 in env, write it to a temporary cookies file for yt-dlp to use
let ytdlpCookiesPath = null;
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

// Google Drive helper (service account)
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || null;
const DRIVE_ENABLED = !!(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64 && DRIVE_FOLDER_ID);

const createDriveClient = () => {
  if (!DRIVE_ENABLED) return null;
  try {
    const sa = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString());
    const jwtClient = new google.auth.JWT(sa.client_email, null, sa.private_key, ['https://www.googleapis.com/auth/drive']);
    const drive = google.drive({ version: 'v3', auth: jwtClient });
    return { drive, jwtClient, folderId: DRIVE_FOLDER_ID };
  } catch (e) {
    console.error('Failed to create Drive client:', e);
    return null;
  }
};

const uploadToDrive = async (filepath, filename) => {
  const c = createDriveClient();
  if (!c) return null;
  try {
    const { drive, jwtClient, folderId } = c;
    await jwtClient.authorize();
    const resp = await drive.files.create({
      requestBody: { name: filename, parents: [folderId] },
      media: { body: fs.createReadStream(filepath) },
      fields: 'id,webViewLink,webContentLink'
    });
    const fileId = resp.data.id;
    // make public
    try {
      await drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } });
    } catch (e) {
      console.warn('Failed to set public permission on Drive file:', e);
    }
    return { fileId, webViewLink: resp.data.webViewLink || `https://drive.google.com/uc?export=download&id=${fileId}` };
  } catch (e) {
    console.error('Drive upload failed:', e);
    return null;
  }
};

// Stream a Drive file via service account (proxies to clients)
app.get('/drive/stream', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).send('Missing id');
  const c = createDriveClient();
  if (!c) return res.status(500).send('Drive not configured');
  try {
    const { drive, jwtClient } = c;
    await jwtClient.authorize();
    const r = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });
    res.setHeader('Access-Control-Allow-Origin', '*');
    const mime = (await drive.files.get({ fileId: id, fields: 'mimeType' })).data.mimeType || 'application/octet-stream';
    res.setHeader('Content-Type', mime);
    r.data.pipe(res);
  } catch (e) {
    console.error('Drive stream failed:', e);
    res.status(502).send('Drive stream failed');
  }
});

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

  // Prefer m4a when available, fallback to other bestaudio formats. Add common flags for stability.
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
    // insert cookies flag before output
    args.unshift(ytdlpCookiesPath);
    args.unshift("--cookies");
  }

  let ytdlp = spawn("yt-dlp", args);

  let stderrBuf = "";
  const handleStderr = (data) => {
    const s = data.toString();
    stderrBuf += s;
    if (stderrBuf.length > 20000) stderrBuf = stderrBuf.slice(-20000);
    console.log("yt-dlp stderr:", s);
  };

  ytdlp.stderr.on("data", handleStderr);

  ytdlp.on("error", err => {
    console.log("yt-dlp failed:", err);
    // fallback to python -m yt_dlp when yt-dlp binary is not available
    const py = spawn("python3", ["-m", "yt_dlp", ...args]);
    py.stderr.on("data", handleStderr);
    py.stdout.pipe(res);
    py.on("error", err2 => {
      console.log("python yt_dlp failed:", err2);
      if (!res.headersSent) res.status(500).send("yt-dlp is not available on the server");
    });
    py.on("close", (code) => {
      if (code !== 0) {
        const tail = stderrBuf.split("\n").slice(-12).join("\n");
        if (!res.headersSent) res.status(502).send("yt-dlp failed: " + tail);
      }
      try { res.end(); } catch {}
    });
  });

  // Pipe stdout to client
  ytdlp.stdout.pipe(res);

  // on close, return error if non-zero
  ytdlp.on("close", (code) => {
    if (code !== 0) {
      const tail = stderrBuf.split("\n").slice(-12).join("\n");
      if (!res.headersSent) res.status(502).send("yt-dlp failed: " + tail);
      try { res.end(); } catch {}
      return;
    }
    try { res.end(); } catch {}
  });
});

app.listen(process.env.PORT || 8080, () => console.log("Backend running on port", process.env.PORT || 8080));
