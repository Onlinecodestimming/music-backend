import express from "express";

const app = express();
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3000);

// CORS middleware - allows your frontend to call this API from a different domain
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.get("/", (req, res) => res.send("ok"));

app.get("/search", (req, res) => {
  res.json({ items: [{ id: "test", title: "test result" }] });
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, HOST, () => {
  console.log(`Diagnostic server listening on http://${HOST}:${PORT}`);
});
