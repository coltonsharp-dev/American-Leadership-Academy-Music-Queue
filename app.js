// ===============================
// ALA Music Requester - app.js
// GitHub Pages + Spotify PKCE + Google Sheets CSV
// ===============================

// ---------- CONFIG ----------
const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUri: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/",
  playlistId: "2gGTROyeKdYx8oZ60un1GU",
  requestsCsvUrl:
    "https://docs.google.com/spreadsheets/d/1KCFzjdK9LaUN-jY_6PnmUTU8jq2cZzW9TLEBEDWfnos/export?format=csv&gid=279601659",
  scopes: [
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-modify-public",
    "playlist-modify-private"
  ],
  pollPlaybackMs: 15000
};

// ---------- STORAGE KEYS ----------
const LS = {
  pkceVerifier: "ala_pkce_verifier",
  accessToken: "ala_spotify_access_token",
  refreshToken: "ala_spotify_refresh_token",
  expiresAt: "ala_spotify_expires_at",
  approvedQueue: "ala_approved_queue",
  queuePointer: "ala_queue_pointer",
  rejectedIds: "ala_rejected_request_ids"
};

// ---------- DOM ----------
const el = {
  btnLogin: document.getElementById("btnLogin"),
  btnLogout: document.getElementById("btnLogout"),
  btnLoadRequests: document.getElementById("btnLoadRequests"),
  btnRefreshPlayback: document.getElementById("btnRefreshPlayback"),
  btnPrevQueue: document.getElementById("btnPrevQueue"),
  btnNextQueue: document.getElementById("btnNextQueue"),
  btnPlayApproved: document.getElementById("btnPlayApproved"),
  btnAddApprovedToQueue: document.getElementById("btnAddApprovedToQueue"),

  status: document.getElementById("status"),
  nowPlaying: document.getElementById("nowPlaying"),
  nowPlayingMeta: document.getElementById("nowPlayingMeta"),
  upNext: document.getElementById("upNext"),

  hideExplicitOnly: document.getElementById("hideExplicitOnly"),
  requestSummary: document.getElementById("requestSummary"),
  requestTableBody: document.getElementById("requestTableBody"),
  approvedQueueList: document.getElementById("approvedQueueList")
};

// ---------- STATE ----------
let currentRequests = [];
let playbackPollTimer = null;

// ---------- UTIL ----------
function setStatus(message) {
  if (el.status) el.status.textContent = message;
  console.log(message);
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getApprovedQueue() {
  return safeJsonParse(localStorage.getItem(LS.approvedQueue), []);
}

function saveApprovedQueue(queue) {
  localStorage.setItem(LS.approvedQueue, JSON.stringify(queue));
}

function getRejectedIds() {
  return new Set(safeJsonParse(localStorage.getItem(LS.rejectedIds), []));
}

function saveRejectedIds(setObj) {
  localStorage.setItem(LS.rejectedIds, JSON.stringify([...setObj]));
}

function getQueuePointer() {
  const n = Number(localStorage.getItem(LS.queuePointer));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function setQueuePointer(idx) {
  localStorage.setItem(LS.queuePointer, String(idx));
}

function clampQueuePointer() {
  const queue = getApprovedQueue();
  const maxIdx = Math.max(0, queue.length - 1);
  const idx = Math.min(getQueuePointer(), maxIdx);
  setQueuePointer(idx);
  return idx;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function msToMinSec(ms) {
  const total = Math.floor(Number(ms || 0) / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function minutesDecimalToMinSec(minutesVal) {
  const n = Number(minutesVal);
  if (!Number.isFinite(n)) return "—";
  const totalSec = Math.round(n * 60);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function makeRequestId(row) {
  return [
    row.timestamp || "",
    row.email || "",
    row.spotifyLink || "",
    row.artistInput || "",
    row.songInput || ""
  ].join("|");
}

function extractSpotifyTrackId(url) {
  if (!url) return null;
  const trimmed = String(url).trim();

  const m1 = trimmed.match(/spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (m1) return m1[1];

  const m2 = trimmed.match(/spotify:track:([A-Za-z0-9]+)/i);
  if (m2) return m2[1];

  return null;
}

function spotifyTrackUrl(trackId) {
  return `https://open.spotify.com/track/${trackId}`;
}

function spotifyPlaylistUrl(playlistId) {
  return `https://open.spotify.com/playlist/${playlistId}`;
}

function requestLooksClean(trackObj) {
  return trackObj && trackObj.explicit === false;
}

// ---------- CSV PARSER ----------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      cur += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(cur);
      cur = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (cur.length || row.length) {
        row.push(cur);
        rows.push(row);
        row = [];
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }

  return rows;
}

// ---------- PKCE ----------
function randomString(length = 64) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars[array[i] % chars.length];
  }
  return out;
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createCodeChallenge(verifier) {
  const digest = await sha256(verifier);
  return base64UrlEncode(digest);
}

// ---------- AUTH ----------
async function loginToSpotify() {
  setStatus("Starting Spotify login...");
  const verifier = randomString(64);
  const challenge = await createCodeChallenge(verifier);
  localStorage.setItem(LS.pkceVerifier, verifier);

  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: "code",
    redirect_uri: CONFIG.redirectUri,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: CONFIG.scopes.join(" ")
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleAuthCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    setStatus(`Spotify login error: ${error}`);
    return;
  }

  if (!code) return;

  const verifier = localStorage.getItem(LS.pkceVerifier);
  if (!verifier) {
    setStatus("Missing PKCE verifier. Try logging in again.");
    return;
  }

  setStatus("Exchanging Spotify authorization code...");

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.redirectUri,
    code_verifier: verifier
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  localStorage.setItem(LS.accessToken, json.access_token);
  if (json.refresh_token) {
    localStorage.setItem(LS.refreshToken, json.refresh_token);
  }
  localStorage.setItem(
    LS.expiresAt,
    String(Date.now() + json.expires_in * 1000 - 30000)
  );

  url.searchParams.delete("code");
  window.history.replaceState({}, document.title, url.toString());

  setStatus("Spotify login successful.");
}

async function getAccessToken() {
  const token = localStorage.getItem(LS.accessToken);
  const expiresAt = Number(localStorage.getItem(LS.expiresAt) || "0");

  if (token && Date.now() < expiresAt) return token;

  const refreshToken = localStorage.getItem(LS.refreshToken);
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(text);
    return null;
  }

  const json = await res.json();
  localStorage.setItem(LS.accessToken, json.access_token);
  localStorage.setItem(
    LS.expiresAt,
    String(Date.now() + json.expires_in * 1000 - 30000)
  );

  return json.access_token;
}

function logoutSpotify() {
  localStorage.removeItem(LS.accessToken);
  localStorage.removeItem(LS.refreshToken);
  localStorage.removeItem(LS.expiresAt);
  localStorage.removeItem(LS.pkceVerifier);
  setStatus("Logged out of Spotify.");
}

// ---------- SPOTIFY API ----------
async function spotifyFetch(path, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("Spotify login required.");
  }

  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (res.status === 204) return null;

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }

  return res.json();
}

async function getTrackById(trackId) {
  return spotifyFetch(`/tracks/${trackId}`);
}

async function getCurrentlyPlaying() {
  try {
    return await spotifyFetch("/me/player/currently-playing");
  } catch (err) {
    console.warn("currently-playing error", err);
    return null;
  }
}

async function addTrackToPlaylist(trackUri) {
  return spotifyFetch(`/playlists/${CONFIG.playlistId}/tracks`, {
    method: "POST",
    body: JSON.stringify({
      uris: [trackUri]
    })
  });
}

async function addTrackToSpotifyQueue(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const url = new URL("https://api.spotify.com/v1/me/player/queue");
  url.searchParams.set("uri", trackUri);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
}

async function playTrackNow(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const res = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      uris: [trackUri]
    })
  });

  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${res.status} ${text}`);
  }
}

// ---------- GOOGLE SHEET REQUESTS ----------
async function fetchRequestRows() {
  const url = `${CONFIG.requestsCsvUrl}${CONFIG.requestsCsvUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV: ${res.status}`);
  }

  const text = await res.text();
  const rows = parseCSV(text);

  if (!rows.length) return [];

  // Expected screenshot columns:
  // A Timestamp
  // B Email Address
  // C Spotify link
  // D Artist name
  // E Song name
  return rows.slice(1).filter(r => r.some(cell => String(cell).trim() !== "")).map((r) => ({
    timestamp: (r[0] || "").trim(),
    email: (r[1] || "").trim(),
    spotifyLink: (r[2] || "").trim(),
    artistInput: (r[3] || "").trim(),
    songInput: (r[4] || "").trim()
  }));
}

async function enrichRequests(rows) {
  const rejectedIds = getRejectedIds();
  const enriched = [];

  for (const row of rows) {
    const requestId = makeRequestId(row);
    const trackId = extractSpotifyTrackId(row.spotifyLink);

    const base = {
      ...row,
      requestId,
      trackId,
      rejected: rejectedIds.has(requestId),
      spotify: null,
      error: null
    };

    if (!trackId) {
      base.error = "Invalid or missing Spotify track link";
      enriched.push(base);
      continue;
    }

    try {
      const track = await getTrackById(trackId);
      base.spotify = {
        id: track.id,
        uri: track.uri,
        name: track.name,
        artist: track.artists?.map(a => a.name).join(", ") || "",
        explicit: track.explicit,
        durationMs: track.duration_ms,
        externalUrl: track.external_urls?.spotify || spotifyTrackUrl(track.id),
        album: track.album?.name || ""
      };
    } catch (err) {
      base.error = err.message;
    }

    enriched.push(base);
  }

  return enriched;
}

// ---------- RENDER REQUESTS ----------
function buildRequestSummary(requests) {
  const total = requests.length;
  const valid = requests.filter(r => r.spotify).length;
  const clean = requests.filter(r => r.spotify && r.spotify.explicit === false).length;
  const explicit = requests.filter(r => r.spotify && r.spotify.explicit === true).length;
  const broken = requests.filter(r => !r.spotify).length;

  el.requestSummary.textContent =
    `Loaded ${total} request(s) | Valid Spotify links: ${valid} | Clean: ${clean} | Explicit: ${explicit} | Errors: ${broken}`;
}

function isApproved(requestId) {
  return getApprovedQueue().some(item => item.requestId === requestId);
}

function approveRequest(requestObj) {
  if (!requestObj.spotify || requestObj.spotify.explicit) return;

  const queue = getApprovedQueue();
  if (queue.some(item => item.requestId === requestObj.requestId)) {
    setStatus("Song is already approved.");
    return;
  }

  queue.push({
    requestId: requestObj.requestId,
    timestamp: requestObj.timestamp,
    requestedArtist: requestObj.artistInput,
    requestedSong: requestObj.songInput,
    spotifyLink: requestObj.spotifyLink,
    spotify: requestObj.spotify
  });

  saveApprovedQueue(queue);
  renderApprovedQueue();
  renderRequests(currentRequests);
  setStatus(`Approved: ${requestObj.spotify.artist} — ${requestObj.spotify.name}`);
}

function rejectRequest(requestObj) {
  const rejected = getRejectedIds();
  rejected.add(requestObj.requestId);
  saveRejectedIds(rejected);
  renderRequests(currentRequests);
  setStatus("Request hidden.");
}

function removeApproved(requestId) {
  const queue = getApprovedQueue().filter(item => item.requestId !== requestId);
  saveApprovedQueue(queue);
  clampQueuePointer();
  renderApprovedQueue();
  renderRequests(currentRequests);
  updateUpNext();
  setStatus("Removed approved song.");
}

function renderRequests(requests) {
  const hideExplicit = el.hideExplicitOnly.checked;
  const rejectedIds = getRejectedIds();

  const visible = requests.filter((r) => {
    if (rejectedIds.has(r.requestId)) return false;
    if (hideExplicit && r.spotify && r.spotify.explicit === true) return false;
    return true;
  });

  if (!visible.length) {
    el.requestTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-cell">No requests available with current filters.</td>
      </tr>
    `;
    return;
  }

  el.requestTableBody.innerHTML = visible.map((r) => {
    const requestedLine = `${escapeHtml(r.artistInput || "—")} — ${escapeHtml(r.songInput || "—")}`;
    const spotifyLine = r.spotify
      ? `
        <div class="spotify-match">
          <a class="linklike" href="${escapeHtml(r.spotify.externalUrl)}" target="_blank" rel="noopener">
            ${escapeHtml(r.spotify.artist)} — ${escapeHtml(r.spotify.name)}
          </a>
        </div>
        <div class="song-meta">${escapeHtml(r.spotify.album)}</div>
      `
      : `<div class="spotify-match">${escapeHtml(r.error || "No Spotify match")}</div>`;

    const length = r.spotify ? msToMinSec(r.spotify.durationMs) : "—";

    let badgeHtml = `<span class="badge unknown">Unknown</span>`;
    if (r.spotify && r.spotify.explicit === false) {
      badgeHtml = `<span class="badge clean">Clean</span>`;
    } else if (r.spotify && r.spotify.explicit === true) {
      badgeHtml = `<span class="badge explicit">Explicit</span>`;
    }

    const canApprove = r.spotify && requestLooksClean(r.spotify) && !isApproved(r.requestId);
    const isAlreadyApproved = isApproved(r.requestId);

    return `
      <tr>
        <td>${escapeHtml(r.timestamp || "—")}</td>
        <td class="song-cell">
          <div>${requestedLine}</div>
          <div class="song-meta">${escapeHtml(r.email || "")}</div>
        </td>
        <td>${spotifyLine}</td>
        <td>${escapeHtml(length)}</td>
        <td>${badgeHtml}</td>
        <td>
          <div class="cell-actions">
            <button class="mini-btn approve" data-action="approve" data-id="${escapeHtml(r.requestId)}" ${canApprove ? "" : "disabled"}>
              ${isAlreadyApproved ? "Approved" : "Approve"}
            </button>
            <button class="mini-btn" data-action="playlist" data-id="${escapeHtml(r.requestId)}" ${r.spotify ? "" : "disabled"}>
              Add to Playlist
            </button>
            <button class="mini-btn" data-action="queue" data-id="${escapeHtml(r.requestId)}" ${r.spotify ? "" : "disabled"}>
              Add to Queue
            </button>
            <button class="mini-btn reject" data-action="reject" data-id="${escapeHtml(r.requestId)}">
              Hide
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  el.requestTableBody.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.action;
      const requestId = event.currentTarget.dataset.id;
      const requestObj = currentRequests.find(item => item.requestId === requestId);
      if (!requestObj) return;

      try {
        if (action === "approve") {
          approveRequest(requestObj);
        } else if (action === "reject") {
          rejectRequest(requestObj);
        } else if (action === "playlist") {
          if (!requestObj.spotify) return;
          await addTrackToPlaylist(requestObj.spotify.uri);
          setStatus(`Added to Spotify playlist: ${requestObj.spotify.artist} — ${requestObj.spotify.name}`);
        } else if (action === "queue") {
          if (!requestObj.spotify) return;
          await addTrackToSpotifyQueue(requestObj.spotify.uri);
          setStatus(`Added to Spotify queue: ${requestObj.spotify.artist} — ${requestObj.spotify.name}`);
        }
      } catch (err) {
        console.error(err);
        setStatus(`Action failed: ${err.message}`);
      }
    });
  });
}

// ---------- APPROVED QUEUE ----------
function renderApprovedQueue() {
  const queue = getApprovedQueue();
  const idx = clampQueuePointer();

  if (!queue.length) {
    el.approvedQueueList.innerHTML = `<li class="empty-item">No approved songs yet.</li>`;
    updateUpNext();
    return;
  }

  el.approvedQueueList.innerHTML = queue.map((item, i) => {
    const isCurrent = i === idx;
    return `
      <li>
        <div class="approved-line">
          ${isCurrent ? "▶ " : ""}${escapeHtml(item.spotify.artist)} — ${escapeHtml(item.spotify.name)}
        </div>
        <div class="approved-meta">
          Length: ${escapeHtml(msToMinSec(item.spotify.durationMs))} | Requested: ${escapeHtml(item.requestedArtist)} — ${escapeHtml(item.requestedSong)}
        </div>
        <div class="cell-actions" style="margin-top:8px;">
          <button class="mini-btn" data-approved-action="play" data-approved-id="${escapeHtml(item.requestId)}">Play</button>
          <button class="mini-btn" data-approved-action="queue" data-approved-id="${escapeHtml(item.requestId)}">Queue</button>
          <button class="mini-btn reject" data-approved-action="remove" data-approved-id="${escapeHtml(item.requestId)}">Remove</button>
        </div>
      </li>
    `;
  }).join("");

  el.approvedQueueList.querySelectorAll("[data-approved-action]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.approvedAction;
      const requestId = event.currentTarget.dataset.approvedId;
      const queue = getApprovedQueue();
      const item = queue.find(q => q.requestId === requestId);
      if (!item) return;

      try {
        if (action === "remove") {
          removeApproved(requestId);
        } else if (action === "play") {
          await playTrackNow(item.spotify.uri);
          setQueuePointer(queue.findIndex(q => q.requestId === requestId));
          renderApprovedQueue();
          updateUpNext();
          setStatus(`Playing now: ${item.spotify.artist} — ${item.spotify.name}`);
          await refreshPlayback();
        } else if (action === "queue") {
          await addTrackToSpotifyQueue(item.spotify.uri);
          setStatus(`Queued on Spotify: ${item.spotify.artist} — ${item.spotify.name}`);
        }
      } catch (err) {
        console.error(err);
        setStatus(`Approved queue action failed: ${err.message}`);
      }
    });
  });

  updateUpNext();
}

function updateUpNext() {
  const queue = getApprovedQueue();
  const idx = clampQueuePointer();

  if (!queue.length) {
    el.upNext.textContent = "No approved songs yet";
    return;
  }

  const next = queue[idx + 1];
  if (!next) {
    el.upNext.textContent = "End of approved queue";
    return;
  }

  el.upNext.textContent = `${next.spotify.artist} — ${next.spotify.name} (${msToMinSec(next.spotify.durationMs)})`;
}

function goPrevQueue() {
  const idx = Math.max(0, getQueuePointer() - 1);
  setQueuePointer(idx);
  renderApprovedQueue();
}

function goNextQueue() {
  const queue = getApprovedQueue();
  const idx = Math.min(queue.length - 1, getQueuePointer() + 1);
  setQueuePointer(Math.max(0, idx));
  renderApprovedQueue();
}

async function playCurrentApproved() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs to play.");
    return;
  }

  const idx = clampQueuePointer();
  const item = queue[idx];
  if (!item) return;

  await playTrackNow(item.spotify.uri);
  setStatus(`Playing current approved song: ${item.spotify.artist} — ${item.spotify.name}`);
  await refreshPlayback();
}

async function addCurrentApprovedToQueue() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs to queue.");
    return;
  }

  const idx = clampQueuePointer();
  const item = queue[idx];
  if (!item) return;

  await addTrackToSpotifyQueue(item.spotify.uri);
  setStatus(`Added current approved song to Spotify queue: ${item.spotify.artist} — ${item.spotify.name}`);
}

// ---------- PLAYBACK UI ----------
async function refreshPlayback() {
  const playback = await getCurrentlyPlaying();

  if (!playback || !playback.item) {
    el.nowPlaying.textContent = "Nothing currently loaded";
    el.nowPlayingMeta.textContent = "Open Spotify on an active Premium device, then play or queue a track.";
    return;
  }

  const track = playback.item;
  const artist = track.artists?.map(a => a.name).join(", ") || "Unknown artist";
  const trackName = track.name || "Unknown track";
  const album = track.album?.name || "Unknown album";

  el.nowPlaying.textContent = `${artist} — ${trackName}`;
  el.nowPlayingMeta.textContent = `Album: ${album} | Length: ${msToMinSec(track.duration_ms)} | Explicit: ${track.explicit ? "Yes" : "No"}`;
}

function startPlaybackPolling() {
  if (playbackPollTimer) clearInterval(playbackPollTimer);
  playbackPollTimer = setInterval(() => {
    refreshPlayback().catch((err) => console.warn("Playback poll failed", err));
  }, CONFIG.pollPlaybackMs);
}

// ---------- LOAD FLOW ----------
async function loadStudentRequests() {
  setStatus("Loading Google Form requests...");
  const rawRows = await fetchRequestRows();
  setStatus(`Found ${rawRows.length} request row(s). Checking Spotify track metadata...`);
  currentRequests = await enrichRequests(rawRows);
  buildRequestSummary(currentRequests);
  renderRequests(currentRequests);
  setStatus("Requests loaded.");
}

// ---------- EVENTS ----------
function bindEvents() {
  el.btnLogin?.addEventListener("click", loginToSpotify);
  el.btnLogout?.addEventListener("click", logoutSpotify);
  el.btnLoadRequests?.addEventListener("click", async () => {
    try {
      await loadStudentRequests();
    } catch (err) {
      console.error(err);
      setStatus(`Load requests failed: ${err.message}`);
    }
  });
  el.btnRefreshPlayback?.addEventListener("click", async () => {
    try {
      await refreshPlayback();
      setStatus("Playback refreshed.");
    } catch (err) {
      console.error(err);
      setStatus(`Playback refresh failed: ${err.message}`);
    }
  });
  el.btnPrevQueue?.addEventListener("click", goPrevQueue);
  el.btnNextQueue?.addEventListener("click", goNextQueue);
  el.btnPlayApproved?.addEventListener("click", async () => {
    try {
      await playCurrentApproved();
    } catch (err) {
      console.error(err);
      setStatus(`Play failed: ${err.message}`);
    }
  });
  el.btnAddApprovedToQueue?.addEventListener("click", async () => {
    try {
      await addCurrentApprovedToQueue();
    } catch (err) {
      console.error(err);
      setStatus(`Queue add failed: ${err.message}`);
    }
  });
  el.hideExplicitOnly?.addEventListener("change", () => renderRequests(currentRequests));
}

// ---------- INIT ----------
async function init() {
  bindEvents();
  renderApprovedQueue();
  updateUpNext();

  try {
    await handleAuthCallback();
  } catch (err) {
    console.error(err);
    setStatus(`Spotify auth failed: ${err.message}`);
  }

  try {
    await refreshPlayback();
  } catch (err) {
    console.warn(err);
  }

  startPlaybackPolling();

  if (spotifyPlaylistUrl(CONFIG.playlistId)) {
    setStatus(`Ready. Playlist: ${spotifyPlaylistUrl(CONFIG.playlistId)}`);
  }
}

init();
