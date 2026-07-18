<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>SoundCloud HLS/MP3/DASH Player</title>

    <!-- HLS.js for HLS playback -->
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>

    <!-- DASH.js for MPEG-DASH playback (correct URL) -->
    <script src="https://cdn.jsdelivr.net/npm/dashjs@latest/dist/dash.all.min.js"></script>

    <!-- Your frontend logic -->
    <script defer src="frontend.js"></script>

    <style>
        body {
            background: #111;
            color: #fff;
            font-family: Arial, sans-serif;
            padding: 20px;
        }

        h1 {
            margin-bottom: 10px;
        }

        #searchBox {
            width: 300px;
            padding: 10px;
            font-size: 16px;
            border-radius: 4px;
            border: none;
            outline: none;
        }

        #searchBtn {
            padding: 10px 16px;
            margin-left: 8px;
            background: #ff5500;
            border: none;
            border-radius: 4px;
            color: #fff;
            font-size: 16px;
            cursor: pointer;
        }

        #searchBtn:hover {
            background: #ff3300;
        }

        #results {
            margin-top: 20px;
        }

        .track {
            padding: 10px 0;
            border-bottom: 1px solid #333;
            cursor: pointer;
        }

        .track:hover {
            background: #222;
        }

        #nowPlaying {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 2px solid #444;
        }

        audio {
            width: 100%;
            margin-top: 10px;
        }
    </style>
</head>

<body>

    <h1>SoundCloud Player (HLS + MP3 + DASH)</h1>

    <input id="searchBox" placeholder="Search tracks..." />
    <button id="searchBtn">Search</button>

    <div id="results"></div>

    <div id="nowPlaying">
        <h2 id="npTitle"></h2>
        <p id="npArtist"></p>
        <audio id="player" controls></audio>
    </div>

</body>
</html>
