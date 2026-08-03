import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import fs from "fs";
import path from "path";

const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "5mb" }));

// Rate limit
app.use(rateLimit({
  windowMs: 10 * 1000,
  max: 100
}));

// Multer for uploads
const upload = multer({
  limits: { fileSize: 60 * 1024 * 1024 }
});

// R2 client
const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_KEY,
    secretAccessKey: process.env.R2_SECRET
  }
});

const BUCKET = process.env.R2_BUCKET;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// Metadata file
const META_PATH = "./_metadata.json";
if (!fs.existsSync(META_PATH)) fs.writeFileSync(META_PATH, JSON.stringify([]));

// Load metadata
function loadMeta() {
  return JSON.parse(fs.readFileSync(META_PATH, "utf8"));
}

// Save metadata
function saveMeta(data) {
  fs.writeFileSync(META_PATH, JSON.stringify(data, null, 2));
}

// ---------- Upload ----------
app.post("/upload", upload.array("files"), async (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: "Unauthorized" });

  const artistName = req.body.artistName || "";
  const albumName = req.body.albumName || "";
  const artworkUrl = req.body.artwork;

  const meta = loadMeta();
  let succeeded = 0;
  let failed = [];

  for (const file of req.files) {
    try {
      const key = `tracks/${Date.now()}-${file.originalname}`;

      // ⭐ FIX: Upload with metadata
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,          // REQUIRED FOR PLAYBACK
        CacheControl: "public, max-age=86400"
      }));

      meta.push({
        id: key,
        name: file.originalname.replace(/\.[^/.]+$/, ""),
        artistName,
        albumName,
        artwork: { url: artworkUrl },
        playUrl: `${process.env.PUBLIC_R2_URL}/${key}`
      });

      succeeded++;
    } catch (err) {
      failed.push(file.originalname);
    }
  }

  saveMeta(meta);

  res.json({
    totalRequested: req.files.length,
    totalSucceeded: succeeded,
    failed
  });
});

// ---------- Library ----------
app.get("/library", (req, res) => {
  const meta = loadMeta();
  res.json({ data: meta.map(m => ({ id: m.id, attributes: m })) });
});

// ---------- Grouped ----------
app.get("/library/grouped", (req, res) => {
  const meta = loadMeta();

  const albums = {};
  const artists = {};

  for (const t of meta) {
    if (t.albumName) {
      if (!albums[t.albumName]) albums[t.albumName] = { name: t.albumName, artistName: t.artistName, artwork: t.artwork, tracks: [] };
      albums[t.albumName].tracks.push(t);
    }
    if (t.artistName) {
      if (!artists[t.artistName]) artists[t.artistName] = { name: t.artistName, artwork: t.artwork, tracks: [] };
      artists[t.artistName].tracks.push(t);
    }
  }

  res.json({
    albums: Object.values(albums),
    artists: Object.values(artists)
  });
});

// ---------- Search ----------
app.get("/library/search", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  const meta = loadMeta();
  const results = meta.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.artistName.toLowerCase().includes(q) ||
    t.albumName.toLowerCase().includes(q)
  );
  res.json({ data: results.map(r => ({ id: r.id, attributes: r })) });
});

// ---------- Stream Proxy (optional) ----------
app.get("/stream", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing URL");

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Range");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range");
  res.setHeader("Accept-Ranges", "bytes");

  try {
    const upstream = await fetch(url);
    const ctype = upstream.headers.get("content-type") || "audio/mpeg";
    res.setHeader("Content-Type", ctype);

    upstream.body.pipe(res);
  } catch (err) {
    res.status(500).send("Stream failed");
  }
});

// ---------- Delete ----------
app.delete("/drive/:id", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: "Unauthorized" });

  const id = req.params.id;
  const meta = loadMeta();

  try {
    await r2.send(new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: id
    }));

    saveMeta(meta.filter(t => t.id !== id));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// ---------- Edit ----------
app.post("/drive/edit", (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, name, artistName, albumName, artworkUrl } = req.body;
  const meta = loadMeta();
  const track = meta.find(t => t.id === id);

  if (!track) return res.status(404).json({ error: "Not found" });

  track.name = name;
  track.artistName = artistName;
  track.albumName = albumName;
  track.artwork = { url: artworkUrl };

  saveMeta(meta);
  res.json({ ok: true });
});

// ---------- Bulk Edit ----------
app.post("/drive/edit-bulk", (req, res) => {
  if (req.headers.authorization !== `Bearer ${ADMIN_TOKEN}`)
    return res.status(401).json({ error: "Unauthorized" });

  const { ids, artistName, albumName, artworkUrl } = req.body;
  const meta = loadMeta();

  for (const id of ids) {
    const t = meta.find(x => x.id === id);
    if (!t) continue;
    if (artistName) t.artistName = artistName;
    if (albumName) t.albumName = albumName;
    if (artworkUrl) t.artwork = { url: artworkUrl };
  }

  saveMeta(meta);
  res.json({ ok: true });
});

// ---------- Start ----------
app.listen(3000, () => console.log("Backend running on port 3000"));
