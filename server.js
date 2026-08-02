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

        // R2 files
        let r2Files = [];
        if (r2Client) {
          try {
            const cmd = new ListObjectsV2Command({ Bucket: r2Client._r2Bucket, Prefix: '', MaxKeys: 200 });
            const out = await r2Client.send(cmd);
            r2Files = (out.Contents || []).map(o => ({
              type: 'songs',
              id: `r2:${o.Key}`,
              attributes: {
                name: path.basename(o.Key),
                artistName: 'R2',
                albumName: null,
                durationInMillis: null,
                artwork: { url: null, width: 600, height: 600 },
                playUrl: `${req.protocol}://${req.get('host')}/r2/${encodeURIComponent(o.Key)}`,
                drive: false,
                r2: true
              }
            }));
          } catch (e) { console.warn('R2 list in library failed', e); }
        }

        res.json({ data: [...local, ...driveFiles, ...r2Files] });
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
    const range = req.headers.range;

    const opts = { responseType: 'stream' };
    if (range) opts.headers = { Range: range };

    const driveRes = await drive.files.get({ fileId, alt: 'media' }, opts);

    // mime
    const meta = await drive.files.get({ fileId, fields: 'mimeType' }).catch(() => ({}));
    const mime = meta.data?.mimeType || 'application/octet-stream';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', mime);
    if (range) res.status(206);
    driveRes.data.pipe(res);
  } catch (err) {
    console.error('Drive read error:', err);
    res.status(500).json({ error: 'Failed to read Drive file' });
  }
});

// ---------- Root ----------

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
