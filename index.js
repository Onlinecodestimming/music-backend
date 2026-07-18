// index.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI; // e.g. https://your-domain.com/callback

if (!CLIENT_ID || !CLIENT_SECRET || !REDIRECT_URI) {
    console.error("Missing Spotify env vars");
}

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory store (for dev). For prod, use DB/session.
let tokensByUser = {}; // { userId: { access_token, refresh_token, expires_at } }

// Build Spotify auth URL
function buildAuthUrl() {
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

    return "https://accounts.spotify.com/authorize?" + params.toString();
}

// Exchange code for tokens
async function exchangeCodeForTokens(code) {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const res = await fetch("https://accounts.spotify.com/api/token", {
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

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Token error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_in: data.expires_in
    };
}

// Refresh access token
async function refreshAccessToken(refreshToken) {
    const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

    const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: refreshToken
        }).toString()
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Refresh error ${res.status}: ${text}`);
    }

    const data = await res.json();
    return {
        access_token: data.access_token,
        expires_in: data.expires_in
    };
}

// Simple user id (for demo). In real app, use auth/session.
function getUserId(req) {
    // For now, single user:
    return "rhema";
}

/* -------------------------------------------------------
   1. Login endpoint (frontend opens this in popup)
------------------------------------------------------- */
app.get("/login", (req, res) => {
    const url = buildAuthUrl();
    res.redirect(url);
});

/* -------------------------------------------------------
   2. Callback endpoint (Spotify redirects here)
------------------------------------------------------- */
app.get("/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("No code");

    try {
        const tokens = await exchangeCodeForTokens(code);
        const userId = getUserId(req);

        tokensByUser[userId] = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: Date.now() + tokens.expires_in * 1000
        };

        // Send tokens back to opener (frontend)
        return res.send(`
            <script>
                window.opener.postMessage(${JSON.stringify(tokensByUser[userId])}, "*");
                window.close();
            </script>
        `);
    } catch (err) {
        console.error("Callback error:", err.message);
        return res.status(500).send("Auth failed");
    }
});

/* -------------------------------------------------------
   3. Endpoint to get a fresh access token (frontend can call)
------------------------------------------------------- */
app.get("/token", async (req, res) => {
    const userId = getUserId(req);
    const stored = tokensByUser[userId];

    if (!stored) {
        return res.status(401).json({ error: "Not authenticated" });
    }

    // If token expired, refresh
    if (Date.now() >= stored.expires_at) {
        try {
            const refreshed = await refreshAccessToken(stored.refresh_token);
            stored.access_token = refreshed.access_token;
            stored.expires_at = Date.now() + refreshed.expires_in * 1000;
        } catch (err) {
            console.error("Refresh error:", err.message);
            return res.status(500).json({ error: "Token refresh failed" });
        }
    }

    return res.json({
        access_token: stored.access_token,
        expires_at: stored.expires_at
    });
});

/* -------------------------------------------------------
   4. Health check
------------------------------------------------------- */
app.get("/", (req, res) => {
    res.send("Spotify Connect backend running");
});

app.listen(PORT, () => {
    console.log(`Backend running on port ${PORT}`);
});
