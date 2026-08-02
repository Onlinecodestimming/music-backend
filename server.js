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

// ---------- Admin auth ----------
// Protects mutating routes (upload, edit metadata, delete) with a shared
// secret set via the ADMIN_TOKEN env var in Railway. Not a full auth
// system — just enough to stop casual/automated abuse of a public URL.
// Frontend sends it as: Authorization: Bearer <token>
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    // No token configured — fail closed rather than silently allowing
    // writes, so a forgotten env var doesn't leave the bucket wide open.
    return res.status(503).json({ error: "Admin actions are disabled: ADMIN_TOKEN not configured on the server" });
  }
  const header = req.headers.authorization || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (provided !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

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

app.post(
  "/upload",
  requireAdmin,
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
  }
);

// ---------- Edit metadata for a track ----------

app.post("/drive/edit", requireAdmin, (req, res) => {
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

// ---------- Delete a track + its metadata ----------

app.delete("/drive/:id", requireAdmin, async (req, res) => {
  try {
    if (!s3) return res.status(500).json({ error: "R2 not configured" });
    const objectKey = decodeURIComponent(req.params.id);

    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));

    const meta = loadMeta();
    if (meta[objectKey]) {
      delete meta[objectKey];
      saveMeta(meta);
    }

    res.json({ deleted: true, id: objectKey });
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
    if (!s3 || !R2_BUCKET) {
      return res.status(500).json({ error: "R2 not configured", data: [] });
    }

    const allObjects = await listAllObjects();
    const meta = loadMeta();
    const { tracks } = groupByAlbumFolder(allObjects);

    const files = tracks.map(obj => {
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
          artwork: {
            url: coverUrl,
            width: 600,
            height: 600
          },
          playUrl: `${req.protocol}://${req.get("host")}/drive/${encodeURIComponent(obj.Key)}`,
          mimeType: m.mimeType || mime.lookup(obj.Key) || "application/octet-stream",
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

// ---------- Grouped library: by album and by artist ----------
// Reuses the same track data as /library, but organized into shelves for
// Browse. Each group carries a representative cover (the first track's
// artwork with a cover found) so the frontend can render an album-grid
// or artist-grid the way Apple Music does, instead of one flat list.

app.get("/library/grouped", async (req, res) => {
  try {
    if (!s3 || !R2_BUCKET) {
      return res.status(500).json({ error: "R2 not configured", albums: [], artists: [] });
    }

    const allObjects = await listAllObjects();
    const meta = loadMeta();
    const { tracks } = groupByAlbumFolder(allObjects);

    const trackAttrs = tracks.map(obj => {
      const m = meta[obj.Key] || {};
      const folderName = obj._folderPath ? obj._folderPath.split("/").pop() : null;
      const coverUrl = m.artworkUrl
        || (obj._coverKey ? `${req.protocol}://${req.get("host")}/cover/${encodeURIComponent(obj._coverKey)}` : null);

      return {
        id: obj.Key,
        name: m.name || obj.Key.split("/").pop(),
        artistName: m.artistName || "Unknown",
        albumName: m.albumName || folderName || "Unknown Album",
        artwork: { url: coverUrl, width: 600, height: 600 },
        playUrl: `${req.protocol}://${req.get("host")}/drive/${encodeURIComponent(obj.Key)}`,
        mimeType: m.mimeType || mime.lookup(obj.Key) || "application/octet-stream"
      };
    });

    // Group by album
    const albumMap = new Map();
    for (const t of trackAttrs) {
      const key = t.albumName;
      if (!albumMap.has(key)) albumMap.set(key, { name: key, artistName: t.artistName, artwork: null, tracks: [] });
      const group = albumMap.get(key);
      group.tracks.push(t);
      if (!group.artwork && t.artwork.url) group.artwork = t.artwork;
    }

    // Group by artist
    const artistMap = new Map();
    for (const t of trackAttrs) {
      const key = t.artistName;
      if (!artistMap.has(key)) artistMap.set(key, { name: key, artwork: null, tracks: [] });
      const group = artistMap.get(key);
      group.tracks.push(t);
      if (!group.artwork && t.artwork.url) group.artwork = t.artwork;
    }

    const albums = Array.from(albumMap.values());
    const artists = Array.from(artistMap.values());

    res.json({ albums, artists });
  } catch (e) {
    console.error("Grouped library failed", e);
    res.status(500).json({ albums: [], artists: [] });
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
