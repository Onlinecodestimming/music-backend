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
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  HeadObjectCommand
} from "@aws-sdk/client-s3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

// Railway sits behind a proxy — tell Express to trust the X-Forwarded-For
// header so express-rate-limit can correctly identify clients instead of
// throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request.
app.set("trust proxy", 1);

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
// are pushed to R2 (the primary/permanent store). Nothing here is
// served directly or considered durable.
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

// ---------- Cloudflare R2 setup ----------
// R2 is S3-compatible, so the standard AWS SDK v3 S3 client works
// against it directly — just point endpoint at the R2 account URL.

let s3 = null;
const R2_BUCKET = process.env.R2_BUCKET_NAME;

function initR2() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey || !R2_BUCKET) {
    console.warn("R2 env vars incomplete — storage disabled. Need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME");
    return;
  }

  s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  });
}

initR2();

const AUDIO_VIDEO_EXT = /\.(mp3|mp4|wav|m4a|flac|ogg|aac|mov|mkv|webm)$/i;
const IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif)$/i;

/**
 * Groups a flat list of S3 objects by their "album folder" — i.e. everything
 * before the last slash in the key. Files sitting at the bucket root (no
 * slash) are grouped under an empty-string folder path.
 *
 * For each folder, picks a cover image: prefers a file literally named
 * "cover.*", falls back to the first image found in that folder, falls
 * back to null (frontend shows a placeholder).
 *
 * Returns { tracks: [{...S3 object, _folderPath, _coverKey}], covers: {folderPath: coverObjectKey} }
 */
function groupByAlbumFolder(objects) {
  const folders = new Map(); // folderPath -> { tracks: [], images: [] }

  for (const obj of objects) {
    const key = obj.Key;
    if (key === METADATA_R2_KEY) continue; // skip our own metadata backup file

    const lastSlash = key.lastIndexOf("/");
    const folderPath = lastSlash === -1 ? "" : key.substring(0, lastSlash);

    if (!folders.has(folderPath)) folders.set(folderPath, { tracks: [], images: [] });
    const bucket = folders.get(folderPath);

    if (AUDIO_VIDEO_EXT.test(key)) {
      bucket.tracks.push(obj);
    } else if (IMAGE_EXT.test(key)) {
      bucket.images.push(obj);
    }
  }

  const covers = {};
  for (const [folderPath, { images }] of folders.entries()) {
    if (images.length === 0) continue;
    const named = images.find(img => /(^|\/)cover\.(jpg|jpeg|png|webp|gif)$/i.test(img.Key));
    covers[folderPath] = (named || images[0]).Key;
  }

  const tracks = [];
  for (const [folderPath, { tracks: folderTracks }] of folders.entries()) {
    for (const t of folderTracks) {
      tracks.push({ ...t, _folderPath: folderPath, _coverKey: covers[folderPath] || null });
    }
  }

  return { tracks, covers };
}

// ---------- Metadata store (simple JSON, lives in uploadDir) ----------
// Caches display metadata (custom titles, artist/album/artwork overrides,
// original filename, mimeType, size) keyed by the R2 object key. This file
// is on ephemeral disk, so it's also mirrored into R2 itself as a backup
// object (metadata.json) and reloaded from there on startup if the local
// copy is missing — this way a Railway redeploy doesn't wipe your titles.
const METADATA_FILE = path.join(uploadDir, "metadata.json");
const METADATA_R2_KEY = "_metadata.json";

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
  // best-effort mirror to R2; failures here shouldn't break the request
  if (s3) {
    s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: METADATA_R2_KEY,
      Body: JSON.stringify(m, null, 2),
      ContentType: "application/json"
    })).catch(e => console.warn("metadata R2 mirror failed:", e.message));
  }
};

async function restoreMetaFromR2() {
  if (!s3) return;
  try {
    const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: METADATA_R2_KEY });
    const res = await s3.send(cmd);
    const body = await res.Body.transformToString();
    fs.writeFileSync(METADATA_FILE, body);
    console.log("Restored metadata.json from R2");
  } catch (e) {
    // no remote metadata yet, or first run — not an error
    console.log("No existing metadata.json in R2 (fine on first run)");
  }
}
await restoreMetaFromR2();

// ---------- Cloudflare R2 (S3-compatible) setup ----------
let r2Client = null;
const { S3Client, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');

function initR2() {
  const key = process.env.R2_ACCESS_KEY_ID || process.env.R2_KEY_ID || process.env.R2_KEY;
  const secret = process.env.R2_SECRET_ACCESS_KEY || process.env.R2_KEY_SECRET || process.env.R2_SECRET;
  const endpoint = process.env.R2_ENDPOINT; // e.g. https://<account>.r2.cloudflarestorage.com
  const bucket = process.env.R2_BUCKET;
  if (!key || !secret || !endpoint || !bucket) return;

  r2Client = new S3Client({
    endpoint,
    region: 'auto',
    credentials: { accessKeyId: key, secretAccessKey: secret },
    forcePathStyle: false
  });
  r2Client._r2Bucket = bucket;
}

initR2();

// Simple admin middleware: check Authorization: Bearer <ADMIN_TOKEN>
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
function isAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(403).json({ error: 'Admin not configured' });
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.admin_token || null);
  if (token === ADMIN_TOKEN) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

// Helper: stream S3 object (supports Range)
async function streamR2Object(req, res, key) {
  if (!r2Client) return res.status(500).json({ error: 'R2 not configured' });
  const range = req.headers.range;
  const params = { Bucket: r2Client._r2Bucket, Key: key };
  if (range) params.Range = range;
  try {
    const cmd = new GetObjectCommand(params);
    const data = await r2Client.send(cmd);
    // data.Body is a stream
    // set headers
    if (data.ContentType) res.setHeader('Content-Type', data.ContentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type');
    if (range) res.status(206);
    data.Body.pipe(res);
  } catch (e) {
    console.error('R2 get object failed', e);
    res.status(502).json({ error: 'R2 fetch failed' });
  }
}

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

// ---------- Upload (R2 is primary storage) ----------

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const localPath = req.file.path;
    const filename = req.body.title?.trim() || req.file.originalname;
    const artwork = req.body.artwork || req.body.artworkUrl || null;
    const artistName = req.body.artistName || null;
    const albumName = req.body.albumName || null;

    let driveFileId = null;
    let driveUrl = null;
    let r2Key = null;
    let r2Url = null;

    // Upload to R2 if configured
    if (r2Client) {
      try {
        // generate dest key: uploads/<timestamp>-originalname
        const destKey = `uploads/${Date.now()}-${req.file.originalname}`;
        await uploadToR2(localPath, destKey, req.file.mimetype || 'application/octet-stream');
        r2Key = destKey;
        r2Url = `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(destKey)}`;
        // store metadata
        const meta = loadMeta();
        meta[`r2:${destKey}`] = meta[`r2:${destKey}`] || {};
        meta[`r2:${destKey}`].name = filename;
        if (artwork) meta[`r2:${destKey}`].artworkUrl = artwork;
        if (artistName) meta[`r2:${destKey}`].artistName = artistName;
        if (albumName) meta[`r2:${destKey}`].albumName = albumName;
        saveMeta(meta);
      } catch (e) {
        console.error('R2 upload failed', e);
      }
    }

    // If Drive configured, upload and try to make public; save metadata mapping
    if (drive && process.env.DRIVE_FOLDER_ID) {
      try {
        const resDrive = await drive.files.create({
          requestBody: {
            name: filename,
            parents: [process.env.DRIVE_FOLDER_ID]
          },
          media: {
            mimeType: req.file.mimetype || "application/octet-stream",
            body: fs.createReadStream(localPath)
          },
          fields: 'id,webViewLink,webContentLink'
        });
        driveFileId = resDrive.data.id;
        // attempt to set public permission so direct download URL can be used
        try {
          await drive.permissions.create({ fileId: driveFileId, requestBody: { role: 'reader', type: 'anyone' } });
          driveUrl = `https://drive.google.com/uc?export=download&id=${driveFileId}`;
        } catch (e) {
          console.warn('Failed to set public permission on Drive file', e);
          // fallback to proxy URL
          driveUrl = `${req.protocol}://${req.get('host')}/drive/${driveFileId}`;
        }

        // store metadata
        const meta = loadMeta();
        meta[driveFileId] = meta[driveFileId] || {};
        meta[driveFileId].name = filename;
        if (artwork) meta[driveFileId].artworkUrl = artwork;
        if (artistName) meta[driveFileId].artistName = artistName;
        if (albumName) meta[driveFileId].albumName = albumName;
        saveMeta(meta);
      } catch (e) {
        console.error('Drive upload failed:', e);
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

      if (!s3 || !R2_BUCKET) {
        fs.unlink(localPath, () => {});
        return res.status(500).json({ error: "R2 storage is not configured on the server" });
      }

      const ext = path.extname(req.file.originalname) || "";
      const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

      // If an album name is given, upload into that folder so it groups
      // with any other tracks (and cover image) sharing the same album.
      // Sanitized to prevent path traversal (../) and to keep keys clean.
      const safeAlbumFolder = albumName
        ? albumName.replace(/[^a-zA-Z0-9-_ ]/g, "").trim().replace(/\s+/g, " ")
        : null;
      const objectKey = safeAlbumFolder
        ? `tracks/${safeAlbumFolder}/${uniqueName}`
        : `tracks/${uniqueName}`;

      const contentType = req.file.mimetype || mime.lookup(req.file.originalname) || "application/octet-stream";

      try {
        const fileStream = fs.createReadStream(localPath);
        const stat = fs.statSync(localPath);

        await s3.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: objectKey,
          Body: fileStream,
          ContentType: contentType,
          ContentLength: stat.size
        }));

        const meta = loadMeta();
        meta[objectKey] = {
          name: filename,
          mimeType: contentType,
          size: stat.size
        };
        if (artistName) meta[objectKey].artistName = artistName;
        if (albumName) meta[objectKey].albumName = albumName;
        if (artwork) meta[objectKey].artworkUrl = artwork;
        saveMeta(meta);

        const driveUrl = `${req.protocol}://${req.get("host")}/drive/${encodeURIComponent(objectKey)}`;

        res.json({ driveFileId: objectKey, driveUrl });
      } catch (e) {
        console.error("R2 upload failed:", e.message);
        return res.status(502).json({ error: "Upload to R2 failed" });
      } finally {
        fs.unlink(localPath, (err) => {
          if (err) console.warn("Failed to remove temp file:", err.message);
        });
      }
    } catch (err) {
      console.error("Upload error:", err);
      if (localPath) fs.unlink(localPath, () => {});
      res.status(500).json({ error: "Upload failed" });
    }

    res.json({
      localUrl: `/uploads/${req.file.filename}`,
      driveFileId,
      driveUrl,
      r2Key,
      r2Url
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
);

// ---------- Edit metadata for a track ----------

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

// ---------- R2 list and stream ----------
app.get('/r2/list', async (req, res) => {
  try {
    if (!r2Client) return res.status(500).json({ error: 'R2 not configured' });
    const params = { Bucket: r2Client._r2Bucket, Prefix: '', MaxKeys: 200 };
    const cmd = new ListObjectsV2Command(params);
    const out = await r2Client.send(cmd);
    const items = (out.Contents || []).map(o => ({
      key: o.Key,
      size: o.Size,
      lastModified: o.LastModified,
      url: `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(o.Key)}`
    }));
    res.json({ data: items });
  } catch (e) {
    console.error('R2 list failed', e);
    res.status(500).json({ error: 'R2 list failed' });
  }
});

// Stream R2 object (supports range)
app.get('/r2/:key', async (req, res) => {
  const key = req.params.key;
  if (!key) return res.status(400).send('Missing key');
  await streamR2Object(req, res, key);
});

// Upload to R2 (optional) - used by POST /upload below when R2 is configured
async function uploadToR2(localPath, destKey, contentType) {
  if (!r2Client) throw new Error('R2 not configured');
  const body = fs.createReadStream(localPath);
  const cmd = new PutObjectCommand({ Bucket: r2Client._r2Bucket, Key: destKey, Body: body, ContentType: contentType });
  const r = await r2Client.send(cmd);
  return r;
}

// Delete R2 object
async function deleteR2Key(key) {
  if (!r2Client) throw new Error('R2 not configured');
  const cmd = new DeleteObjectCommand({ Bucket: r2Client._r2Bucket, Key: key });
  return r2Client.send(cmd);
}

// ---------- Metadata store (simple JSON) ----------
const METADATA_FILE = path.join(uploadDir, 'metadata.json');
const loadMeta = () => {
  try { return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); } catch (e) { return {}; }
};
const saveMeta = (m) => { try { fs.writeFileSync(METADATA_FILE, JSON.stringify(m, null, 2)); } catch (e) { console.error('meta save failed', e); } };

// Edit metadata for a file (local, drive id, or r2:id) - admin only
app.post('/drive/edit', isAdmin, express.json(), (req, res) => {
  const { id, albumName, artistName, artworkUrl, name } = req.body;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const meta = loadMeta();
  meta[id] = meta[id] || {};
  if (name !== undefined) meta[id].name = name;
  if (albumName !== undefined) meta[id].albumName = albumName;
  if (artistName !== undefined) meta[id].artistName = artistName;
  if (artworkUrl !== undefined) meta[id].artworkUrl = artworkUrl;
  saveMeta(meta);
  res.json({ id, meta: meta[id] });
});

// Delete Drive file (admin)
app.delete('/drive/:id', isAdmin, async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: 'Drive not configured' });
    const fileId = req.params.id;
    await drive.files.delete({ fileId });
    // remove metadata entry if exists
    const meta = loadMeta(); delete meta[fileId]; saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    console.error('Drive delete failed', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Delete R2 object (admin)
app.delete('/r2/:key', isAdmin, async (req, res) => {
  try {
    if (!r2Client) return res.status(500).json({ error: 'R2 not configured' });
    const key = req.params.key;
    await deleteR2Key(key);
    const meta = loadMeta(); delete meta[`r2:${key}`]; saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    console.error('R2 delete failed', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Delete local upload (admin)
app.delete('/uploads/:name', isAdmin, (req, res) => {
  try {
    const name = req.params.name;
    const p = path.join(uploadDir, name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const meta = loadMeta(); delete meta[`local:${name}`]; saveMeta(meta);
    res.json({ ok: true });
  } catch (e) {
    console.error('Local delete failed', e);
    res.status(500).json({ error: 'Delete failed' });
  }
});

// Artist page: list tracks and artist metadata
app.get('/artists/:name', async (req, res) => {
  try {
    const name = req.params.name;
    const all = [];
    // local
    const local = fs.readdirSync(uploadDir).filter(n => n !== 'metadata.json');
    local.forEach(n => all.push({ id: `local:${n}`, name: n, url: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(n)}`, source: 'local' }));
    // drive
    if (drive && process.env.DRIVE_FOLDER_ID) {
      try {
        const r = await drive.files.list({ q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`, fields: 'files(id,name,thumbnailLink)' });
        (r.data.files || []).forEach(f => all.push({ id: f.id, name: f.name, url: `${req.protocol}://${req.get('host')}/drive/${encodeURIComponent(f.id)}`, source: 'drive' }));
      } catch (e) { console.warn('Drive list failed in artists', e); }
    }
    // r2
    if (r2Client) {
      try {
        const cmd = new ListObjectsV2Command({ Bucket: r2Client._r2Bucket, Prefix: '', MaxKeys: 200 });
        const out = await r2Client.send(cmd);
        (out.Contents || []).forEach(o => all.push({ id: `r2:${o.Key}`, name: path.basename(o.Key), url: `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(o.Key)}`, source: 'r2' }));
      } catch (e) { console.warn('R2 list failed in artists', e); }
    }

    // filter by metadata artistName or filename contains
    const meta = loadMeta();
    const matches = all.filter(item => {
      const m = meta[item.id] || {};
      if (m.artistName && m.artistName.toLowerCase() === name.toLowerCase()) return true;
      return (item.name || '').toLowerCase().includes(name.toLowerCase());
    });

    const artistMeta = meta[`artist:${name}`] || {};
    res.json({ artist: artistMeta, data: matches });
  } catch (e) {
    console.error('Artists endpoint failed', e);
    res.status(500).json({ error: 'Failed' });
  }
});

// Edit artist metadata (admin)
app.post('/artist/edit', isAdmin, express.json(), (req, res) => {
  const { name, displayName, profileUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const meta = loadMeta();
  meta[`artist:${name}`] = meta[`artist:${name}`] || {};
  if (displayName !== undefined) meta[`artist:${name}`].displayName = displayName;
  if (profileUrl !== undefined) meta[`artist:${name}`].profileUrl = profileUrl;
  saveMeta(meta);
  res.json({ ok: true, artist: meta[`artist:${name}`] });
});

// ---------- List local uploads ----------
app.get('/upload/list', async (req, res) => {
  try {
    const files = [];
    // local uploads
    const all = fs.readdirSync(uploadDir).filter(n => n !== 'metadata.json');
    for (const name of all) {
      const stat = fs.statSync(path.join(uploadDir, name));
      files.push({ id: `local:${name}`, name, size: stat.size, url: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`, thumbnail: null });
    }

    // drive items
    if (drive && process.env.DRIVE_FOLDER_ID) {
      try {
        const r = await drive.files.list({ q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`, fields: 'files(id,name,size,thumbnailLink)' });
        (r.data.files || []).forEach(f => files.push({ id: f.id, name: f.name, size: f.size, url: `${req.protocol}://${req.get('host')}/drive/${encodeURIComponent(f.id)}`, thumbnail: f.thumbnailLink || null }));
      } catch (e) { console.warn('Drive list failed in upload/list', e); }
    }

    // r2 items
    if (r2Client) {
      try {
        const cmd = new ListObjectsV2Command({ Bucket: r2Client._r2Bucket, Prefix: '', MaxKeys: 200 });
        const out = await r2Client.send(cmd);
        (out.Contents || []).forEach(o => files.push({ id: `r2:${o.Key}`, name: path.basename(o.Key), size: o.Size, url: `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(o.Key)}`, thumbnail: null }));
      } catch (e) { console.warn('R2 list failed in upload/list', e); }
    }

    res.json({ data: files });
  } catch (err) {
    console.error("R2 delete error:", err.message);
    res.status(500).json({ error: "Failed to delete file" });
  }
});

/**
 * ListObjectsV2 caps out at 1000 keys per call — this walks all pages
 * so libraries with more than 1000 objects (tracks + cover images
 * combined) still show up completely.
 */
async function listAllObjects() {
  let allObjects = [];
  let continuationToken = undefined;

  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      ContinuationToken: continuationToken
    }));
    allObjects = allObjects.concat(res.Contents || []);
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  return allObjects;
}

// ---------- Library endpoint (R2 is the source of truth) ----------
// Scans the ENTIRE bucket (not just a "tracks/" prefix) so that files
// uploaded directly via rclone/dashboard into any folder structure show
// up here too. Groups objects by their folder path and treats each
// folder as an "album" — using any cover.jpg/png/etc found in that
// folder as the artwork for every track inside it.

app.get("/library", async (req, res) => {
  try {
    const meta = loadMeta();
    const local = fs.readdirSync(uploadDir).filter(n => n !== 'metadata.json').map(name => {
      const id = `local:${name}`;
      const m = meta[id] || {};
      return {
        type: 'songs',
        id,
        attributes: {
          name: m.name || name,
          artistName: m.artistName || 'Uploaded',
          albumName: m.albumName || null,
          durationInMillis: null,
          artwork: { url: m.artworkUrl || null, width: 600, height: 600 },
          playUrl: `${req.protocol}://${req.get('host')}/uploads/${encodeURIComponent(name)}`,
          drive: false
        }
      };
    });

    let driveFiles = [];
    if (drive && process.env.DRIVE_FOLDER_ID) {
      try {
        const r = await drive.files.list({ q: `'${process.env.DRIVE_FOLDER_ID}' in parents and trashed = false`, fields: 'files(id,name,size,thumbnailLink)' });
        driveFiles = (r.data.files || []).map(f => {
          const id = f.id;
          const m = meta[id] || {};
          return {
            type: 'songs',
            id,
            attributes: {
              name: m.name || f.name,
              artistName: m.artistName || 'Drive',
              albumName: m.albumName || null,
              durationInMillis: null,
              artwork: { url: m.artworkUrl || f.thumbnailLink || null, width: 600, height: 600 },
              playUrl: `${req.protocol}://${req.get('host')}/drive/${encodeURIComponent(f.id)}`,
              drive: true
            }
          };
        });
      } catch (e) { console.warn('Drive list in library failed', e); }
    }

        // R2 files
        let r2Files = [];
        if (r2Client) {
          try {
            const cmd = new ListObjectsV2Command({ Bucket: r2Client._r2Bucket, Prefix: '', MaxKeys: 200 });
            const out = await r2Client.send(cmd);
            r2Files = (out.Contents || []).map(o => {
              const id = `r2:${o.Key}`;
              const m = meta[id] || {};
              return {
                type: 'songs',
                id,
                attributes: {
                  name: m.name || path.basename(o.Key),
                  artistName: m.artistName || 'R2',
                  albumName: m.albumName || null,
                  durationInMillis: null,
                  artwork: { url: m.artworkUrl || null, width: 600, height: 600 },
                  playUrl: `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(o.Key)}`,
                  drive: false,
                  r2: true
                }
              };
            });
          } catch (e) { console.warn('R2 list in library failed', e); }
        }

        res.json({ data: [...local, ...driveFiles, ...r2Files] });
  } catch (e) {
    console.error("Library failed", e);
    res.status(500).json({ data: [] });
  }
});

// ---------- Search the bucket by filename / title / artist / album ----------
// Replaces the old behavior of only searching Deezer's catalog — this
// searches YOUR uploaded library so you can actually find your own files.

app.get("/library/search", async (req, res) => {
  try {
    if (!s3 || !R2_BUCKET) {
      return res.status(500).json({ error: "R2 not configured", data: [] });
    }

    let q = (req.query.q || "").toString().trim().toLowerCase();
    if (!q) return res.json({ data: [] });

    const allObjects = await listAllObjects();
    const meta = loadMeta();
    const { tracks } = groupByAlbumFolder(allObjects);

    const matches = tracks.filter(obj => {
      const m = meta[obj.Key] || {};
      const folderName = obj._folderPath ? obj._folderPath.split("/").pop() : "";
      const haystack = [
        m.name || obj.Key.split("/").pop(),
        m.artistName || "",
        m.albumName || folderName || ""
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });

    const files = matches.map(obj => {
      const m = meta[obj.Key] || {};
      const folderName = obj._folderPath ? obj._folderPath.split("/").pop() : null;
      const coverUrl = m.artworkUrl
        || (obj._coverKey ? `${req.protocol}://${req.get("host")}/cover/${encodeURIComponent(obj._coverKey)}` : null);

      return {
        type: "songs",
        id: obj.Key,
        attributes: {
          name: m.name || obj.Key.split("/").pop(),
          artistName: m.artistName || "Unknown",
          albumName: m.albumName || folderName || null,
          durationInMillis: null,
          artwork: { url: coverUrl, width: 600, height: 600 },
          playUrl: `${req.protocol}://${req.get("host")}/drive/${encodeURIComponent(obj.Key)}`,
          mimeType: m.mimeType || mime.lookup(obj.Key) || "application/octet-stream",
          drive: true
        }
      };
    });

    res.json({ data: files });
  } catch (e) {
    console.error("Library search failed", e);
    res.status(500).json({ data: [] });
  }
});

// ---------- Serve a cover image from the bucket ----------

app.get("/cover/:key", async (req, res) => {
  try {
    if (!s3) return res.status(500).json({ error: "R2 not configured" });
    const objectKey = decodeURIComponent(req.params.key);

    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
    const mimeType = head.ContentType || mime.lookup(objectKey) || "image/jpeg";

    const obj = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    obj.Body.pipe(res);
  } catch (err) {
    console.error("Cover read error:", err.message);
    res.status(404).json({ error: "Cover not found" });
  }
});

// ---------- Stream a track (supports Range requests) ----------

app.get("/drive/:id", async (req, res) => {
  try {
    if (!s3) return res.status(500).json({ error: "R2 not configured" });

    const objectKey = decodeURIComponent(req.params.id);
    const range = req.headers.range;

    const head = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
    const mimeType = head.ContentType || mime.lookup(objectKey) || "application/octet-stream";
    const size = head.ContentLength;

    const getCmd = new GetObjectCommand({
      Bucket: R2_BUCKET,
      Key: objectKey,
      ...(range ? { Range: range } : {})
    });

    const obj = await s3.send(getCmd);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Accept-Ranges", "bytes");

    if (range && obj.ContentRange) {
      res.status(206);
      res.setHeader("Content-Range", obj.ContentRange);
      if (obj.ContentLength) res.setHeader("Content-Length", obj.ContentLength);
    } else if (size) {
      res.setHeader("Content-Length", size);
    }

    obj.Body.pipe(res);
  } catch (err) {
    console.error("R2 read error:", err.message);
    res.status(500).json({ error: "Failed to read file" });
  }
});

// ---------- Root ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
