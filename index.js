import express from "express";
const app = express();
app.get("/", (req, res) => res.send("ok"));
app.get("/search", (req, res) => res.json({ items: [{ id: "test", title: "test result" }] }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Diagnostic server listening on ${PORT}`));
