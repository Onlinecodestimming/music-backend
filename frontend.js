const API = "https://music-backend-production-10bd.up.railway.app";

const results = document.getElementById("results");
const player = document.getElementById("player");
const searchBar = document.getElementById("searchBar");

function formatDuration(ms) {
 if (!ms || ms === 0) return "";
 const totalSec = Math.floor(ms / 1000);
 const min = Math.floor(totalSec / 60);
 const sec = totalSec % 60;
 return `${min}:${sec.toString().padStart(2, "0")}`;
}

async function search() {
 const q = searchBar.value.trim();
 if (!q) return;

 const res = await fetch(API + "/search?q=" + encodeURIComponent(q));
 const data = await res.json();

 results.innerHTML = "";

 data.data.forEach(track => {
 const a = track.attributes;
 const playable = !!a.playable;

 const div = document.createElement("div");
 div.className = "track" + (playable ? "" : " disabled");

 div.innerHTML = `
 <img class="artwork" src="${a.artwork.url}">
 <div class="info">
 <div class="title">${a.name}</div>
 <div class="artist">${a.artistName} • ${a.albumName}</div>
 <div class="duration">${formatDuration(a.durationInMillis)}</div>
 ${playable ? "" : "<div class='not-playable'>No stream available</div>"}
 </div>
 `;

 if (playable) {
 div.onclick = () => {
 if (!a.playUrl) return;
 player.src = API + "/stream?url=" + encodeURIComponent(a.playUrl);
 };
 }

 results.appendChild(div);
 });
}

window.search = search;