"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const morgan = require("morgan");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand
} = require("@aws-sdk/client-s3");

const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_SIZE = 60 * 1024 * 1024;

const REQUIRED_ENV = [
  "DATABASE_URL",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL"
];

for (const name of REQUIRED_ENV) {
  if (!process.env[name]) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
}

const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL.replace(/\/+$/, "");

const allowedOrigins = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map(value => value.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DB_SSL === "false"
      ? false
      : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

const r2 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  }
});

const upload = multer({
  storage: multer.memoryStorage(),

  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  },

  fileFilter: (_req, file, callback) => {
    const allowedMime =
      file.mimetype.startsWith("audio/") ||
      file.mimetype.startsWith("video/");

    const allowedExtension = [
      ".mp3",
      ".wav",
      ".flac",
      ".ogg",
      ".oga",
      ".m4a",
      ".aac",
      ".mp4",
      ".webm"
    ].includes(path.extname(file.originalname).toLowerCase());

    if (!allowedMime || !allowedExtension) {
      return callback(
        new HttpError(
          415,
          "Only supported audio/video files are allowed."
        )
      );
    }

    callback(null, true);
  }
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function asyncRoute(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
}

function normalizeText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text.slice(0, 300) || fallback;
}

function cleanExtension(filename, mimeType) {
  const ext = path
    .extname(filename)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, "");

  if (ext && ext.length <= 8) {
    return ext;
  }

  const byMime = {
    "audio/mpeg": ".mp3",
    "audio/mp4": ".m4a",
    "audio/flac": ".flac",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "video/mp4": ".mp4",
    "video/webm": ".webm"
  };

  return byMime[mimeType] || ".bin";
}

function publicObjectUrl(key) {
  const encodedKey = key
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `${R2_PUBLIC_URL}/${encodedKey}`;
}

function mapTrack(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    artwork: row.artwork_url || "",
    url: row.audio_url,
    filename: row.original_filename,
    size: Number(row.file_size || 0),
    duration: Number(row.duration || 0),
    mimeType: row.mime_type,
    uploadedAt: new Date(row.uploaded_at).toISOString()
  };
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracks (
      id UUID PRIMARY KEY,
      title VARCHAR(300) NOT NULL,
      artist VARCHAR(300) NOT NULL DEFAULT '',
      album VARCHAR(300) NOT NULL DEFAULT '',
      artwork_url TEXT NOT NULL DEFAULT '',
      audio_url TEXT NOT NULL,
      object_key TEXT NOT NULL UNIQUE,
      artwork_key TEXT,
      original_filename TEXT NOT NULL,
      mime_type VARCHAR(150) NOT NULL,
      file_size BIGINT NOT NULL,
      duration DOUBLE PRECISION NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS tracks_uploaded_at_idx
      ON tracks (uploaded_at DESC);

    CREATE INDEX IF NOT EXISTS tracks_search_idx
      ON tracks (LOWER(title), LOWER(artist), LOWER(album));
  `);
}

async function uploadToR2({
  key,
  body,
  contentType,
  cacheControl = "public, max-age=31536000, immutable"
}) {
  await r2.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: cacheControl,
      ContentDisposition: "inline"
    })
  );

  return publicObjectUrl(key);
}

async function deleteFromR2(key) {
  if (!key) {
    return;
  }

  await r2.send(
    new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key
    })
  );
}

async function parseMetadata(file) {
  try {
    const { parseBuffer } = await import("music-metadata");

    return await parseBuffer(
      file.buffer,
      {
        mimeType: file.mimetype,
        size: file.size,
        path: file.originalname
      },
      {
        duration: true,
        skipCovers: false
      }
    );
  } catch (error) {
    console.warn("Metadata extraction skipped:", error.message);

    return {
      common: {},
      format: {}
    };
  }
}

function requireAdmin(req, _res, next) {
  const configured = process.env.ADMIN_KEY;

  if (!configured) {
    return next();
  }

  const supplied = req.get("x-admin-key") || "";

  const configuredBuffer = Buffer.from(configured);
  const suppliedBuffer = Buffer.from(supplied);

  if (
    configuredBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(configuredBuffer, suppliedBuffer)
  ) {
    return next(
      new HttpError(
        401,
        "An administrator key is required."
      )
    );
  }

  next();
}

const app = express();

app.set("trust proxy", 1);

app.use(
  helmet({
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(compression());

app.use(
  morgan(
    process.env.NODE_ENV === "production"
      ? "combined"
      : "dev"
  )
);

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  cors({
    origin(origin, callback) {
      const normalizedOrigin = origin
        ? origin.replace(/\/+$/, "")
        : "";

      if (
        !origin ||
        allowedOrigins.length === 0 ||
        allowedOrigins.includes(normalizedOrigin)
      ) {
        return callback(null, true);
      }

      callback(
        new HttpError(
          403,
          "This frontend origin is not allowed."
        )
      );
    },

    methods: [
      "GET",
      "POST",
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],

    allowedHeaders: [
      "Content-Type",
      "X-Admin-Key"
    ]
  })
);

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-8",
  legacyHeaders: false,

  message: {
    error:
      "Too many write requests. Please try again later."
  }
});

app.get(
  "/health",
  asyncRoute(async (_req, res) => {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      storage: "r2",
      database: "postgresql"
    });
  })
);

app.get(
  "/api/library",
  asyncRoute(async (req, res) => {
    const q = normalizeText(req.query.q);

    const values = [];
    let where = "";

    if (q) {
      values.push(`%${q}%`);

      where = `
        WHERE title ILIKE $1
           OR artist ILIKE $1
           OR album ILIKE $1
      `;
    }

    const result = await pool.query(
      `
        SELECT *
        FROM tracks
        ${where}
        ORDER BY uploaded_at ASC
        LIMIT 5000
      `,
      values
    );

    res.json({
      tracks: result.rows.map(mapTrack)
    });
  })
);

app.post(
  "/upload",
  writeLimiter,
  requireAdmin,
  upload.single("file"),

  asyncRoute(async (req, res) => {
    if (!req.file) {
      throw new HttpError(
        400,
        "No file was uploaded."
      );
    }

    const id = crypto.randomUUID();

    const metadata = await parseMetadata(req.file);

    const extension = cleanExtension(
      req.file.originalname,
      req.file.mimetype
    );

    const objectKey = `music/${id}${extension}`;

    let artworkKey = null;
    let artworkUrl = normalizeText(req.body.artwork);

    const common = metadata.common || {};

    const title = normalizeText(
      req.body.title,
      common.title ||
        path.parse(req.file.originalname).name
    );

    const artist = normalizeText(
      req.body.artist,
      common.artist ||
        common.albumartist ||
        "Unknown Artist"
    );

    const album = normalizeText(
      req.body.album,
      common.album || "Singles"
    );

    const duration = Number.isFinite(
      metadata.format?.duration
    )
      ? metadata.format.duration
      : 0;

    try {
      const audioUrl = await uploadToR2({
        key: objectKey,
        body: req.file.buffer,
        contentType: req.file.mimetype
      });

      const picture = Array.isArray(common.picture)
        ? common.picture[0]
        : null;

      if (
        !artworkUrl &&
        picture?.data?.length
      ) {
        const imageExtension =
          picture.format === "image/png"
            ? ".png"
            : picture.format === "image/webp"
              ? ".webp"
              : ".jpg";

        artworkKey =
          `artwork/${id}${imageExtension}`;

        artworkUrl = await uploadToR2({
          key: artworkKey,
          body: Buffer.from(picture.data),
          contentType:
            picture.format || "image/jpeg"
        });
      }

      const inserted = await pool.query(
        `
          INSERT INTO tracks (
            id,
            title,
            artist,
            album,
            artwork_url,
            audio_url,
            object_key,
            artwork_key,
            original_filename,
            mime_type,
            file_size,
            duration
          )
          VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11, $12
          )
          RETURNING *
        `,
        [
          id,
          title,
          artist,
          album,
          artworkUrl,
          audioUrl,
          objectKey,
          artworkKey,
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
          duration
        ]
      );

      res.status(201).json({
        ok: true,
        track: mapTrack(inserted.rows[0])
      });
    } catch (error) {
      await Promise.allSettled([
        deleteFromR2(objectKey),
        deleteFromR2(artworkKey)
      ]);

      throw error;
    }
  })
);

app.patch(
  "/api/tracks/:id",
  writeLimiter,
  requireAdmin,

  asyncRoute(async (req, res) => {
    const current = await pool.query(
      `
        SELECT *
        FROM tracks
        WHERE id = $1
      `,
      [req.params.id]
    );

    if (current.rowCount === 0) {
      throw new HttpError(
        404,
        "Track not found."
      );
    }

    const old = current.rows[0];

    const title = normalizeText(
      req.body.title,
      old.title
    );

    const artist = normalizeText(
      req.body.artist,
      old.artist
    );

    const album = normalizeText(
      req.body.album,
      old.album
    );

    const artworkUrl =
      req.body.artwork === undefined
        ? old.artwork_url
        : normalizeText(req.body.artwork);

    const updated = await pool.query(
      `
        UPDATE tracks
        SET
          title = $1,
          artist = $2,
          album = $3,
          artwork_url = $4,
          updated_at = NOW()
        WHERE id = $5
        RETURNING *
      `,
      [
        title,
        artist,
        album,
        artworkUrl,
        req.params.id
      ]
    );

    res.json({
      ok: true,
      track: mapTrack(updated.rows[0])
    });
  })
);

app.delete(
  "/api/tracks/:id",
  writeLimiter,
  requireAdmin,

  asyncRoute(async (req, res) => {
    const result = await pool.query(
      `
        DELETE FROM tracks
        WHERE id = $1
        RETURNING *
      `,
      [req.params.id]
    );

    if (result.rowCount === 0) {
      throw new HttpError(
        404,
        "Track not found."
      );
    }

    const track = result.rows[0];

    const deletion = await Promise.allSettled([
      deleteFromR2(track.object_key),
      deleteFromR2(track.artwork_key)
    ]);

    const storageWarning = deletion.some(
      item => item.status === "rejected"
    );

    res.json({
      ok: true,
      storageWarning
    });
  })
);

app.use((_req, _res, next) => {
  next(
    new HttpError(
      404,
      "Route not found."
    )
  );
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "The file exceeds the 60 MB limit."
        : error.message;

    return res.status(400).json({
      error: message
    });
  }

  const status = Number(
    error.status || 500
  );

  if (status >= 500) {
    console.error(error);
  }

  res.status(status).json({
    error:
      status >= 500
        ? "The server encountered an error."
        : error.message
  });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(
        `Musicfy API listening on port ${PORT}`
      );
    });
  })
  .catch(error => {
    console.error(
      "Database initialization failed:",
      error
    );

    process.exit(1);
  });
