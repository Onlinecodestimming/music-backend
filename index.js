// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI; // e.g. https://your-domain.com/callback

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Login URL (user clicks this)
app.get("/login", (req, res) => {
    const scope = [
        "streaming",
        "user-read-email",
        "user-read-private",
        "user-read-playback-state",
        "user-modify-playback-state"
    ].join(" ");

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: REDIRECT_URI,
        scope
    });

    res.redirect("https://accounts.spotify.com/authorize?" + params.toString());
});

// 2. Callback (Spotify redirects here with ?code=)
app.get("/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("No code");

    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: REDIRECT_URI
        }).toString()
    });

    const data = await tokenRes.json();

    // In a real app, store tokens in DB/session.
    // For now, just send them to frontend as JSON.
    return res.send(`
        <script>
            window.opener.postMessage(${JSON.stringify(data)}, "*");
            window.close();
        </script>
    `);
});

// 3. Simple health check
app.get("/", (req, res) => {
    res.send("Spotify Connect backend running");
});

app.listen(PORT, () => {
    console.log(`Backend on ${PORT}`);
});
