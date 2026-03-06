// ======================================================
// ALA Music Requester
// Full compiled app.js
// ======================================================

// --------------------
// CONFIG
// --------------------
const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUri: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/",
  playlistId: "3dcGJ6miJHVxZkQEIwGog5",
  requestsCsvUrl:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQyc3RRDmjc-nN-XgMMDocbnn1tlxue5ynNoNnYSxnRKxgp2LRGNmYZXnVgAFLH7IViwTAtmIAkvDsK/pub?output=csv",
  scopes: [
    "user-read-private",
    "user-read-email",
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
  btnVerifyPlaylistAccess: document.getElementById("btnVerifyPlaylistAccess"),

  status: document.getElementById("status"),
  nowPlaying: document.getElementById("nowPlaying"),
  nowPlayingMeta: document.getElementById("nowPlayingMeta"),
  nowPlayingArt: document.getElementById("nowPlayingArt"),

  upNext: document.getElementById("upNext"),
  upNextArt: document.getElementById("upNextArt"),

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
    .replaceAll("'", "&#39;");
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

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function buildRequestId(row) {
  return [row.timestamp || "", row.email || "", row.spotifyLink || ""].join("|");
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
      if (ch === "\r" && next === "\n") i++;
      row.push(current);
      rows.push(row);
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

  return rows.filter((r) => Array.isArray(r) && r.length > 0);
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
  url.searchParams.delete("state");
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

async function getCurrentUserProfile() {
  return spotifyFetch("/me");
}

async function getPlaylistDetails(playlistId) {
  return spotifyFetch(`/playlists/${playlistId}`);
}

function normalizeSpotifyUserId(value) {
  return String(value ?? "").trim().toLowerCase();
}

async function verifyPlaylistAccess() {
  try {
    setStatus("Checking Spotify account and playlist access...");

    const me = await getCurrentUserProfile();
    const playlist = await getPlaylistDetails(CONFIG.playlistId);

    const currentUserId = normalizeSpotifyUserId(me?.id);
    const currentDisplay =
      me?.display_name || me?.id || "Unknown user";

    const ownerUserId = normalizeSpotifyUserId(playlist?.owner?.id);
    const ownerDisplay =
      playlist?.owner?.display_name || playlist?.owner?.id || "Unknown owner";

    const collaborative = !!playlist?.collaborative;
    const publicState =
      typeof playlist?.public === "boolean" ? String(playlist.public) : "unknown";

    const isOwner = currentUserId && ownerUserId && currentUserId === ownerUserId;

    let messageParts = [
      `Logged in as: ${currentDisplay}`,
      `Playlist owner: ${ownerDisplay}`,
      `Playlist name: ${playlist?.name || "Unknown playlist"}`,
      `Collaborative: ${collaborative ? "Yes" : "No"}`,
      `Public: ${publicState}`
    ];

    if (isOwner) {
      messageParts.push("Access check: You are the playlist owner.");
    } else if (collaborative) {
      messageParts.push(
        "Access check: You are not the owner. Because the playlist is collaborative, editing may be allowed depending on the account and playlist settings."
      );
    } else {
      messageParts.push(
        "Access check: You are not the playlist owner, and the playlist is not collaborative. Add to Playlist will likely fail."
      );
    }

    const finalMessage = messageParts.join(" | ");
    setStatus(finalMessage);

    console.log("Playlist access check:", {
      loggedInUser: me,
      playlist,
      isOwner,
      collaborative
    });

    return {
      me,
      playlist,
      isOwner,
      collaborative
    };
  } catch (error) {
    console.error("verifyPlaylistAccess failed:", error);
    setStatus(error?.message || "Playlist access check failed.");
    return null;
  }
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

async function getAvailableDevices() {
  return spotifyFetch("/me/player/devices");
}

async function transferPlaybackToDevice(deviceId, shouldPlay = false) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      device_ids: [deviceId],
      play: shouldPlay
    })
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
}

async function ensureActiveDevice() {
  const deviceData = await getAvailableDevices();
  const devices = deviceData?.devices || [];

  if (!devices.length) {
    throw new Error(
      "No Spotify devices found. Open Spotify on your phone, desktop app, or web player and start playback first."
    );
  }

  const activeDevice = devices.find((d) => d.is_active);
  if (activeDevice) return activeDevice;

  const controllable = devices.find((d) => !d.is_restricted) || devices[0];

  if (!controllable?.id) {
    throw new Error(
      "A Spotify device was found, but it cannot be controlled. Open Spotify and start playback manually first."
    );
  }

  await transferPlaybackToDevice(controllable.id, false);
  return controllable;
}

async function addTrackToPlaylist(trackUri) {
  try {
    return await spotifyFetch(`/playlists/${CONFIG.playlistId}/tracks`, {
      method: "POST",
      body: JSON.stringify({ uris: [trackUri] })
    });
  } catch (error) {
    const msg = String(error?.message || "");

    if (msg.includes("403")) {
      throw new Error(
        "Spotify blocked Add to Playlist. Make sure you are logged into the Spotify account that owns this playlist or can edit it."
      );
    }

    if (msg.includes("404")) {
      throw new Error("Playlist not found. Double-check the playlistId in CONFIG.");
    }

    throw error;
  }
}

async function addTrackToSpotifyQueue(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  await ensureActiveDevice();

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

    if (response.status === 404 && text.includes("NO_ACTIVE_DEVICE")) {
      throw new Error(
        "No active Spotify device found. Open Spotify and start playback on a Premium account, then try again."
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Spotify blocked Add to Queue. Usually this means the account is not Premium or the player/device cannot be controlled."
      );
    }

    throw new Error(`${response.status} ${text}`);
  }
}

async function playTrackNow(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  await ensureActiveDevice();

  const response = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ uris: [trackUri] })
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();

    if (response.status === 404 && text.includes("NO_ACTIVE_DEVICE")) {
      throw new Error(
        "No active Spotify device found. Open Spotify and start playback first."
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Spotify blocked playback. Usually this means the logged-in account is not Premium."
      );
    }

    throw new Error(`${response.status} ${text}`);
  }
}

// ======================================================
// GOOGLE SHEET REQUEST LOADING
// ======================================================
function findHeaderIndex(headers, candidates, fallbackIndex = -1) {
  const normalized = headers.map(normalizeHeader);

  for (const candidate of candidates) {
    const target = normalizeHeader(candidate);
    const idx = normalized.findIndex((h) => h === target);
    if (idx !== -1) return idx;
  }

  for (const candidate of candidates) {
    const target = normalizeHeader(candidate);
    const idx = normalized.findIndex((h) => h.includes(target));
    if (idx !== -1) return idx;
  }

  return fallbackIndex;
}

async function fetchStudentRequestRows() {
  const url = `${CONFIG.requestsCsvUrl}${CONFIG.requestsCsvUrl.includes("?") ? "&" : "?"}t=${Date.now()}`;

  const response = await fetch(url, {
    method: "GET",
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV: ${response.status}`);
  }

  const text = await response.text();
  const rows = parseCSV(text);

  if (!rows.length) return [];

  const headers = rows[0].map((cell) => String(cell ?? "").trim());

  const timestampIndex = findHeaderIndex(headers, ["Timestamp"], 0);
  const emailIndex = findHeaderIndex(
    headers,
    ["Email Address", "Email", "Student Email"],
    1
  );

  const spotifyLinkIndex = findHeaderIndex(
    headers,
    [
      "Please insert the Spotify song share link here:",
      "Spotify share link",
      "Spotify song share link",
      "Spotify link",
      "Song Link",
      "Track Link"
    ],
    2
  );

  if (spotifyLinkIndex === -1) {
    throw new Error(
      `Could not find the Spotify link column in the sheet headers: ${headers.join(" | ")}`
    );
  }

  const dataRows = rows
    .slice(1)
    .filter(
      (row) =>
        Array.isArray(row) &&
        row.some((cell) => String(cell ?? "").trim() !== "")
    )
    .map((row) => ({
      timestamp: String(row[timestampIndex] ?? "").trim(),
      email: String(row[emailIndex] ?? "").trim(),
      spotifyLink: String(row[spotifyLinkIndex] ?? "").trim(),
      artistInput: "",
      songInput: ""
    }))
    .filter((row) => row.spotifyLink);

  return dataRows;
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
        explicit: !!track.explicit,
        durationMs: track.duration_ms,
        externalUrl: track.external_urls?.spotify || spotifyTrackUrl(track.id),
        album: track.album?.name || "",
        image:
          track.album?.images?.[0]?.url ||
          track.album?.images?.[1]?.url ||
          track.album?.images?.[2]?.url ||
          "",
        previewUrl: track.preview_url || ""
      };
    } catch (error) {
      result.error = error?.message || "Spotify lookup failed";
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
  return queue.some((item) => item.requestId === requestId);
}

function buildRequestSummary(requests) {
  const total = requests.length;
  const valid = requests.filter((r) => !!r.spotify).length;
  const clean = requests.filter((r) => r.spotify && r.spotify.explicit === false).length;
  const explicit = requests.filter((r) => r.spotify && r.spotify.explicit === true).length;
  const errors = requests.filter((r) => !r.spotify).length;

  if (el.requestSummary) {
    el.requestSummary.textContent =
      `Loaded ${total} request(s) | Valid Spotify links: ${valid} | Clean: ${clean} | Explicit: ${explicit} | Errors: ${errors}`;
  }
}

function getStatusBadgeHtml(request) {
  if (request.spotify && request.spotify.explicit === false) {
    return `<span class="badge badge-clean">Clean</span>`;
  }
  if (request.spotify && request.spotify.explicit === true) {
    return `<span class="badge badge-explicit">Explicit</span>`;
  }
  return `<span class="badge badge-error">Error</span>`;
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
  if (!el.requestTableBody) return;

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
      <div class="empty-state">
        No unapproved requests available with the current filter.
      </div>
    `;
    return;
  }

  el.requestTableBody.innerHTML = visibleRequests
    .map((request) => {
      const songTitle = request.spotify?.name || "Unknown track";
      const artistName = request.spotify?.artist || "Unknown artist";
      const image = request.spotify?.image || "";
      const album = request.spotify?.album || "Unknown Album";
      const explicitClass = request.spotify
        ? request.spotify.explicit
          ? "badge-explicit"
          : "badge-clean"
        : "badge-error";

      const explicitText = request.spotify
        ? request.spotify.explicit
          ? "Explicit"
          : "Clean"
        : "Error";

      const approveDisabled = !request.spotify || request.spotify.explicit ? "disabled" : "";

      return `
        <div class="request-item">
          <div class="request-art-wrap">
            ${
              image
                ? `<img class="request-art" src="${escapeHtml(image)}" alt="${escapeHtml(songTitle)} cover art">`
                : `<div class="request-art request-art-placeholder">No Art</div>`
            }
          </div>

          <div class="request-main">
            <div class="request-title-row">
              <div class="request-song">${escapeHtml(songTitle)}</div>
              <span class="badge ${explicitClass}">${explicitText}</span>
            </div>

            <div class="request-artist">${escapeHtml(artistName)}</div>
            <div class="request-meta">
              ${escapeHtml(album)} • ${request.spotify ? escapeHtml(msToMinSec(request.spotify.durationMs)) : "—"}
            </div>
            <div class="request-submitted">
              ${escapeHtml(request.timestamp || "—")}
            </div>
          </div>

          <div class="request-actions">
            ${
              request.spotify
                ? `<a class="ghost-btn" href="${escapeHtml(request.spotify.externalUrl)}" target="_blank" rel="noopener noreferrer">Open in Spotify</a>`
                : `<span class="error-text">${escapeHtml(request.error || "No match")}</span>`
            }

            <button class="approve-btn" data-request-id="${escapeHtml(request.requestId)}" ${approveDisabled}>
              Approve
            </button>

            <button class="reject-btn" data-request-id="${escapeHtml(request.requestId)}">
              Reject
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

// ======================================================
// RENDER APPROVED QUEUE
// ======================================================
function renderApprovedQueue() {
  if (!el.approvedQueueList) return;

  const queue = getApprovedQueue();
  clampQueuePointer();

  if (!queue.length) {
    el.approvedQueueList.innerHTML = `<div class="empty-state">No approved songs yet.</div>`;
    updateUpNext();
    return;
  }

  const pointer = getQueuePointer();

  el.approvedQueueList.innerHTML = queue
    .map((item, index) => {
      const activeClass = index === pointer ? " queue-item-active" : "";
      const artist = item.spotify?.artist || "Unknown Artist";
      const name = item.spotify?.name || "Unknown Song";
      const image = item.spotify?.image || "";

      return `
        <div class="queue-item${activeClass}">
          <div class="queue-item-art-wrap">
            ${
              image
                ? `<img class="queue-item-art" src="${escapeHtml(image)}" alt="${escapeHtml(name)} cover art">`
                : `<div class="queue-item-art queue-item-art-placeholder">No Art</div>`
            }
          </div>

          <div class="queue-item-main">
            <div class="queue-item-title">${escapeHtml(name)}</div>
            <div class="queue-item-artist">${escapeHtml(artist)}</div>
          </div>

          <div class="queue-item-actions">
            <button class="remove-approved-btn" data-request-id="${escapeHtml(item.requestId)}">
              Remove
            </button>
            <button class="add-playlist-btn" data-request-id="${escapeHtml(item.requestId)}">
              Add to Playlist
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  updateUpNext();
}

function updateUpNext() {
  if (!el.upNext) return;

  const queue = getApprovedQueue();

  if (!queue.length) {
    el.upNext.textContent = "No approved songs yet";

    if (el.upNextArt) {
      el.upNextArt.src = "";
      el.upNextArt.style.visibility = "hidden";
    }
    return;
  }

  const pointer = clampQueuePointer();
  const current = queue[pointer];

  if (!current?.spotify) {
    el.upNext.textContent = "No approved songs yet";

    if (el.upNextArt) {
      el.upNextArt.src = "";
      el.upNextArt.style.visibility = "hidden";
    }
    return;
  }

  el.upNext.textContent = `${current.spotify.artist} — ${current.spotify.name}`;

  if (el.upNextArt) {
    el.upNextArt.src = current.spotify.image || "";
    el.upNextArt.alt = `${current.spotify.name} cover art`;
    el.upNextArt.style.visibility = current.spotify.image ? "visible" : "hidden";
  }
}

// ======================================================
// PLAYBACK
// ======================================================
async function refreshPlayback() {
  if (!el.nowPlaying || !el.nowPlayingMeta) return;

  try {
    const data = await getCurrentlyPlaying();

    if (!data || !data.item) {
      el.nowPlaying.textContent = "Nothing currently loaded";
      el.nowPlayingMeta.textContent = "Waiting for playback data...";

      if (el.nowPlayingArt) {
        el.nowPlayingArt.src = "";
        el.nowPlayingArt.style.visibility = "hidden";
      }
      return;
    }

    const item = data.item;
    const artists = item.artists?.map((a) => a.name).join(", ") || "Unknown Artist";
    const image =
      item.album?.images?.[0]?.url ||
      item.album?.images?.[1]?.url ||
      item.album?.images?.[2]?.url ||
      "";

    el.nowPlaying.textContent = `${artists} — ${item.name}`;
    el.nowPlayingMeta.textContent =
      `${item.album?.name || "Unknown Album"} | ${msToMinSec(item.duration_ms)}`;

    if (el.nowPlayingArt) {
      el.nowPlayingArt.src = image;
      el.nowPlayingArt.alt = `${item.name} cover art`;
      el.nowPlayingArt.style.visibility = image ? "visible" : "hidden";
    }
  } catch (error) {
    el.nowPlaying.textContent = "Nothing currently loaded";
    el.nowPlayingMeta.textContent = error?.message || "Playback unavailable";

    if (el.nowPlayingArt) {
      el.nowPlayingArt.src = "";
      el.nowPlayingArt.style.visibility = "hidden";
    }
  }
}

function moveQueuePointer(delta) {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setQueuePointer(0);
    renderApprovedQueue();
    return;
  }

  let pointer = getQueuePointer() + delta;
  if (pointer < 0) pointer = 0;
  if (pointer > queue.length - 1) pointer = queue.length - 1;

  setQueuePointer(pointer);
  renderApprovedQueue();
}

async function playCurrentApproved() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs available.");
    return;
  }

  const pointer = clampQueuePointer();
  const item = queue[pointer];

  if (!item?.spotify?.uri) {
    setStatus("Approved song is missing Spotify track data.");
    return;
  }

  await playTrackNow(item.spotify.uri);
  setStatus(`Playing now: ${item.spotify.artist} — ${item.spotify.name}`);
  await refreshPlayback();
}

async function addCurrentApprovedToQueue() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    setStatus("No approved songs available.");
    return;
  }

  const pointer = clampQueuePointer();
  const item = queue[pointer];

  if (!item?.spotify?.uri) {
    setStatus("Approved song is missing Spotify track data.");
    return;
  }

  await addTrackToSpotifyQueue(item.spotify.uri);
  setStatus(`Added to Spotify queue: ${item.spotify.artist} — ${item.spotify.name}`);
}

async function addApprovedSongToPlaylist(requestId) {
  const queue = getApprovedQueue();
  const item = queue.find((q) => q.requestId === requestId);

  if (!item?.spotify?.uri) {
    setStatus("Could not add song to playlist.");
    return;
  }

  await addTrackToPlaylist(item.spotify.uri);
  setStatus(`Added to playlist: ${item.spotify.artist} — ${item.spotify.name}`);
}

// ======================================================
// LOAD REQUESTS
// ======================================================
async function loadRequests() {
  setStatus("Loading request rows from Google Sheet...");

  const rawRows = await fetchStudentRequestRows();
  setStatus(`Loaded ${rawRows.length} raw request row(s). Looking up Spotify tracks...`);

  const enriched = await enrichRequestRows(rawRows);
  currentRequests = enriched;

  buildRequestSummary(enriched);
  renderRequests(enriched);
  renderApprovedQueue();

  setStatus(`Finished loading ${enriched.length} request(s).`);
}

// ======================================================
// EVENT WIRING
// ======================================================
function wireStaticEvents() {
  el.btnLogin?.addEventListener("click", async () => {
    try {
      await loginToSpotify();
    } catch (error) {
      setStatus(error?.message || "Spotify login failed.");
    }
  });

  el.btnLogout?.addEventListener("click", () => {
    logoutSpotify();
  });

  el.btnLoadRequests?.addEventListener("click", async () => {
    try {
      await loadRequests();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Failed to load requests.");
    }
  });

  el.btnRefreshPlayback?.addEventListener("click", async () => {
    try {
      await refreshPlayback();
      setStatus("Playback refreshed.");
    } catch (error) {
      setStatus(error?.message || "Failed to refresh playback.");
    }
  });

  el.btnPrevQueue?.addEventListener("click", () => {
    moveQueuePointer(-1);
  });

  el.btnNextQueue?.addEventListener("click", () => {
    moveQueuePointer(1);
  });

  el.btnPlayApproved?.addEventListener("click", async () => {
    try {
      await playCurrentApproved();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not play approved song.");
    }
  });

  el.btnAddApprovedToQueue?.addEventListener("click", async () => {
    try {
      await addCurrentApprovedToQueue();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not add approved song to Spotify queue.");
    }
  });

  el.hideExplicitOnly?.addEventListener("change", () => {
    renderRequests(currentRequests);
  });

  el.requestTableBody?.addEventListener("click", async (event) => {
    const approveButton = event.target.closest(".approve-btn");
    const rejectButton = event.target.closest(".reject-btn");

    if (approveButton) {
      const requestId = approveButton.dataset.requestId;
      const request = currentRequests.find((r) => r.requestId === requestId);
      if (request) approveRequest(request);
      return;
    }

    if (rejectButton) {
      const requestId = rejectButton.dataset.requestId;
      const request = currentRequests.find((r) => r.requestId === requestId);
      if (request) rejectRequest(request);
    }
  });

  el.approvedQueueList?.addEventListener("click", async (event) => {
    const removeButton = event.target.closest(".remove-approved-btn");
    const addToPlaylistButton = event.target.closest(".add-playlist-btn");

    if (removeButton) {
      removeApproved(removeButton.dataset.requestId);
      return;
    }

    if (addToPlaylistButton) {
      try {
        await addApprovedSongToPlaylist(addToPlaylistButton.dataset.requestId);
      } catch (error) {
        console.error(error);
        setStatus(error?.message || "Could not add song to playlist.");
      }
    }
  });
}

// ======================================================
// AUTO REFRESH PLAYBACK
// ======================================================
function startPlaybackPolling() {
  stopPlaybackPolling();

  playbackTimer = window.setInterval(async () => {
    try {
      await refreshPlayback();
    } catch (error) {
      console.warn("Playback poll failed:", error);
    }
  }, CONFIG.playbackPollMs);
}

function stopPlaybackPolling() {
  if (playbackTimer) {
    window.clearInterval(playbackTimer);
    playbackTimer = null;
  }
}

// ======================================================
// INIT
// ======================================================
async function init() {
  ensureStorageDefaults();
  wireStaticEvents();
  renderApprovedQueue();
  buildRequestSummary([]);
  await handleSpotifyCallback();

  try {
    const me = await getCurrentUserProfile();
    if (me?.display_name) {
      setStatus(`Ready. Logged in as ${me.display_name}.`);
    } else {
      setStatus("Ready.");
    }
  } catch {
    setStatus("Ready.");
  }

  try {
    await refreshPlayback();
  } catch (error) {
    console.warn("Initial playback refresh failed:", error);
  }

  startPlaybackPolling();
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error(error);
    setStatus(error?.message || "App failed to initialize.");
  });
});
