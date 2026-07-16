import express from "express";
import fs from "fs/promises";
import path from "path";

const app = express();

app.get("/", (req, res) => res.send("ok"));

// Simple local JSON search
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim().toLowerCase();
    const filePath = path.join(process.cwd(), "data", "items.json");

    // Ensure file exists
    const raw = await fs.readFile(filePath, "utf8");
    const items = JSON.parse(raw);

    if (!q) {
      return res.json({ items: items.slice(0, 20) });
    }

    // Basic fuzzy-ish match: id or title contains query
    const results = items.filter(item => {
      const title = (item.title || "").toString().toLowerCase();
      const id = (item.id || "").toString().toLowerCase();
      return title.includes(q) || id.includes(q);
    }).slice(0, 50);

    res.json({ items: results });
  } catch (err) {
    console.error("Search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Diagnostic server listening on ${PORT}`));
