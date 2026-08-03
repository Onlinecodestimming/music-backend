// server.js
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const METADATA_FILE = path.join(__dirname, "tracks.json");

// Ensure upload dir exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Ensure metadata file exists
if (!fs.existsSync(METADATA_FILE)) fs.writeFileSync(METADATA_FILE, JSON.stringify({ tracks: [] }, null, 2));

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const id = uuidv4();
    cb(null, `${id}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 60 * 1024 * 1024 // 60 MB per file
  }
});

const app = express();

// Allow JSON bodies for other endpoints
app.use(express.json());

// CORS - allow your frontend origin or use '*' while testing
app.use(cors({
  origin: "*" // replace with your InfinityFree domain for production
}));

// Serve uploaded files
app.use("/uploads", express.static(UPLOAD_DIR));

// Helper to read/write metadata
function readMetadata() {
  try {
    return JSON.parse(fs.readFileSync(METADATA_FILE, "utf8"));
  } catch (e) {
    return { tracks: [] };
  }
}
function writeMetadata(data) {
  fs.writeFileSync(METADATA_FILE, JSON.stringify(data, null, 2));
}

// GET /api/library
app.get("/api/library", (req, res) => {
  const data = readMetadata();
  res.json(data);
});

// POST /upload
// Accepts multipart form with field "file" (single file per append in frontend loop)
// Also accepts artist, album, artwork fields
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { artist = "", album = "", artwork = "" } = req.body;
    const originalName = req.file.originalname;
    const filename = req.file.filename;
    const urlBase = process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`;
    const fileUrl = `${urlBase}/uploads/${filename}`;

    // Create track object
    const track = {
      id: path.parse(filename).name,
      title: originalName.replace(/\.[^/.]+$/, ""),
      artist,
      album,
      artwork,
      url: fileUrl,
      filename,
      size: req.file.size,
      uploadedAt: new Date().toISOString()
    };

    // Save to metadata
    const meta = readMetadata();
    meta.tracks = meta.tracks || [];
    meta.tracks.push(track);
    writeMetadata(meta);

    return res.json({ ok: true, track });
  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// Optional health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Start server
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
