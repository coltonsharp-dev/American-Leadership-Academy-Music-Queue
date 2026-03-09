// ======================================================
// ALA Music Requester Dashboard
// One-page version with default playlist + queue viewer
// ======================================================

// --------------------
// CONFIG
// --------------------
const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUri: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/",
  defaultPlaylistId: "3dcGJ6miJHVxZkQEIwGog5",
  requestsCsvUrl:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vQyc3RRDmjc-nN-XgMMDocbnn1tlxue5ynNoNnYSxnRKxgp2LRGNmYZXnVgAFLH7IViwTAtmIAkvDsK/pub?output=csv",
  scopes: [
    "user-read-private",
    "user-read-email",
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing"
  ],
  playbackPollMs: 15000
};

// --------------------
// LOCAL STORAGE KEYS
// --------------------
const LS = {
  pkceVerifier: "ala_dash_pkce_verifier",
  accessToken: "ala_dash_access_token",
  refreshToken: "ala_dash_refresh_token",
  expiresAt: "ala_dash_expires_at",
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
  btnStartDefaultPlaylist: document.getElementById("btnStartDefaultPlaylist"),
  btnAddApprovedToQueue: document.getElementById("btnAddApprovedToQueue"),

  status: document.getElementById("status"),
  nowPlaying: document.getElementById("nowPlaying"),
  nowPlayingMeta: document.getElementById("nowPlayingMeta"),
  nowPlayingArt: document.getElementById("nowPlayingArt"),

  hideExplicitOnly: document.getElementById("hideExplicitOnly"),
  requestSummary: document.getElementById("requestSummary"),
  requestTableBody: document.getElementById("requestTableBody"),
  approvedQueueList: document.getElementById("approvedQueueList"),
  approvedPreviewTable: document.getElementById("approvedPreviewTable"),
  spotifyQueueList: document.getElementById("spotifyQueueList")
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

function isTrackObject(item) {
  return !!item && item.type === "track";
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
    scope: CONFIG.scopes.join(" "),
    show_dialog: "true"
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

async function getSpotifyQueue() {
  return spotifyFetch("/me/player/queue");
}

async function ensureActiveDevice() {
  const deviceData = await getAvailableDevices();
  const devices = deviceData?.devices || [];

  if (!devices.length) {
    throw new Error(
      "No active Spotify device found. Open Spotify in another window or app and start playback there first."
    );
  }

  const activeDevice = devices.find((d) => d.is_active);
  if (activeDevice) return activeDevice;

  const controllable = devices.find((d) => !d.is_restricted) || devices[0];
  if (!controllable?.id) {
    throw new Error("A Spotify device was found, but it cannot be controlled.");
  }

  return controllable;
}

async function startDefaultPlaylist() {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const device = await ensureActiveDevice();

  const response = await fetch(
    `https://api.spotify.com/v1/me/player/play?device_id=${encodeURIComponent(device.id)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        context_uri: `spotify:playlist:${CONFIG.defaultPlaylistId}`
      })
    }
  );

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
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
        "No active Spotify device found. Open Spotify and start playback first."
      );
    }

    if (response.status === 403) {
      throw new Error(
        "Spotify blocked Add to Queue. This usually means the account is not Premium or the device cannot be controlled."
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
  const emailIndex = findHeaderIndex(headers, ["Email Address", "Email", "Student Email"], 1);
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

  return rows
    .slice(1)
    .filter(
      (row) =>
        Array.isArray(row) &&
        row.some((cell) => String(cell ?? "").trim() !== "")
    )
    .map((row) => ({
      timestamp: String(row[timestampIndex] ?? "").trim(),
      email: String(row[emailIndex] ?? "").trim(),
      spotifyLink: String(row[spotifyLinkIndex] ?? "").trim()
    }))
    .filter((row) => row.spotifyLink);
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
          ""
      };
    } catch (error) {
      result.error = error?.message || "Spotify lookup failed";
    }

    enriched.push(result);
  }

  return enriched;
}

// ======================================================
// REQUEST SUMMARY
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
  renderApprovedPreview();

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
  renderApprovedPreview();
  setStatus("Removed song from approved list.");
}

// ======================================================
// RENDER REQUESTS
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

function renderApprovedQueue() {
  if (!el.approvedQueueList) return;

  const queue = getApprovedQueue();
  clampQueuePointer();

  if (!queue.length) {
    el.approvedQueueList.innerHTML = `<div class="empty-state">No approved songs yet.</div>`;
    renderApprovedPreview();
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
        <div class="queue-item${activeClass}" data-queue-index="${index}">
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
          </div>
        </div>
      `;
    })
    .join("");

  renderApprovedPreview();
}

function renderApprovedPreview() {
  if (!el.approvedPreviewTable) return;

  const queue = getApprovedQueue();

  if (!queue.length) {
    el.approvedPreviewTable.innerHTML = `<div class="empty-state">No approved songs yet.</div>`;
    return;
  }

  const pointer = clampQueuePointer();
  const current = queue[pointer];

  if (!current?.spotify) {
    el.approvedPreviewTable.innerHTML = `<div class="empty-state">No approved songs yet.</div>`;
    return;
  }

  const item = current.spotify;

  el.approvedPreviewTable.innerHTML = `
    <div class="request-item queue-item-active">
      <div class="request-art-wrap">
        ${
          item.image
            ? `<img class="request-art" src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)} cover art">`
            : `<div class="request-art request-art-placeholder">No Art</div>`
        }
      </div>

      <div class="request-main">
        <div class="request-title-row">
          <div class="request-song">${escapeHtml(item.name)}</div>
          <span class="badge badge-clean">Approved</span>
        </div>

        <div class="request-artist">${escapeHtml(item.artist || "Unknown artist")}</div>
        <div class="request-meta">
          ${escapeHtml(item.album || "Unknown Album")} • ${escapeHtml(msToMinSec(item.durationMs))}
        </div>
        <div class="request-submitted">Selected approved track preview</div>
      </div>

      <div class="request-actions">
        <a class="ghost-btn" href="${escapeHtml(item.externalUrl || "#")}" target="_blank" rel="noopener noreferrer">
          Open in Spotify
        </a>
      </div>
    </div>
  `;
}

function renderSpotifyQueue(queueData) {
  if (!el.spotifyQueueList) return;

  const currentlyPlaying = queueData?.currently_playing;
  const queue = Array.isArray(queueData?.queue) ? queueData.queue : [];

  if (!currentlyPlaying && !queue.length) {
    el.spotifyQueueList.innerHTML = `<div class="empty-state">Spotify queue is empty or unavailable.</div>`;
    return;
  }

  const blocks = [];

  if (currentlyPlaying && isTrackObject(currentlyPlaying)) {
    blocks.push(`
      <div class="request-item queue-item-active">
        <div class="request-art-wrap">
          ${
            currentlyPlaying.album?.images?.[0]?.url
              ? `<img class="request-art" src="${escapeHtml(currentlyPlaying.album.images[0].url)}" alt="${escapeHtml(currentlyPlaying.name)} cover art">`
              : `<div class="request-art request-art-placeholder">No Art</div>`
          }
        </div>

        <div class="request-main">
          <div class="request-title-row">
            <div class="request-song">${escapeHtml(currentlyPlaying.name)}</div>
            <span class="badge badge-clean">Now Playing</span>
          </div>

          <div class="request-artist">${escapeHtml(
            (currentlyPlaying.artists || []).map((a) => a.name).join(", ") || "Unknown artist"
          )}</div>
          <div class="request-meta">
            ${escapeHtml(currentlyPlaying.album?.name || "Unknown Album")} • ${escapeHtml(msToMinSec(currentlyPlaying.duration_ms))}
          </div>
        </div>

        <div class="request-actions">
          <a class="ghost-btn" href="${escapeHtml(currentlyPlaying.external_urls?.spotify || "#")}" target="_blank" rel="noopener noreferrer">
            Open in Spotify
          </a>
        </div>
      </div>
    `);
  }

  queue.forEach((item, index) => {
    if (!isTrackObject(item)) return;

    blocks.push(`
      <div class="request-item">
        <div class="request-art-wrap">
          ${
            item.album?.images?.[0]?.url
              ? `<img class="request-art" src="${escapeHtml(item.album.images[0].url)}" alt="${escapeHtml(item.name)} cover art">`
              : `<div class="request-art request-art-placeholder">No Art</div>`
          }
        </div>

        <div class="request-main">
          <div class="request-title-row">
            <div class="request-song">${escapeHtml(item.name)}</div>
            <span class="badge badge-clean">Queue #${index + 1}</span>
          </div>

          <div class="request-artist">${escapeHtml(
            (item.artists || []).map((a) => a.name).join(", ") || "Unknown artist"
          )}</div>
          <div class="request-meta">
            ${escapeHtml(item.album?.name || "Unknown Album")} • ${escapeHtml(msToMinSec(item.duration_ms))}
          </div>
        </div>

        <div class="request-actions">
          <a class="ghost-btn" href="${escapeHtml(item.external_urls?.spotify || "#")}" target="_blank" rel="noopener noreferrer">
            Open in Spotify
          </a>
        </div>
      </div>
    `);
  });

  el.spotifyQueueList.innerHTML = blocks.join("");
}

// ======================================================
// PLAYBACK PREVIEW
// ======================================================
async function refreshPlayback() {
  if (!el.nowPlaying || !el.nowPlayingMeta) return;

  try {
    const [playbackData, queueData] = await Promise.all([
      getCurrentlyPlaying(),
      getSpotifyQueue().catch(() => null)
    ]);

    if (!playbackData || !playbackData.item) {
      el.nowPlaying.textContent = "Nothing currently loaded";
      el.nowPlayingMeta.textContent = "Waiting for playback data...";

      if (el.nowPlayingArt) {
        el.nowPlayingArt.src = "";
        el.nowPlayingArt.style.visibility = "hidden";
      }
    } else {
      const item = playbackData.item;
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
    }

    renderSpotifyQueue(queueData);
  } catch (error) {
    el.nowPlaying.textContent = "Nothing currently loaded";
    el.nowPlayingMeta.textContent = error?.message || "Playback unavailable";

    if (el.nowPlayingArt) {
      el.nowPlayingArt.src = "";
      el.nowPlayingArt.style.visibility = "hidden";
    }

    renderSpotifyQueue(null);
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

async function addSelectedApprovedToQueue() {
  const queue = getApprovedQueue();
  if (!queue.length) {
    throw new Error("No approved songs available.");
  }

  const pointer = clampQueuePointer();
  const item = queue[pointer];

  if (!item?.spotify?.uri) {
    throw new Error("Selected approved song is missing Spotify data.");
  }

  await addTrackToSpotifyQueue(item.spotify.uri);
  await refreshPlayback();
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

  el.btnStartDefaultPlaylist?.addEventListener("click", async () => {
    try {
      await startDefaultPlaylist();
      setStatus("Default playlist started.");
      await refreshPlayback();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not start default playlist.");
    }
  });

  el.btnAddApprovedToQueue?.addEventListener("click", async () => {
    try {
      const queue = getApprovedQueue();
      const item = queue[clampQueuePointer()];
      await addSelectedApprovedToQueue();
      setStatus(
        `Added to queue: ${item?.spotify?.artist || "Unknown Artist"} — ${item?.spotify?.name || "Unknown Song"}`
      );
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not add approved song to queue.");
    }
  });

  el.btnPrevQueue?.addEventListener("click", () => {
    moveQueuePointer(-1);
  });

  el.btnNextQueue?.addEventListener("click", () => {
    moveQueuePointer(1);
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
    const queueItem = event.target.closest(".queue-item[data-queue-index]");

    if (removeButton) {
      removeApproved(removeButton.dataset.requestId);
      return;
    }

    if (queueItem) {
      const index = Number(queueItem.dataset.queueIndex);
      if (Number.isFinite(index)) {
        setQueuePointer(index);
        renderApprovedQueue();
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
