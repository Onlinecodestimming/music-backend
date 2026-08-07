"use strict";

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const multer = require("multer");
const crypto = require("crypto");
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 8080;

/* ENV CHECK */
const required = [
    "DATABASE_URL", "R2_ENDPOINT", "R2_KEY", 
    "R2_SECRET", "R2_BUCKET", "PUBLIC_R2_URL"
];

for(const env of required){
    if(!process.env[env]){
        console.log("Missing environment variable:", env);
        process.exit(1);
    }
}

/* DATABASE */
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/* R2 */
const r2 = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_KEY,
        secretAccessKey: process.env.R2_SECRET
    }
});

/* UPLOAD */
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 60 * 1024 * 1024 }
});

/* MIDDLEWARE */
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(compression());
app.use(cors({ origin: "*" }));
app.use(express.json());

/* DATABASE SETUP (Now includes Playlist tables) */
async function setup(){
    await db.query(`
        CREATE TABLE IF NOT EXISTS tracks (
            id UUID PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            artwork TEXT,
            url TEXT,
            filename TEXT,
            size BIGINT,
            created TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id UUID PRIMARY KEY,
            name TEXT,
            created TIMESTAMP DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS playlist_tracks (
            playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
            track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
            added_at TIMESTAMP DEFAULT NOW(),
            PRIMARY KEY (playlist_id, track_id)
        );
    `);
}

function checkAdmin(req, res, next){
    const key = req.headers["x-admin-key"];
    if(process.env.ADMIN_KEY && key !== process.env.ADMIN_KEY){
        return res.status(401).json({ error: "Invalid admin key" });
    }
    next();
}

function r2Url(key){
    return (process.env.PUBLIC_R2_URL.replace(/\/$/, "") + "/" + key);
}

async function uploadR2(key, buffer, type){
    await r2.send(
        new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            Body: buffer,
            ContentType: type
        })
    );
    return r2Url(key);
}

/* HEALTH */
app.get("/health", async(req, res) => {
    try {
        await db.query("SELECT 1");
        res.json({ ok: true, database: true, storage: "r2" });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/* GET ALL LIBRARY TRACKS */
app.get("/api/library", async(req, res) => {
    try {
        const result = await db.query(`SELECT * FROM tracks ORDER BY created DESC`);
        res.json({ tracks: result.rows.map(t => ({
            id: t.id, title: t.title, artist: t.artist, album: t.album,
            artwork: t.artwork, url: t.url, filename: t.filename, size: Number(t.size)
        }))});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* PLAYLIST ENDPOINTS */
app.post("/api/playlists", checkAdmin, async(req, res) => {
    try {
        const id = crypto.randomUUID();
        const { name } = req.body;
        if(!name) return res.status(400).json({ error: "Playlist name required" });
        
        await db.query(`INSERT INTO playlists (id, name) VALUES ($1, $2)`, [id, name]);
        res.json({ ok: true, playlist: { id, name } });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/playlists", async(req, res) => {
    try {
        const result = await db.query(`SELECT * FROM playlists ORDER BY created DESC`);
        res.json({ playlists: result.rows });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/playlists/:playlistId/tracks", checkAdmin, async(req, res) => {
    try {
        const { playlistId } = req.params;
        const { trackId } = req.body;
        
        await db.query(
            `INSERT INTO playlist_tracks (playlist_id, track_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, 
            [playlistId, trackId]
        );
        res.json({ ok: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get("/api/playlists/:playlistId/tracks", async(req, res) => {
    try {
        const { playlistId } = req.params;
        const result = await db.query(`
            SELECT t.* FROM tracks t
            JOIN playlist_tracks pt ON t.id = pt.track_id
            WHERE pt.playlist_id = $1
            ORDER BY pt.added_at ASC
        `, [playlistId]);
        
        res.json({ tracks: result.rows });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/* AM-LYRICS INTEGRATION */
app.get("/api/lyrics", async (req, res) => {
    try {
        const { title, artist } = req.query;
        if (!title || !artist) {
            return res.status(400).json({ error: "Title and artist are required" });
        }

        const formattedFileName = encodeURIComponent(`${title} - ${artist}.lrc`);
        const githubUrl = `https://raw.githubusercontent.com/binimum/am-lyrics/main/${formattedFileName}`;
        
        // Use native fetch to grab lyrics server-side
        const response = await fetch(githubUrl);
        if (!response.ok) {
            return res.status(404).json({ error: "Lyrics not found in repository" });
        }
        
        const lyrics = await response.text();
        res.json({ ok: true, lyrics });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

/* UPLOAD */
app.post("/upload", checkAdmin, upload.single("file"), async(req, res) => {
    try {
        if(!req.file) return res.status(400).json({ error: "No file" });
        
        const id = crypto.randomUUID();
        const ext = req.file.originalname.split(".").pop();
        const key = `music/${id}.${ext}`;
        const url = await uploadR2(key, req.file.buffer, req.file.mimetype);

        const track = {
            id,
            title: req.body.title || req.file.originalname,
            artist: req.body.artist || "Unknown",
            album: req.body.album || "Singles",
            artwork: req.body.artwork || "",
            url,
            filename: req.file.originalname,
            size: req.file.size
        };

        await db.query(
            `INSERT INTO tracks (id, title, artist, album, artwork, url, filename, size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [track.id, track.title, track.artist, track.album, track.artwork, track.url, track.filename, track.size]
        );

        res.json({ ok: true, track });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

/* START */
setup().then(() => {
    app.listen(PORT, () => console.log("Musicfy running on", PORT));
}).catch(err => {
    console.error("Startup failed", err);
    process.exit(1);
});
