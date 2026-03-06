// ======================================================
// ALA Music Requester
// app.js
// ======================================================

// --------------------
// CONFIG
// --------------------
const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUri: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/",
  playlistId: "2gGTROyeKdYx8oZ60un1GU",
  requestsCsvUrl:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQyc3RRDmjc-nN-XgMMDocbnn1tlxue5ynNoNnYSxnRKxgp2LRGNmYZXnVgAFLH7IViwTAtmIAkvDsK/pub?output=csv",
  scopes: [
    "user-read-playback-state",
    "user-modify-playback-state",
    "playlist-modify-public",
    "playlist-modify-private"
  ],
  playbackPollMs: 15000
};

// --------------------
// LOCAL STORAGE KEYS
// --------------------
const LS = {
  pkceVerifier: "ala_pkce_verifier",
  accessToken: "ala_access_token",
  refreshToken: "ala_refresh_token",
  expiresAt: "ala_expires_at",
  approvedQueue: "ala_approved_queue",
  rejectedIds: "ala_rejected_ids",
  queuePointer: "ala_queue_pointer"
};

// --------------------
// DOM
// --------------------
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

// --------------------
// STATE
// --------------------
let currentRequests = [];
let playbackTimer = null;

// ======================================================
// BASIC HELPERS
// ======================================================
function setStatus(message) {
  if (el.status) el.status.textContent = message;
  console.log(message);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeJsonParse(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function msToMinSec(ms) {
  const totalSeconds = Math.floor(Number(ms || 0) / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function spotifyTrackUrl(trackId) {
  return `https://open.spotify.com/track/${trackId}`;
}

function buildRequestId(row) {
  return [
    row.timestamp || "",
    row.email || "",
    row.spotifyLink || ""
  ].join("|");
}

// ======================================================
// STORAGE HELPERS
// ======================================================
function ensureStorageDefaults() {
  if (!localStorage.getItem(LS.approvedQueue)) {
    localStorage.setItem(LS.approvedQueue, JSON.stringify([]));
  }

  if (!localStorage.getItem(LS.rejectedIds)) {
    localStorage.setItem(LS.rejectedIds, JSON.stringify([]));
  }

  if (!localStorage.getItem(LS.queuePointer)) {
    localStorage.setItem(LS.queuePointer, "0");
  }
}

function getApprovedQueue() {
  const stored = localStorage.getItem(LS.approvedQueue);

  if (!stored) {
    localStorage.setItem(LS.approvedQueue, JSON.stringify([]));
    return [];
  }

  const parsed = safeJsonParse(stored, []);
  return Array.isArray(parsed) ? parsed : [];
}

function saveApprovedQueue(queue) {
  localStorage.setItem(LS.approvedQueue, JSON.stringify(queue));
}

function getRejectedIds() {
  const stored = safeJsonParse(localStorage.getItem(LS.rejectedIds), []);
  return new Set(Array.isArray(stored) ? stored : []);
}

function saveRejectedIds(setObj) {
  localStorage.setItem(LS.rejectedIds, JSON.stringify([...setObj]));
}

function getQueuePointer() {
  const raw = Number(localStorage.getItem(LS.queuePointer));
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

function setQueuePointer(index) {
  localStorage.setItem(LS.queuePointer, String(Math.max(0, index)));
}

function clampQueuePointer() {
  const queue = getApprovedQueue();

  if (!queue.length) {
    setQueuePointer(0);
    return 0;
  }

  const current = getQueuePointer();
  const clamped = Math.min(current, queue.length - 1);
  setQueuePointer(clamped);
  return clamped;
}

// ======================================================
// CSV PARSER
// ======================================================
function parseCSV(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"' && inQuotes && next === '"') {
      current += '"';
      i++;
      continue;
    }

    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(current);
      current = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") {
        i++;
      }

      if (current.length > 0 || row.length > 0) {
        row.push(current);
        rows.push(row);
      }

      row = [];
      current = "";
      continue;
    }

    current += ch;
  }

  if (current.length > 0 || row.length > 0) {
    row.push(current);
    rows.push(row);
  }

  return rows.filter((r) => Array.isArray(r));
}

// ======================================================
// SPOTIFY LINK PARSER
// ======================================================
function extractSpotifyTrackId(url) {
  if (!url) return null;

  const trimmed = String(url).trim();

  const trackUrlMatch = trimmed.match(/spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (trackUrlMatch) return trackUrlMatch[1];

  const spotifyUriMatch = trimmed.match(/spotify:track:([A-Za-z0-9]+)/i);
  if (spotifyUriMatch) return spotifyUriMatch[1];

  return null;
}

// ======================================================
// PKCE AUTH HELPERS
// ======================================================
function randomString(length = 64) {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  let result = "";
  for (let i = 0; i < bytes.length; i++) {
    result += chars[bytes[i] % chars.length];
  }
  return result;
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

// ======================================================
// SPOTIFY AUTH
// ======================================================
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

async function handleSpotifyCallback() {
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

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${text}`);
  }

  const json = await response.json();

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
  const accessToken = localStorage.getItem(LS.accessToken);
  const expiresAt = Number(localStorage.getItem(LS.expiresAt) || "0");

  if (accessToken && Date.now() < expiresAt) {
    return accessToken;
  }

  const refreshToken = localStorage.getItem(LS.refreshToken);
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("Refresh failed:", text);
    return null;
  }

  const json = await response.json();
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

// ======================================================
// SPOTIFY API
// ======================================================
async function spotifyFetch(path, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("Spotify login required.");
  }

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (response.status === 204) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  return response.json();
}

async function getTrackById(trackId) {
  return spotifyFetch(`/tracks/${trackId}`);
}

async function getCurrentlyPlaying() {
  try {
    return await spotifyFetch("/me/player/currently-playing");
  } catch (error) {
    console.warn("Currently playing unavailable:", error);
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

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
}

async function playTrackNow(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      uris: [trackUri]
    })
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
}

// ======================================================
// GOOGLE SHEET REQUEST LOADING
// A = Timestamp
// B = Email Address
// C = Spotify share link
// ======================================================
async function fetchStudentRequestRows() {
  const url =
    `${CONFIG.requestsCsvUrl}${CONFIG.requestsCsvUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV: ${response.status}`);
  }

  const text = await response.text();
  const rows = parseCSV(text);

  if (!rows.length) return [];

  return rows
    .slice(1)
    .filter((row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim() !== ""))
    .map((row) => ({
      timestamp: String(row[0] ?? "").trim(),
      email: String(row[1] ?? "").trim(),
      spotifyLink: String(row[2] ?? "").trim(),
      artistInput: "",
      songInput: ""
    }));
}

async function enrichRequestRows(rows) {
  const rejected = getRejectedIds();
  const enriched = [];

  for (const row of rows) {
    const requestId = buildRequestId(row);
    const trackId = extractSpotifyTrackId(row.spotifyLink);

    const result = {
      ...row,
      requestId,
      trackId,
      rejected: rejected.has(requestId),
      spotify: null,
      error: null
    };

    if (!trackId) {
      result.error = "Invalid or missing Spotify track link";
      enriched.push(result);
      continue;
    }

    try {
      const track = await getTrackById(trackId);

      result.spotify = {
        id: track.id,
        uri: track.uri,
        name: track.name,
        artist: track.artists?.map((a) => a.name).join(", ") || "",
        explicit: track.explicit,
        durationMs: track.duration_ms,
        externalUrl: track.external_urls?.spotify || spotifyTrackUrl(track.id),
        album: track.album?.name || ""
      };
    } catch (error) {
      result.error = error.message || "Spotify lookup failed";
    }

    enriched.push(result);
  }

  return enriched;
}

// ======================================================
// REQUEST SUMMARY + BADGES
// ======================================================
function isApproved(requestId) {
  const queue = getApprovedQueue();
  return queue && queue.some((item) => item.requestId === requestId);
}

function buildRequestSummary(requests) {
  const total = requests.length;
  const valid = requests.filter((r) => !!r.spotify).length;
  const clean = requests.filter((r) => r.spotify && r.spotify.explicit === false).length;
  const explicit = requests.filter((r) => r.spotify && r.spotify.explicit === true).length;
  const errors = requests.filter((r) => !r.spotify).length;

  el.requestSummary.textContent =
    `Loaded ${total} request(s) | Valid Spotify links: ${valid} | Clean: ${clean} | Explicit: ${explicit} | Errors: ${errors}`;
}

function getStatusBadgeHtml(request) {
  if (request.spotify && request.spotify.explicit === false) {
    return `<span class="badge clean">🟢 Clean</span>`;
  }

  if (request.spotify && request.spotify.explicit === true) {
    return `<span class="badge explicit">🔴 Explicit</span>`;
  }

  return `<span class="badge error">⚠️ Error</span>`;
}

// ======================================================
// APPROVE / REJECT
// ======================================================
function approveRequest(request) {
  if (!request.spotify) {
    setStatus("Cannot approve a request with no valid Spotify track.");
    return;
  }

  if (request.spotify.explicit) {
    setStatus("Cannot approve an explicit song.");
    return;
  }

  const queue = getApprovedQueue();

  if (queue.some((item) => item.requestId === request.requestId)) {
    setStatus("Song is already approved.");
    return;
  }

  queue.push({
    requestId: request.requestId,
    timestamp: request.timestamp,
    email: request.email,
    spotifyLink: request.spotifyLink,
    spotify: request.spotify
  });

  saveApprovedQueue(queue);
  renderApprovedQueue();
  renderRequests(currentRequests);

  setStatus(`Approved: ${request.spotify.artist} — ${request.spotify.name}`);
}

function rejectRequest(request) {
  const rejected = getRejectedIds();
  rejected.add(request.requestId);
  saveRejectedIds(rejected);
  renderRequests(currentRequests);
  setStatus("Request removed from unapproved list.");
}

function removeApproved(requestId) {
  const queue = getApprovedQueue().filter((item) => item.requestId !== requestId);
  saveApprovedQueue(queue);
  clampQueuePointer();
  renderApprovedQueue();
  renderRequests(currentRequests);
  updateUpNext();
  setStatus("Removed song from approved list.");
}

// ======================================================
// RENDER UNAPPROVED REQUESTS
// ======================================================
function renderRequests(requests) {
  const hideExplicit = !!el.hideExplicitOnly?.checked;
  const rejected = getRejectedIds();

  const visibleRequests = requests.filter((request) => {
    if (rejected.has(request.requestId)) return false;
    if (isApproved(request.requestId)) return false;
    if (hideExplicit && request.spotify && request.spotify.explicit === true) return false;
    return true;
  });

  if (!visibleRequests.length) {
    el.requestTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="empty-cell">No unapproved requests available with the current filter.</td>
      </tr>
    `;
    return;
  }

  el.requestTableBody.innerHTML = visibleRequests.map((request) => {
    const requestedLine = request.spotify
      ? `${escapeHtml(request.spotify.artist)} — ${escapeHtml(request.spotify.name)}`
      : `Spotify link submitted`;

    let spotifyMatchHtml = `<div class="spotify-match">${escapeHtml(request.error || "No Spotify match")}</div>`;
    if (request.spotify) {
      spotifyMatchHtml = `
        <div class="spotify-match">
          <a class="linklike" href="${escapeHtml(request.spotify.externalUrl)}" target="_blank" rel="noopener">
            ${escapeHtml(request.spotify.artist)} — ${escapeHtml(request.spotify.name)}
          </a>
        </div>
        <div class="song-meta">${escapeHtml(request.spotify.album)}</div>
      `;
    }

    const length = request.spotify ? msToMinSec(request.spotify.durationMs) : "—";
    const canApprove = request.spotify && request.spotify.explicit === false;

    return `
      <tr>
        <td>${escapeHtml(request.timestamp || "—")}</td>
        <td class="song-cell">
          <div>${requestedLine}</div>
          <div class="song-meta">${escapeHtml(request.email || "")}</div>
        </td>
        <td>${spotifyMatchHtml}</td>
        <td>${escapeHtml(length)}</td>
        <td>${getStatusBadgeHtml(request)}</td>
        <td>
          <div class="cell-actions">
            <button
              class="mini-btn approve"
              data-action="approve"
              data-id="${escapeHtml(request.requestId)}"
              ${canApprove ? "" : "disabled"}>
              Approve
            </button>

            <button
              class="mini-btn queue"
              data-action="playlist"
              data-id="${escapeHtml(request.requestId)}"
              ${request.spotify && request.spotify.explicit === false ? "" : "disabled"}>
              Add to Playlist
            </button>

            <button
              class="mini-btn reject"
              data-action="reject"
              data-id="${escapeHtml(request.requestId)}">
              Don't Approve
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join("");

  el.requestTableBody.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.action;
      const requestId = event.currentTarget.dataset.id;
      const request = currentRequests.find((item) => item.requestId === requestId);
      if (!request) return;

      try {
        if (action === "approve") {
          approveRequest(request);
        } else if (action === "reject") {
          rejectRequest(request);
        } else if (action === "playlist") {
          if (!request.spotify || request.spotify.explicit) return;
          await addTrackToPlaylist(request.spotify.uri);
          setStatus(`Added to Spotify playlist: ${request.spotify.artist} — ${request.spotify.name}`);
        }
      } catch (error) {
        console.error(error);
        setStatus(`Request action failed: ${error.message}`);
      }
    });
  });
}

// ======================================================
// APPROVED QUEUE RENDER
// ======================================================
function renderApprovedQueue() {
  const queue = getApprovedQueue();
  const currentIndex = clampQueuePointer();

  if (!queue.length) {
    el.approvedQueueList.innerHTML = `<li class="empty-item">No approved songs yet.</li>`;
    updateUpNext();
    return;
  }

  el.approvedQueueList.innerHTML = queue.map((item, index) => {
    const currentClass = index === currentIndex ? "queue-current" : "";

    return `
      <li class="${currentClass}">
        <div class="approved-line">
          ${index === currentIndex ? "▶ " : ""}${escapeHtml(item.spotify.artist)} — ${escapeHtml(item.spotify.name)}
        </div>

        <div class="approved-meta">
          Length: ${escapeHtml(msToMinSec(item.spotify.durationMs))}
          | Submitted by: ${escapeHtml(item.email || "Unknown")}
        </div>

        <div class="cell-actions" style="margin-top:8px;">
          <button class="mini-btn" data-approved-action="play" data-approved-id="${escapeHtml(item.requestId)}">Play</button>
          <button class="mini-btn queue" data-approved-action="queue" data-approved-id="${escapeHtml(item.requestId)}">Queue</button>
          <button class="mini-btn" data-approved-action="playlist" data-approved-id="${escapeHtml(item.requestId)}">Playlist</button>
          <button class="mini-btn reject" data-approved-action="remove" data-approved-id="${escapeHtml(item.requestId)}">Remove</button>
        </div>
      </li>
    `;
  }).join("");

  el.approvedQueueList.querySelectorAll("[data-approved-action]").forEach((button) => {
    button.addEventListener("click", async (event) => {
      const action = event.currentTarget.dataset.approvedAction;
      const requestId = event.currentTarget.dataset.approvedId;
      const queue = getApprovedQueue();
      const item = queue.find((q) => q.requestId === requestId);
      const itemIndex = queue.findIndex((q) => q.requestId === requestId);

      if (!item) return;

      try {
        if (action === "remove") {
          removeApproved(requestId);
        } else if (action === "play") {
          await playTrackNow(item.spotify.uri);
          setQueuePointer(Math.max(0, itemIndex));
          renderApprovedQueue();
          updateUpNext();
          setStatus(`Playing now: ${item.spotify.artist} — ${item.spotify.name}`);
          await refreshPlayback();
        } else if (action === "queue") {
          await addTrackToSpotifyQueue(item.spotify.uri);
          setStatus(`Added to Spotify queue: ${item.spotify.artist} — ${item.spotify.name}`);
        } else if (action === "playlist") {
          await addTrackToPlaylist(item.spotify.uri);
          setStatus(`Added to Spotify playlist: ${item.spotify.artist} — ${item.spotify.name}`);
        }
      } catch (error) {
        console.error(error);
        setStatus(`Approved action failed: ${error.message}`);
      }
    });
  });

  updateUpNext();
}

function updateUpNext() {
  const queue = getApprovedQueue();
  const index = clampQueuePointer();

  if (!queue.length) {
    el.upNext.textContent = "No approved songs yet";
    return;
  }

  const next = queue[index + 1];
  if (!next) {
    el.upNext.textContent = "End of approved list";
    return;
  }

  el.upNext.textContent =
    `${next.spotify.artist} — ${next.spotify.name} (${msToMinSec(next.spotify.durationMs)})`;
}

// ======================================================
// QUEUE NAVIGATION + CURRENT SONG ACTIONS
// ======================================================
function goPrevQueue() {
  const nextIndex = Math.max(0, getQueuePointer() - 1);
  setQueuePointer(nextIndex);
  renderApprovedQueue();
}

function goNextQueue() {
  const queue = getApprovedQueue();
  const nextIndex = Math.min(Math.max(0, queue.length - 1), getQueuePointer() + 1);
  setQueuePointer(nextIndex);
  renderApprovedQueue();
}

async function playCurrentApproved() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs to play.");
    return;
  }

  const index = clampQueuePointer();
  const item = queue[index];
  if (!item) return;

  await playTrackNow(item.spotify.uri);
  setStatus(`Playing approved song: ${item.spotify.artist} — ${item.spotify.name}`);
  await refreshPlayback();
}

async function addCurrentApprovedToQueue() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs to queue.");
    return;
  }

  const index = clampQueuePointer();
  const item = queue[index];
  if (!item) return;

  await addTrackToSpotifyQueue(item.spotify.uri);
  setStatus(`Queued approved song: ${item.spotify.artist} — ${item.spotify.name}`);
}

// ======================================================
// PLAYBACK UI
// ======================================================
async function refreshPlayback() {
  const playback = await getCurrentlyPlaying();

  if (!playback || !playback.item) {
    el.nowPlaying.textContent = "Nothing currently loaded";
    el.nowPlayingMeta.textContent =
      "Open Spotify on an active Premium device, then play or queue a track.";
    return;
  }

  const track = playback.item;
  const artist = track.artists?.map((a) => a.name).join(", ") || "Unknown artist";
  const title = track.name || "Unknown track";
  const album = track.album?.name || "Unknown album";

  el.nowPlaying.textContent = `${artist} — ${title}`;
  el.nowPlayingMeta.textContent =
    `Album: ${album} | Length: ${msToMinSec(track.duration_ms)} | Explicit: ${track.explicit ? "Yes" : "No"}`;
}

function startPlaybackPolling() {
  if (playbackTimer) clearInterval(playbackTimer);

  playbackTimer = setInterval(() => {
    refreshPlayback().catch((error) => {
      console.warn("Playback refresh failed:", error);
    });
  }, CONFIG.playbackPollMs);
}

// ======================================================
// LOAD REQUESTS
// ======================================================
async function loadStudentRequests() {
  setStatus("Loading student requests from Google Forms...");
  const rawRows = await fetchStudentRequestRows();

  setStatus(`Found ${rawRows.length} request row(s). Checking Spotify metadata...`);
  currentRequests = await enrichRequestRows(rawRows);

  buildRequestSummary(currentRequests);
  renderRequests(currentRequests);

  setStatus("Requests loaded.");
}

// ======================================================
// EVENTS
// ======================================================
function bindEvents() {
  el.btnLogin?.addEventListener("click", loginToSpotify);
  el.btnLogout?.addEventListener("click", logoutSpotify);

  el.btnLoadRequests?.addEventListener("click", async () => {
    try {
      await loadStudentRequests();
    } catch (error) {
      console.error(error);
      setStatus(`Load requests failed: ${error.message}`);
    }
  });

  el.btnRefreshPlayback?.addEventListener("click", async () => {
    try {
      await refreshPlayback();
      setStatus("Playback refreshed.");
    } catch (error) {
      console.error(error);
      setStatus(`Playback refresh failed: ${error.message}`);
    }
  });

  el.btnPrevQueue?.addEventListener("click", goPrevQueue);
  el.btnNextQueue?.addEventListener("click", goNextQueue);

  el.btnPlayApproved?.addEventListener("click", async () => {
    try {
      await playCurrentApproved();
    } catch (error) {
      console.error(error);
      setStatus(`Play failed: ${error.message}`);
    }
  });

  el.btnAddApprovedToQueue?.addEventListener("click", async () => {
    try {
      await addCurrentApprovedToQueue();
    } catch (error) {
      console.error(error);
      setStatus(`Queue add failed: ${error.message}`);
    }
  });

  el.hideExplicitOnly?.addEventListener("change", () => {
    renderRequests(currentRequests);
  });
}

// ======================================================
// INIT
// ======================================================
async function init() {
  ensureStorageDefaults();
  bindEvents();
  renderApprovedQueue();
  updateUpNext();

  try {
    await handleSpotifyCallback();
  } catch (error) {
    console.error(error);
    setStatus(`Spotify auth failed: ${error.message}`);
  }

  try {
    await refreshPlayback();
  } catch (error) {
    console.warn("Initial playback refresh failed:", error);
  }

  startPlaybackPolling();
  setStatus("Ready.");
}

init();
