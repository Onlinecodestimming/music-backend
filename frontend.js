const API = "https://music-backend-production-10bd.up.railway.app";

const uploadForm = document.getElementById('uploadForm');
const uploadInput = document.getElementById('uploadInput');
const uploadsList = document.getElementById('uploads');

async function fetchUploads() {
  try {
    const r = await fetch(API + '/upload/list');
    const j = await r.json();
    uploadsList.innerHTML = '';
    j.data.forEach(f => {
      const el = document.createElement('div');
      el.className = 'uploaded';
      el.innerHTML = `<div class="u-info"><div class="u-name">${f.name}</div><div class="u-size">${Math.round(f.size/1024)} KB</div></div><button class="u-play">Play</button>`;
      el.querySelector('.u-play').onclick = () => {
        player.src = f.url;
        player.play().catch(e => console.log('playback error', e));
      };
      uploadsList.appendChild(el);
    });
  } catch (e) { console.log('fetch uploads failed', e); }
}

if (uploadForm) {
  uploadForm.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!uploadInput.files || uploadInput.files.length === 0) return;
    const fd = new FormData();
    fd.append('file', uploadInput.files[0]);
    const r = await fetch(API + '/upload', { method: 'POST', body: fd });
    const j = await r.json();
    uploadInput.value = '';
    await fetchUploads();
  };
}

window.fetchUploads = fetchUploads;
window.addEventListener('load', () => fetchUploads());

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