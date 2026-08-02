import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// basic security + CORS
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60
});
app.use(limiter);

// static frontend
app.use(express.static(path.join(__dirname, "public")));

// uploads folder
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
app.use("/uploads", express.static(uploadDir));

const upload = multer({ dest: uploadDir });

// ---------- Google Drive setup ----------

let drive = null;

function initDrive() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!b64) return;

  const json = Buffer.from(b64, "base64").toString("utf8");
  const creds = JSON.parse(json);

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  drive = google.drive({ version: "v3", auth });
}

initDrive();

// ---------- Search (Deezer) ----------

const cache = new Map();

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

  if (!deezerData.data || deezerData.data.length === 0) {
    cache.set(q, results);
    return res.json({ data: results });
  }

  for (const track of deezerData.data) {
    const name = track.title;
    const artist = track.artist && track.artist.name ? track.artist.name : "";
    const album = track.album && track.album.title ? track.album.title : null;

    let artworkUrl = null;
    if (track.album) {
      artworkUrl =
        track.album.cover_xl ||
        track.album.cover_big ||
        track.album.cover_medium ||
        track.album.cover;
    }

    const playUrl = track.preview || null;

    results.push({
      type: "songs",
      id: track.id,
      attributes: {
        name,
        artistName: artist,
        albumName: album,
        durationInMillis: (track.duration || 0) * 1000,
        artwork: {
          url: artworkUrl || null,
          width: 600,
          height: 600
        },
        playUrl,
        playable: !!playUrl
      }
    });
  }

  cache.set(q, results);
  res.json({ data: results });
});

// ---------- Stream (proxy Deezer preview) ----------

app.get("/stream", async (req, res) => {
  let url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");
  if (typeof url !== "string" || !/^https?:\/\//.test(url) || url.length > 2000)
    return res.status(400).send("Invalid URL");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range");
  res.setHeader("Cache-Control", "public, max-age=3600");

  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).send("Upstream fetch failed");
    const ctype = upstream.headers.get("content-type") || "audio/mpeg";
    res.setHeader("Content-Type", ctype);
    if (upstream.body) upstream.body.pipe(res);
    else res.end();
  } catch (e) {
    console.log("Stream fetch failed:", e);
    res.status(500).send("Failed to fetch stream");
  }
});

// ---------- Upload to local + Drive ----------

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const localPath = req.file.path;
    const filename = req.file.originalname;

    let driveFileId = null;
    if (drive && process.env.DRIVE_FOLDER_ID) {
      const resDrive = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [process.env.DRIVE_FOLDER_ID]
        },
        media: {
          mimeType: "application/octet-stream",
          body: fs.createReadStream(localPath)
        }
      });
      driveFileId = resDrive.data.id;
    }

    res.json({
      localUrl: `/uploads/${req.file.filename}`,
      driveFileId
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// ---------- List Drive files (Browse) ----------

app.get("/drive/list", async (req, res) => {
  try {
    if (!drive || !process.env.DRIVE_FOLDER_ID)
      return res.status(500).json({ error: "Drive not configured" });

    const r = await drive.files.list({
      q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, size, thumbnailLink)"
    });

    const files = (r.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      size: f.size,
      mimeType: f.mimeType,
      thumbnail: f.thumbnailLink || null,
      url: `${req.protocol}://${req.get('host')}/drive/${encodeURIComponent(f.id)}`
    }));

    res.json({ data: files });
  } catch (err) {
    console.error("Drive list error:", err);
    res.status(500).json({ error: "Failed to list Drive files" });
  }
});

// ---------- Metadata store (simple JSON) ----------
const METADATA_FILE = path.join(uploadDir, 'metadata.json');
const loadMeta = () => {
  try { return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); } catch (e) { return {}; }
};
const saveMeta = (m) => { try { fs.writeFileSync(METADATA_FILE, JSON.stringify(m, null, 2)); } catch (e) { console.error('meta save failed', e); } };

// Edit metadata for a file (local or drive id)
app.post('/drive/edit', express.json(), (req, res) => {
  const { id, albumName, artistName, artworkUrl } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const meta = loadMeta();
  meta[id] = meta[id] || {};
  if (albumName !== undefined) meta[id].albumName = albumName;
  if (artistName !== undefined) meta[id].artistName = artistName;
  if (artworkUrl !== undefined) meta[id].artworkUrl = artworkUrl;
  saveMeta(meta);
  res.json({ id, meta: meta[id] });
});

// ---------- List local uploads ----------
app.get('/upload/list', (req, res) => {
  try {
    const all = fs.readdirSync(uploadDir).filter(n => n !== 'metadata.json');
    const files = all.map(name => {
      const stat = fs.statSync(path.join(uploadDir, name));
      return {
        id: `local:${name}`,
        name,
        size: stat.size,
        url: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`,
        thumbnail: null
      };
    });
    res.json({ data: files });
  } catch (err) {
    console.error('Upload list failed', err);
    res.status(500).json({ data: [] });
  }
});

// ---------- Library endpoint (combine) ----------
app.get('/library', async (req, res) => {
  try {
    const local = fs.readdirSync(uploadDir).filter(n => n !== 'metadata.json').map(name => {
      return {
        type: 'songs',
        id: `local:${name}`,
        attributes: {
          name,
          artistName: 'Uploaded',
          albumName: null,
          durationInMillis: null,
          artwork: { url: null, width: 600, height: 600 },
          playUrl: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`,
          drive: false
        }
      };
    });

    let driveFiles = [];
    if (drive && process.env.DRIVE_FOLDER_ID) {
      try {
        const r = await drive.files.list({ q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`, fields: 'files(id,name,size,thumbnailLink)' });
        driveFiles = (r.data.files || []).map(f => ({
          type: 'songs',
          id: f.id,
          attributes: {
            name: f.name,
            artistName: 'Drive',
            albumName: null,
            durationInMillis: null,
            artwork: { url: f.thumbnailLink || null, width: 600, height: 600 },
            playUrl: `${req.protocol}://${req.get('host')}/drive/${encodeURIComponent(f.id)}`,
            drive: true
          }
        }));
      } catch (e) { console.warn('Drive list in library failed', e); }
    }

    res.json({ data: [...local, ...driveFiles] });
  } catch (e) {
    console.error('Library failed', e);
    res.status(500).json({ data: [] });
  }
});

// ---------- Stream existing Drive file ----------

app.get("/drive/:id", async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: "Drive not configured" });

    const fileId = req.params.id;

    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    // Attempt to set mime-type if available
    const meta = await drive.files.get({ fileId, fields: 'mimeType' }).catch(()=>({}));
    const mime = meta.data?.mimeType || 'application/octet-stream';
    res.setHeader("Content-Type", mime);
    driveRes.data.pipe(res);
  } catch (err) {
    console.error("Drive read error:", err);
    res.status(500).json({ error: "Failed to read Drive file" });
  }
});

// ---------- Root ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
