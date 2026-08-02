import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import mime from "mime-types";
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
// Higher limit than Express's 100kb default — /drive/edit accepts
// base64-encoded cover images from the frontend's cover-art editor.
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

// rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60
});
app.use(limiter);

// static frontend
app.use(express.static(path.join(__dirname, "public")));

// uploads folder — used ONLY as a temporary staging area before files
// are pushed to Google Drive (the primary/permanent store). Nothing in
// here is served directly or considered durable, since Railway's disk
// is wiped on every redeploy.
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const ALLOWED_EXTENSIONS = /\.(mp3|mp4|wav|m4a|flac|ogg|aac)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    const base = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9-_]/g, "_")
      .slice(0, 60);
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `${base}-${unique}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB — adjust as needed
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_EXTENSIONS.test(file.originalname)) {
      return cb(new Error("Only mp3, mp4, wav, m4a, flac, ogg, or aac files are allowed"));
    }
    cb(null, true);
  }
});

// ---------- Google Drive setup ----------

let drive = null;

function initDrive() {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64;
  if (!b64) {
    console.warn("GOOGLE_SERVICE_ACCOUNT_JSON_B64 not set — Drive storage disabled");
    return;
  }

  const json = Buffer.from(b64, "base64").toString("utf8");
  const creds = JSON.parse(json);

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive"]
  });

  drive = google.drive({ version: "v3", auth });
}

initDrive();

// ---------- Metadata store (simple JSON, lives in uploadDir) ----------
// Note: this file is also on ephemeral disk. It caches display metadata
// (custom titles, artist/album/artwork overrides) for Drive files, but
// Drive itself remains the source of truth for which files exist. If
// this file is lost on redeploy, files still show up via drive.files.list,
// just with default names instead of your custom metadata.
const METADATA_FILE = path.join(uploadDir, "metadata.json");
const loadMeta = () => {
  try {
    return JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  } catch {
    return {};
  }
};
const saveMeta = (m) => {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(m, null, 2));
  } catch (e) {
    console.error("meta save failed", e);
  }
};

// ---------- Search (Deezer) ----------

const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (now - entry.time > CACHE_TTL_MS) cache.delete(key);
  }
}, 1000 * 60 * 5);

app.get("/search", async (req, res) => {
  let q = req.query.q;
  if (!q) return res.json({ data: [] });

  q = q.toString().trim();
  if (q.length > 200) return res.status(400).json({ error: "Query too long" });

  const cached = cache.get(q);
  if (cached) return res.json({ data: cached.data });

  const deezerUrl = "https://api.deezer.com/search?q=" + encodeURIComponent(q) + "&limit=10";

  let deezerData;
  try {
    deezerData = await fetch(deezerUrl).then(r => r.json());
  } catch {
    deezerData = { data: [] };
  }

  const results = [];

  if (!deezerData.data || deezerData.data.length === 0) {
    cache.set(q, { data: results, time: Date.now() });
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

  cache.set(q, { data: results, time: Date.now() });
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

// ---------- Upload (Drive is primary storage) ----------

app.post(
  "/upload",
  (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        console.error("Multer error:", err.message);
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    let localPath;
    try {
      if (!req.file) return res.status(400).json({ error: "No file uploaded" });

      localPath = req.file.path;
      const filename = req.body.title?.trim() || req.file.originalname;
      const artistName = req.body.artistName?.trim() || null;
      const albumName = req.body.albumName?.trim() || null;
      const artwork = req.body.artwork || req.body.artworkUrl || null;

      if (!drive || !process.env.DRIVE_FOLDER_ID) {
        fs.unlink(localPath, () => {});
        return res.status(500).json({ error: "Drive storage is not configured on the server" });
      }

      let driveFileId, driveUrl;

      try {
        const resDrive = await drive.files.create({
          requestBody: {
            name: filename,
            parents: [process.env.DRIVE_FOLDER_ID]
          },
          media: {
            mimeType: req.file.mimetype || mime.lookup(req.file.originalname) || "application/octet-stream",
            body: fs.createReadStream(localPath)
          },
          fields: "id,webViewLink,webContentLink"
        });
        driveFileId = resDrive.data.id;

        try {
          await drive.permissions.create({
            fileId: driveFileId,
            requestBody: { role: "reader", type: "anyone" }
          });
        } catch (e) {
          console.warn("Failed to set public permission on Drive file:", e.message);
        }

        // Use our own proxy route (not the raw Drive URL) so Range
        // requests work properly for audio/video seeking.
        driveUrl = `${req.protocol}://${req.get("host")}/drive/${driveFileId}`;

        const meta = loadMeta();
        meta[driveFileId] = meta[driveFileId] || {};
        meta[driveFileId].name = filename;
        meta[driveFileId].mimeType = req.file.mimetype;
        if (artistName) meta[driveFileId].artistName = artistName;
        if (albumName) meta[driveFileId].albumName = albumName;
        if (artwork) meta[driveFileId].artworkUrl = artwork;
        saveMeta(meta);
      } catch (e) {
        console.error("Drive upload failed:", e.message);
        return res.status(502).json({ error: "Upload to Drive failed" });
      } finally {
        fs.unlink(localPath, (err) => {
          if (err) console.warn("Failed to remove temp file:", err.message);
        });
      }

      res.json({ driveFileId, driveUrl });
    } catch (err) {
      console.error("Upload error:", err);
      if (localPath) fs.unlink(localPath, () => {});
      res.status(500).json({ error: "Upload failed" });
    }
  }
);

// ---------- Edit metadata for a Drive file ----------

app.post("/drive/edit", (req, res) => {
  const { id, albumName, artistName, artworkUrl, name } = req.body;
  if (!id) return res.status(400).json({ error: "Missing id" });
  const meta = loadMeta();
  meta[id] = meta[id] || {};
  if (name !== undefined) meta[id].name = name;
  if (albumName !== undefined) meta[id].albumName = albumName;
  if (artistName !== undefined) meta[id].artistName = artistName;
  if (artworkUrl !== undefined) meta[id].artworkUrl = artworkUrl;
  saveMeta(meta);
  res.json({ id, meta: meta[id] });
});

// ---------- Delete a Drive file + its metadata ----------

app.delete("/drive/:id", async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: "Drive not configured" });
    const fileId = req.params.id;

    await drive.files.delete({ fileId });

    const meta = loadMeta();
    if (meta[fileId]) {
      delete meta[fileId];
      saveMeta(meta);
    }

    res.json({ deleted: true, id: fileId });
  } catch (err) {
    console.error("Drive delete error:", err.message);
    res.status(500).json({ error: "Failed to delete Drive file" });
  }
});

// ---------- Library endpoint (Drive is the source of truth) ----------

app.get("/library", async (req, res) => {
  try {
    if (!drive || !process.env.DRIVE_FOLDER_ID) {
      return res.status(500).json({ error: "Drive not configured", data: [] });
    }

    const r = await drive.files.list({
      q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: "files(id, name, size, mimeType, thumbnailLink)"
    });

    const meta = loadMeta();

    const files = (r.data.files || []).map(f => {
      const m = meta[f.id] || {};
      return {
        type: "songs",
        id: f.id,
        attributes: {
          name: m.name || f.name,
          artistName: m.artistName || "Unknown",
          albumName: m.albumName || null,
          durationInMillis: null,
          artwork: {
            url: m.artworkUrl || f.thumbnailLink || null,
            width: 600,
            height: 600
          },
          playUrl: `${req.protocol}://${req.get("host")}/drive/${encodeURIComponent(f.id)}`,
          mimeType: f.mimeType,
          drive: true
        }
      };
    });

    res.json({ data: files });
  } catch (e) {
    console.error("Library failed", e);
    res.status(500).json({ data: [] });
  }
});

// ---------- Stream a Drive file (supports Range requests) ----------

app.get("/drive/:id", async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: "Drive not configured" });

    const fileId = req.params.id;
    const range = req.headers.range;

    const metaRes = await drive.files.get({ fileId, fields: "mimeType, size" });
    const mimeType = metaRes.data.mimeType || "application/octet-stream";
    const size = parseInt(metaRes.data.size, 10) || null;

    const opts = { responseType: "stream" };
    if (range && size) opts.headers = { Range: range };

    const driveRes = await drive.files.get({ fileId, alt: "media" }, opts);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Accept-Ranges", "bytes");

    const upstreamRange = driveRes.headers["content-range"];
    const upstreamLength = driveRes.headers["content-length"];

    if (range && upstreamRange) {
      res.status(206);
      res.setHeader("Content-Range", upstreamRange);
      if (upstreamLength) res.setHeader("Content-Length", upstreamLength);
    } else if (size) {
      res.setHeader("Content-Length", size);
    }

    driveRes.data.pipe(res);
  } catch (err) {
    console.error("Drive read error:", err.message);
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
