const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "admin123";

app.use(cors());
app.use(express.json());

// In-memory data stores (Connect to your database if configured in your .env)
let libraryTracks = [];
let announcements = [];

// Middleware: Authenticate Admin Token
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  const token = auth && auth.split(" ")[1];
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "Unauthorized: Invalid admin token" });
  }
  next();
}

// ------------------- PUBLIC ROUTES -------------------

// 1. Get Library Tracks
app.get("/api/library", (req, res) => {
  res.json({ tracks: libraryTracks });
});

// 2. Get Public Announcements
app.get("/announcements", (req, res) => {
  res.json({ announcements });
});

// ------------------- ADMIN ROUTES -------------------

// 3. Admin Overview Stats
app.get("/admin/stats", requireAdmin, (req, res) => {
  const albums = new Set(libraryTracks.map(t => t.album).filter(Boolean));
  const artists = new Set(libraryTracks.map(t => t.artist).filter(Boolean));
  const covers = libraryTracks.filter(t => t.artwork).length;

  res.json({
    trackCount: libraryTracks.length,
    albumCount: albums.size,
    artistCount: artists.size,
    totalMB: Math.round(libraryTracks.length * 4.5),
    coverCount: covers,
    announcementCount: announcements.length,
    adminConfigured: true,
    r2Configured: Boolean(process.env.R2_BUCKET || process.env.R2_ACCOUNT_ID)
  });
});

// 4. Post New Announcement
app.post("/announcements", requireAdmin, (req, res) => {
  const { message, level } = req.body;
  if (!message) return res.status(400).json({ error: "Message is required" });

  const newAnnounce = {
    id: Date.now().toString(),
    message,
    level: level || "info",
    createdAt: new Date().toISOString()
  };
  announcements.unshift(newAnnounce);
  res.json({ success: true, announcement: newAnnounce });
});

// 5. Delete Announcement
app.delete("/announcements/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  announcements = announcements.filter(a => a.id !== id);
  res.json({ success: true });
});

// 6. Edit Track Details (Title, Artist, Album, Track Number, Artwork)
app.post("/drive/edit", requireAdmin, (req, res) => {
  const { id, name, artistName, albumName, genre, trackNumber, artworkUrl } = req.body;
  const track = libraryTracks.find(t => String(t.id) === String(id));

  if (!track) {
    const updatedTrack = {
      id: id || Date.now().toString(),
      title: name,
      artist: artistName,
      album: albumName,
      genre,
      trackNumber: trackNumber ? parseInt(trackNumber, 10) : null,
      artwork: artworkUrl
    };
    libraryTracks.push(updatedTrack);
    return res.json({ success: true, track: updatedTrack });
  }

  track.title = name || track.title;
  track.artist = artistName || track.artist;
  track.album = albumName || track.album;
  track.genre = genre || track.genre;
  track.trackNumber = trackNumber ? parseInt(trackNumber, 10) : null;
  track.artwork = artworkUrl || track.artwork;

  res.json({ success: true, track });
});

// 7. Delete Track
app.delete("/drive/:id", requireAdmin, (req, res) => {
  const { id } = req.params;
  libraryTracks = libraryTracks.filter(t => String(t.id) !== String(id));
  res.json({ success: true });
});

// ------------------- ERROR HANDLING -------------------

// Catch-all 404 Handler (Always returns JSON, NEVER HTML)
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.originalUrl} not found on server.` });
});

// Universal Error Handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Internal Server Error", details: err.message });
});

app.listen(PORT, () => console.log(`Musicfy server running on port ${PORT}`));
