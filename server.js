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
const PORT = process.env.PORT || 3000;
const API_BASE = "https://music.apple.com"; // placeholder if you proxy Apple Music or your own source

// Basic security + CORS
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limit
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60
});
app.use(limiter);

// Static files
app.use(express.static(path.join(__dirname, "public")));

// Uploads folder
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

async function uploadToDrive(localPath, filename) {
  if (!drive || !process.env.DRIVE_FOLDER_ID) return null;

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [process.env.DRIVE_FOLDER_ID]
    },
    media: {
      mimeType: "application/octet-stream",
      body: fs.createReadStream(localPath)
    }
  });

  return res.data.id;
}

// ---------- Search endpoint (proxy to your music backend) ----------

app.get("/search", async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: "Missing q" });

    // If you already have a backend (music-backend-production-10bd...), call that instead:
    const upstream = `https://music-backend-production-10bd.up.railway.app/search?q=${encodeURIComponent(q)}`;
    const r = await fetch(upstream);
    if (!r.ok) return res.status(r.status).json({ error: "Upstream search failed" });

    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// ---------- Stream endpoint (proxy stream URL) ----------

app.get("/stream", async (req, res) => {
  try {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: "Missing url" });

    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();

    res.setHeader("Content-Type", r.headers.get("content-type") || "audio/mpeg");
    r.body.pipe(res);
  } catch (err) {
    console.error("Stream error:", err);
    res.status(500).json({ error: "Stream failed" });
  }
});

// ---------- Upload endpoint ----------

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const localPath = req.file.path;
    const filename = req.file.originalname;

    let driveFileId = null;
    if (drive && process.env.DRIVE_FOLDER_ID) {
      driveFileId = await uploadToDrive(localPath, filename);
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

// ---------- Read existing Drive files ----------

app.get("/drive/:id", async (req, res) => {
  try {
    if (!drive) return res.status(500).json({ error: "Drive not configured" });

    const fileId = req.params.id;

    const driveRes = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" }
    );

    res.setHeader("Content-Type", "application/octet-stream");
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
