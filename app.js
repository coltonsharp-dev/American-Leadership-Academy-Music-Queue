// ======================================================
// ALA Music Queue Dashboard
// Polished single-file app.js
// - Spotify PKCE login
// - Live playback preview
// - Previous / Play-Pause / Next transport
// - Time progress + remaining
// - Google Sheet request moderation
// - Approved queue flow
// - Genius lyrics popup with official embed support
// ======================================================

// --------------------
// CONFIG
// --------------------
const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUriFallback: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/",
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
  playbackPollMs: 15000,
  localProgressTickMs: 1000,
  trackLookupConcurrency: 5,
  trackLookupRetryCount: 2,
  trackLookupRetryDelayMs: 500,
  manualSearchLimit: 8
};

// --------------------
// LOCAL STORAGE KEYS
// --------------------
const LS = {
  pkceVerifier: "ala_dash_pkce_verifier",
  oauthState: "ala_dash_oauth_state",
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
  btnApproveAllCleanVisible: document.getElementById("btnApproveAllCleanVisible"),
  btnRemoveAllApproved: document.getElementById("btnRemoveAllApproved"),
  btnUndoModerationAction: document.getElementById("btnUndoModerationAction"),
  btnOpenModeration: document.getElementById("btnOpenModeration"),
  btnSearchSongs: document.getElementById("btnSearchSongs"),
  btnNowPlayingLyrics: document.getElementById("btnNowPlayingLyrics"),
  btnCloseLyrics: document.getElementById("btnCloseLyrics"),
  btnPrevTrack: document.getElementById("btnPrevTrack"),
  btnPlayPause: document.getElementById("btnPlayPause"),
  btnNextTrack: document.getElementById("btnNextTrack"),

  status: document.getElementById("status"),
  nowPlaying: document.getElementById("nowPlaying"),
  nowPlayingMeta: document.getElementById("nowPlayingMeta"),
  nowPlayingArt: document.getElementById("nowPlayingArt"),
  nowPlayingProgressText: document.getElementById("nowPlayingProgressText"),
  nowPlayingRemaining: document.getElementById("nowPlayingRemaining"),
  nowPlayingProgressBar: document.getElementById("nowPlayingProgressBar"),
  playbackStateLabel: document.getElementById("playbackStateLabel"),

  hideExplicitOnly: document.getElementById("hideExplicitOnly"),
  requestSummary: document.getElementById("requestSummary"),
  requestTableBody: document.getElementById("requestTableBody"),
  approvedQueueList: document.getElementById("approvedQueueList"),
  approvedPreviewTable: document.getElementById("approvedPreviewTable"),
  spotifyQueueList: document.getElementById("spotifyQueueList"),
  manualSearchInput: document.getElementById("manualSearchInput"),
  manualSearchResults: document.getElementById("manualSearchResults"),

  lyricsBackdrop: document.getElementById("lyricsBackdrop"),
  lyricsModal: document.getElementById("lyricsModal"),
  lyricsModalTitle: document.getElementById("lyricsModalTitle"),
  lyricsModalMeta: document.getElementById("lyricsModalMeta"),
  lyricsModalOpenLink: document.getElementById("lyricsModalOpenLink"),
  lyricsEmbedMount: document.getElementById("lyricsEmbedMount")
};

// --------------------
// STATE
// --------------------
let currentRequests = [];
let playbackTimer = null;
let localProgressTimer = null;
const moderationHistory = [];
let isUndoingModeration = false;
let manualSearchResults = [];

let currentNowPlayingTrack = null;
let currentSpotifyQueueTracks = [];
let currentPlaybackProgressMs = 0;
let currentPlaybackDurationMs = 0;
let isPlaybackActive = false;
let activeLyricsScript = null;

// --------------------
// GENIUS OVERRIDES
// --------------------
const GENIUS_ID_OVERRIDES = {
  "https://genius.com/corinne-bailey-rae-put-your-records-on-lyrics": "181231"
};

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
  const totalSeconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
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

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getErrorStatusCode(error) {
  const message = String(error?.message || "");
  const match = message.match(/^(\d{3})\b/);
  if (!match) return null;
  return Number(match[1]);
}

function pushModerationHistory(action) {
  if (isUndoingModeration) return;
  moderationHistory.push(action);
  if (moderationHistory.length > 100) {
    moderationHistory.shift();
  }
}

function getVisibleUnapprovedRequests(requests) {
  const hideExplicit = !!el.hideExplicitOnly?.checked;
  const rejected = getRejectedIds();

  return requests.filter((request) => {
    if (rejected.has(request.requestId)) return false;
    if (isApproved(request.requestId)) return false;
    if (hideExplicit && request.spotify && request.spotify.explicit === true) return false;
    return true;
  });
}

function updatePlaybackProgressUI(progressMs, durationMs) {
  if (el.nowPlayingProgressText) {
    el.nowPlayingProgressText.textContent = msToMinSec(progressMs);
  }

  if (el.nowPlayingRemaining) {
    const remaining = Math.max(0, durationMs - progressMs);
    el.nowPlayingRemaining.textContent = `-${msToMinSec(remaining)}`;
  }

  if (el.nowPlayingProgressBar) {
    const pct = durationMs > 0 ? Math.min(100, Math.max(0, (progressMs / durationMs) * 100)) : 0;
    el.nowPlayingProgressBar.style.width = `${pct}%`;
  }
}

function updatePlaybackStateLabel() {
  if (!el.playbackStateLabel) return;

  if (!currentNowPlayingTrack) {
    el.playbackStateLabel.textContent = "No Active Song";
    return;
  }

  el.playbackStateLabel.textContent = isPlaybackActive ? "Playing" : "Paused";
}

function setTransportBusy(isBusy) {
  const buttons = [el.btnPrevTrack, el.btnPlayPause, el.btnNextTrack];
  for (const button of buttons) {
    if (button) button.disabled = !!isBusy;
  }
}

function startLocalProgressTimer() {
  stopLocalProgressTimer();

  localProgressTimer = window.setInterval(() => {
    if (!currentNowPlayingTrack || !isPlaybackActive) return;

    currentPlaybackProgressMs = Math.min(
      currentPlaybackDurationMs,
      currentPlaybackProgressMs + CONFIG.localProgressTickMs
    );

    updatePlaybackProgressUI(currentPlaybackProgressMs, currentPlaybackDurationMs);
  }, CONFIG.localProgressTickMs);
}

function stopLocalProgressTimer() {
  if (localProgressTimer) {
    window.clearInterval(localProgressTimer);
    localProgressTimer = null;
  }
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

function isTrackApproved(trackId) {
  if (!trackId) return false;
  return getApprovedQueue().some((item) => item.spotify?.id === trackId);
}

function countTrackInApprovedQueue(trackId) {
  if (!trackId) return 0;
  return getApprovedQueue().filter((item) => item.spotify?.id === trackId).length;
}

function createManualApprovedRequest(track) {
  const spotify = normalizeSpotifyTrack(track);

  return {
    requestId: `manual|${spotify?.id || randomString(8)}|${Date.now()}|${randomString(6)}`,
    timestamp: "Added manually",
    email: "",
    spotifyLink: spotify?.externalUrl || "",
    source: "moderator",
    spotify
  };
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
      i += 1;
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
      if (ch === "\r" && next === "\n") i += 1;
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
// GENIUS HELPERS
// ======================================================
function normalizeGeniusUrl(url) {
  return String(url || "")
    .trim()
    .replace(/^http:/i, "https:")
    .replace(/\/+$/, "")
    .toLowerCase();
}

function getGeniusSongIdFromUrl(url) {
  const normalized = normalizeGeniusUrl(url);
  return GENIUS_ID_OVERRIDES[normalized] || "";
}

function buildGeniusUrl(artist, song) {
  const slugify = (str) =>
    String(str || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .replace(/\s+/g, "-");

  const primaryArtist = String(artist || "").split(/,|&/)[0].trim();
  return `https://genius.com/${slugify(primaryArtist)}-${slugify(song)}-lyrics`;
}

function clearLyricsEmbed() {
  if (activeLyricsScript && activeLyricsScript.parentNode) {
    activeLyricsScript.parentNode.removeChild(activeLyricsScript);
  }
  activeLyricsScript = null;

  if (el.lyricsEmbedMount) {
    el.lyricsEmbedMount.innerHTML = `
      <div class="lyrics-loading">Preparing lyrics preview...</div>
    `;
  }
}

function openLyricsModalShell(title, meta, url) {
  if (el.lyricsModalTitle) el.lyricsModalTitle.textContent = title || "Lyrics Preview";
  if (el.lyricsModalMeta) el.lyricsModalMeta.textContent = meta || "Lyrics preview";

  if (el.lyricsModalOpenLink) {
    el.lyricsModalOpenLink.href = url || "#";
    el.lyricsModalOpenLink.style.pointerEvents = url ? "auto" : "none";
    el.lyricsModalOpenLink.style.opacity = url ? "1" : "0.45";
  }

  el.lyricsBackdrop?.classList.add("lyrics-is-open");
  el.lyricsModal?.classList.add("lyrics-is-open");
  document.body.classList.add("mod-panel-open");
}

function closeLyricsModal() {
  el.lyricsBackdrop?.classList.remove("lyrics-is-open");
  el.lyricsModal?.classList.remove("lyrics-is-open");

  const modOpen = document.getElementById("modOverlay")?.classList.contains("mod-is-open");
  if (!modOpen) {
    document.body.classList.remove("mod-panel-open");
  }
}

function renderLyricsFallback(url, title, artist) {
  if (!el.lyricsEmbedMount) return;

  el.lyricsEmbedMount.innerHTML = `
    <div class="lyrics-fallback">
      <div class="lyrics-fallback-title">${escapeHtml(title || "Lyrics unavailable")}</div>
      <div class="lyrics-fallback-copy">
        The Genius popup is open, but this track does not yet have a mapped Genius song ID inside the dashboard.
        Add the song URL and Genius ID to the local override map to render the official embed here.
      </div>
      <div class="request-meta">${escapeHtml(artist || "Unknown artist")}</div>
      ${
        url
          ? `<a class="btn btn-small btn-lyrics-action" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open Full Lyrics</a>`
          : ""
      }
    </div>
  `;
}

function renderGeniusEmbed(songId, url, title, artist) {
  clearLyricsEmbed();

  if (!songId) {
    renderLyricsFallback(url, title, artist);
    return;
  }

  const embedId = `rg_embed_link_${songId}_${Date.now()}`;

  if (el.lyricsEmbedMount) {
    el.lyricsEmbedMount.innerHTML = `
      <div
        id="${embedId}"
        class="rg_embed_link"
        data-song-id="${escapeHtml(songId)}"
        style="color:#f4f7fb;"
      >
        Read <a href="${escapeHtml(url || "#")}" target="_blank" rel="noopener noreferrer">${escapeHtml(title || "this song")}</a> on Genius
      </div>
    `;
  }

  const script = document.createElement("script");
  script.src = `https://genius.com/songs/${encodeURIComponent(songId)}/embed.js`;
  script.crossOrigin = "anonymous";
  script.async = true;
  activeLyricsScript = script;
  document.body.appendChild(script);
}

function openLyricsModal(payload = {}) {
  const url = payload.url || "";
  const title = payload.title || "Lyrics Preview";
  const artist = payload.artist || "Unknown Artist";
  const songId = payload.songId || getGeniusSongIdFromUrl(url);
  const meta = artist ? artist : "Lyrics preview";

  openLyricsModalShell(title, meta, url);
  renderGeniusEmbed(songId, url, title, artist);
}

function createLyricsButtonHtml({ url = "", songId = "", title = "", artist = "" } = {}) {
  return `
    <button
      class="ghost-btn btn-lyrics lyrics-popup-btn"
      type="button"
      data-genius-url="${escapeHtml(url)}"
      data-genius-song-id="${escapeHtml(songId)}"
      data-title="${escapeHtml(title)}"
      data-artist="${escapeHtml(artist)}"
    >
      Lyrics
    </button>
  `;
}

// ======================================================
// NORMALIZE SPOTIFY TRACK
// ======================================================
function normalizeSpotifyTrack(track) {
  if (!track) return null;

  const artistNames = Array.isArray(track.artists)
    ? track.artists.map((artist) => artist?.name).filter(Boolean).join(", ")
    : String(track.artist || "").trim();

  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artist: artistNames || "Unknown Artist",
    explicit: !!track.explicit,
    durationMs: track.duration_ms ?? track.durationMs ?? 0,
    externalUrl:
      track.external_urls?.spotify ||
      track.externalUrl ||
      (track.id ? spotifyTrackUrl(track.id) : ""),
    album: track.album?.name || track.album || "",
    image:
      track.album?.images?.[0]?.url ||
      track.album?.images?.[1]?.url ||
      track.album?.images?.[2]?.url ||
      track.image || ""
  };
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

function getRedirectUri() {
  if (!window?.location?.origin || !window?.location?.pathname) {
    return CONFIG.redirectUriFallback;
  }

  const path = window.location.pathname.endsWith(".html")
    ? window.location.pathname.replace(/[^/]+$/, "")
    : window.location.pathname;

  return `${window.location.origin}${path}`;
}

// ======================================================
// SPOTIFY AUTH
// ======================================================
async function loginToSpotify() {
  setStatus("Starting Spotify login...");

  const verifier = randomString(64);
  const state = randomString(32);
  const challenge = await createCodeChallenge(verifier);

  localStorage.setItem(LS.pkceVerifier, verifier);
  localStorage.setItem(LS.oauthState, state);

  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: "code",
    redirect_uri: getRedirectUri(),
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: CONFIG.scopes.join(" "),
    state,
    show_dialog: "true"
  });

  window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleSpotifyCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const returnedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    setStatus(`Spotify login error: ${error}`);
    return;
  }

  if (!code) return;

  const expectedState = localStorage.getItem(LS.oauthState);
  if (!expectedState || !returnedState || expectedState !== returnedState) {
    throw new Error("Spotify login state mismatch. Please try logging in again.");
  }

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
    redirect_uri: getRedirectUri(),
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
  url.searchParams.delete("error");
  window.history.replaceState({}, document.title, url.toString());
  localStorage.removeItem(LS.oauthState);

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
  localStorage.removeItem(LS.oauthState);

  stopPlaybackPolling();
  stopLocalProgressTimer();

  currentNowPlayingTrack = null;
  currentSpotifyQueueTracks = [];
  currentPlaybackProgressMs = 0;
  currentPlaybackDurationMs = 0;
  isPlaybackActive = false;

  resetNowPlayingUI();
  renderSpotifyQueue(null);
  setStatus("Logged out of Spotify.");
}

async function getTrackByIdWithRetry(trackId) {
  const maxAttempts = Math.max(1, CONFIG.trackLookupRetryCount + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await getTrackById(trackId);
    } catch (error) {
      const statusCode = getErrorStatusCode(error);
      const isLastAttempt = attempt === maxAttempts;

      if (statusCode === 429 && !isLastAttempt) {
        await wait(CONFIG.trackLookupRetryDelayMs * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Track lookup failed unexpectedly.");
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

async function spotifyNoContent(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  return true;
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

async function searchSpotifyTracks(query) {
  const params = new URLSearchParams({
    q: query,
    type: "track",
    limit: String(CONFIG.manualSearchLimit)
  });

  const response = await spotifyFetch(`/search?${params.toString()}`);
  return Array.isArray(response?.tracks?.items) ? response.tracks.items : [];
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

async function pausePlayback() {
  await ensureActiveDevice();
  await spotifyNoContent("/me/player/pause", { method: "PUT" });
}

async function resumePlayback() {
  await ensureActiveDevice();
  await spotifyNoContent("/me/player/play", { method: "PUT" });
}

async function skipToNextTrack() {
  await ensureActiveDevice();
  await spotifyNoContent("/me/player/next", { method: "POST" });
}

async function skipToPreviousTrack() {
  await ensureActiveDevice();
  await spotifyNoContent("/me/player/previous", { method: "POST" });
}

async function togglePlayPause() {
  if (isPlaybackActive) {
    await pausePlayback();
  } else {
    await resumePlayback();
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
  const enriched = new Array(rows.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= rows.length) return;

      const row = rows[index];
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
        enriched[index] = result;
        continue;
      }

      try {
        const track = await getTrackByIdWithRetry(trackId);
        result.spotify = normalizeSpotifyTrack(track);
      } catch (error) {
        result.error = error?.message || "Spotify lookup failed";
      }

      enriched[index] = result;
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(CONFIG.trackLookupConcurrency, rows.length || 1)) },
    () => worker()
  );

  await Promise.all(workers);
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
function approveRequest(request, options = {}) {
  const {
    silentStatus = false,
    allowExplicit = false,
    allowDuplicateTrack = false,
    selectAdded = false
  } = options;

  if (!request.spotify) {
    if (!silentStatus) setStatus("Cannot approve a request with no valid Spotify track.");
    return false;
  }

  if (request.spotify.explicit && !allowExplicit) {
    if (!silentStatus) setStatus("Cannot approve an explicit song.");
    return false;
  }

  const queue = getApprovedQueue();
  if (
    queue.some(
      (item) =>
        item.requestId === request.requestId ||
        (!allowDuplicateTrack && item.spotify?.id && item.spotify.id === request.spotify.id)
    )
  ) {
    if (!silentStatus) setStatus("Song is already approved.");
    return false;
  }

  queue.push({
    requestId: request.requestId,
    timestamp: request.timestamp,
    email: request.email,
    spotifyLink: request.spotifyLink,
    source: request.source || "request",
    spotify: request.spotify
  });

  saveApprovedQueue(queue);
  if (selectAdded) {
    setQueuePointer(queue.length - 1);
  }

  pushModerationHistory({
    type: "approve",
    requestId: request.requestId
  });

  renderApprovedQueue();
  renderRequests(currentRequests);
  renderApprovedPreview();

  if (!silentStatus) {
    setStatus(`Approved: ${request.spotify.artist} — ${request.spotify.name}`);
  }

  return true;
}

function rejectRequest(request) {
  const rejected = getRejectedIds();
  rejected.add(request.requestId);
  saveRejectedIds(rejected);

  pushModerationHistory({
    type: "reject",
    requestId: request.requestId
  });

  renderRequests(currentRequests);
  setStatus("Request removed from unapproved list.");
}

function removeApproved(requestId) {
  return removeApprovedItem(requestId);
}

function removeApprovedItem(requestId, options = {}) {
  const { silentStatus = false, skipHistory = false } = options;

  const existingQueue = getApprovedQueue();
  const removedIndex = existingQueue.findIndex((item) => item.requestId === requestId);
  const removedItem = removedIndex >= 0 ? existingQueue[removedIndex] : null;
  const queue = existingQueue.filter((item) => item.requestId !== requestId);

  if (removedItem && !skipHistory) {
    pushModerationHistory({
      type: "remove-approved",
      index: removedIndex,
      item: removedItem
    });
  }

  saveApprovedQueue(queue);
  clampQueuePointer();
  renderApprovedQueue();
  renderRequests(currentRequests);
  renderApprovedPreview();

  if (!silentStatus) {
    setStatus("Removed song from approved list.");
  }

  return removedItem;
}

function clearApprovedQueue() {
  const queue = getApprovedQueue();

  if (!queue.length) {
    setStatus("Moderator queue is already empty.");
    return;
  }

  pushModerationHistory({
    type: "clear-approved",
    queue,
    pointer: getQueuePointer()
  });

  saveApprovedQueue([]);
  setQueuePointer(0);
  renderApprovedQueue();
  renderRequests(currentRequests);
  renderApprovedPreview();
  renderManualSearchResults();
  setStatus("Removed all songs from the moderator queue.");
}

function approveAllVisibleCleanRequests() {
  const visible = getVisibleUnapprovedRequests(currentRequests);
  const cleanVisible = visible.filter((request) => request.spotify && request.spotify.explicit === false);

  if (!cleanVisible.length) {
    setStatus("No visible clean requests to approve.");
    return;
  }

  let approvedCount = 0;
  for (const request of cleanVisible) {
    if (approveRequest(request, { silentStatus: true })) {
      approvedCount += 1;
    }
  }

  setStatus(`Approved ${approvedCount} clean visible request(s).`);
}

function undoLastModerationAction() {
  const action = moderationHistory.pop();
  if (!action) {
    setStatus("No moderation actions to undo.");
    return;
  }

  isUndoingModeration = true;

  try {
    if (action.type === "approve") {
      const queue = getApprovedQueue().filter((item) => item.requestId !== action.requestId);
      saveApprovedQueue(queue);
      clampQueuePointer();
      renderApprovedQueue();
      renderRequests(currentRequests);
      renderApprovedPreview();
      setStatus("Undid last approve action.");
      return;
    }

    if (action.type === "reject") {
      const rejected = getRejectedIds();
      rejected.delete(action.requestId);
      saveRejectedIds(rejected);
      renderRequests(currentRequests);
      setStatus("Undid last reject action.");
      return;
    }

    if (action.type === "remove-approved") {
      const queue = getApprovedQueue();
      if (!queue.some((item) => item.requestId === action.item?.requestId)) {
        const insertIndex = Math.max(0, Math.min(action.index, queue.length));
        queue.splice(insertIndex, 0, action.item);
        saveApprovedQueue(queue);
        setQueuePointer(insertIndex);
      }
      renderApprovedQueue();
      renderRequests(currentRequests);
      renderApprovedPreview();
      setStatus("Undid last remove action.");
      return;
    }

    if (action.type === "clear-approved") {
      saveApprovedQueue(Array.isArray(action.queue) ? action.queue : []);
      setQueuePointer(action.pointer || 0);
      renderApprovedQueue();
      renderRequests(currentRequests);
      renderApprovedPreview();
      renderManualSearchResults();
      setStatus("Undid remove all action.");
      return;
    }

    setStatus("No undo handler for the last action.");
  } finally {
    isUndoingModeration = false;
  }
}

// ======================================================
// RENDER HELPERS
// ======================================================
function renderManualSearchResults() {
  if (!el.manualSearchResults) return;

  if (!manualSearchResults.length) {
    el.manualSearchResults.innerHTML = `
      <div class="empty-state">
        Search Spotify to verify and add the exact track you want.
      </div>
    `;
    return;
  }

  el.manualSearchResults.innerHTML = manualSearchResults
    .map((track) => {
      const spotify = normalizeSpotifyTrack(track);
      const isExplicit = spotify?.explicit === true;
      const existingCount = countTrackInApprovedQueue(spotify?.id);
      const buttonLabel = existingCount ? `Add Again (${existingCount} queued)` : "Add to Mod Queue";

      return `
        <div class="request-item">
          <div class="request-art-wrap">
            ${
              spotify?.image
                ? `<img class="request-art" src="${escapeHtml(spotify.image)}" alt="${escapeHtml(spotify.name)} cover art">`
                : `<div class="request-art request-art-placeholder">No Art</div>`
            }
          </div>

          <div class="request-main">
            <div class="request-title-row">
              <div class="request-song">${escapeHtml(spotify?.name || "Unknown track")}</div>
              <span class="badge ${isExplicit ? "badge-explicit" : "badge-clean"}">
                ${isExplicit ? "Explicit" : "Clean"}
              </span>
            </div>

            <div class="request-artist">${escapeHtml(spotify?.artist || "Unknown artist")}</div>
            <div class="request-meta">
              ${escapeHtml(spotify?.album || "Unknown Album")} • ${escapeHtml(msToMinSec(spotify?.durationMs || 0))}
            </div>
            <div class="request-submitted">Spotify track ID: ${escapeHtml(spotify?.id || "Unavailable")}</div>
          </div>

          <div class="request-actions">
            <a class="ghost-btn" href="${escapeHtml(spotify?.externalUrl || "#")}" target="_blank" rel="noopener noreferrer">
              Open in Spotify
            </a>
            <button class="add-search-result-btn" data-track-id="${escapeHtml(spotify?.id || "")}">
              ${buttonLabel}
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderRequests(requests) {
  if (!el.requestTableBody) return;

  const visibleRequests = getVisibleUnapprovedRequests(requests);

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
      const geniusUrl = request.spotify ? buildGeniusUrl(request.spotify.artist, request.spotify.name) : "";

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
            <div class="request-submitted">${escapeHtml(request.timestamp || "—")}</div>
          </div>

          <div class="request-actions">
            ${
              request.spotify
                ? `
                  <a class="ghost-btn" href="${escapeHtml(request.spotify.externalUrl)}" target="_blank" rel="noopener noreferrer">Open in Spotify</a>
                  ${createLyricsButtonHtml({
                    url: geniusUrl,
                    songId: getGeniusSongIdFromUrl(geniusUrl),
                    title: request.spotify.name,
                    artist: request.spotify.artist
                  })}
                `
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
      const sourceBadge = item.source === "moderator"
        ? '<span class="badge badge-override">Moderator</span>'
        : "";

      const geniusUrl = buildGeniusUrl(artist, name);

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
            <div class="request-title-row">
              <div class="queue-item-title">${escapeHtml(name)}</div>
              ${sourceBadge}
            </div>
            <div class="queue-item-artist">${escapeHtml(artist)}</div>
          </div>

          <div class="queue-item-actions">
            ${createLyricsButtonHtml({
              url: geniusUrl,
              songId: getGeniusSongIdFromUrl(geniusUrl),
              title: name,
              artist
            })}
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
  const statusBadge = current.source === "moderator" ? "Moderator Override" : "Approved";
  const statusClass = current.source === "moderator" ? "badge-override" : "badge-clean";
  const geniusUrl = buildGeniusUrl(item.artist, item.name);

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
          <span class="badge ${statusClass}">${statusBadge}</span>
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
        ${createLyricsButtonHtml({
          url: geniusUrl,
          songId: getGeniusSongIdFromUrl(geniusUrl),
          title: item.name,
          artist: item.artist
        })}
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
    const currentArtist = (currentlyPlaying.artists || []).map((a) => a.name).join(", ");
    const currentGeniusUrl = buildGeniusUrl(currentArtist, currentlyPlaying.name);

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

          <div class="request-artist">${escapeHtml(currentArtist || "Unknown artist")}</div>
          <div class="request-meta">
            ${escapeHtml(currentlyPlaying.album?.name || "Unknown Album")} • ${escapeHtml(msToMinSec(currentlyPlaying.duration_ms))}
          </div>
        </div>

        <div class="request-actions">
          <a class="ghost-btn" href="${escapeHtml(currentlyPlaying.external_urls?.spotify || "#")}" target="_blank" rel="noopener noreferrer">
            Open in Spotify
          </a>
          ${createLyricsButtonHtml({
            url: currentGeniusUrl,
            songId: getGeniusSongIdFromUrl(currentGeniusUrl),
            title: currentlyPlaying.name,
            artist: currentArtist
          })}
        </div>
      </div>
    `);
  }

  queue.forEach((item, index) => {
    if (!isTrackObject(item)) return;

    const artist = (item.artists || []).map((a) => a.name).join(", ");
    const geniusUrl = buildGeniusUrl(artist, item.name);

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

          <div class="request-artist">${escapeHtml(artist || "Unknown artist")}</div>
          <div class="request-meta">
            ${escapeHtml(item.album?.name || "Unknown Album")} • ${escapeHtml(msToMinSec(item.duration_ms))}
          </div>
        </div>

        <div class="request-actions">
          <a class="ghost-btn" href="${escapeHtml(item.external_urls?.spotify || "#")}" target="_blank" rel="noopener noreferrer">
            Open in Spotify
          </a>
          ${createLyricsButtonHtml({
            url: geniusUrl,
            songId: getGeniusSongIdFromUrl(geniusUrl),
            title: item.name,
            artist
          })}
        </div>
      </div>
    `);
  });

  el.spotifyQueueList.innerHTML = blocks.join("");
}

// ======================================================
// PLAYBACK PREVIEW
// ======================================================
function resetNowPlayingUI() {
  if (el.nowPlaying) el.nowPlaying.textContent = "Nothing currently loaded";
  if (el.nowPlayingMeta) el.nowPlayingMeta.textContent = "Waiting for playback data...";
  if (el.nowPlayingArt) {
    el.nowPlayingArt.src = "";
    el.nowPlayingArt.style.visibility = "hidden";
  }

  currentPlaybackProgressMs = 0;
  currentPlaybackDurationMs = 0;
  updatePlaybackProgressUI(0, 0);
  updatePlaybackStateLabel();
}

async function refreshPlayback() {
  if (!el.nowPlaying || !el.nowPlayingMeta) return;

  try {
    const [playbackData, queueData] = await Promise.all([
      getCurrentlyPlaying(),
      getSpotifyQueue().catch(() => null)
    ]);

    currentNowPlayingTrack = playbackData?.item || null;
    currentSpotifyQueueTracks = Array.isArray(queueData?.queue) ? queueData.queue : [];
    isPlaybackActive = !!playbackData?.is_playing;

    if (!playbackData || !playbackData.item) {
      currentNowPlayingTrack = null;
      currentSpotifyQueueTracks = [];
      currentPlaybackProgressMs = 0;
      currentPlaybackDurationMs = 0;
      isPlaybackActive = false;

      resetNowPlayingUI();
      renderSpotifyQueue(queueData);
      stopLocalProgressTimer();
      return;
    }

    const item = playbackData.item;
    const artists = item.artists?.map((a) => a.name).join(", ") || "Unknown Artist";
    const image =
      item.album?.images?.[0]?.url ||
      item.album?.images?.[1]?.url ||
      item.album?.images?.[2]?.url ||
      "";

    currentPlaybackProgressMs = Number(playbackData.progress_ms || 0);
    currentPlaybackDurationMs = Number(item.duration_ms || 0);

    el.nowPlaying.textContent = `${artists} — ${item.name}`;
    el.nowPlayingMeta.textContent =
      `${item.album?.name || "Unknown Album"} | ${msToMinSec(item.duration_ms)}`;

    if (el.nowPlayingArt) {
      el.nowPlayingArt.src = image;
      el.nowPlayingArt.alt = `${item.name} cover art`;
      el.nowPlayingArt.style.visibility = image ? "visible" : "hidden";
    }

    updatePlaybackProgressUI(currentPlaybackProgressMs, currentPlaybackDurationMs);
    updatePlaybackStateLabel();
    renderSpotifyQueue(queueData);

    if (isPlaybackActive) {
      startLocalProgressTimer();
    } else {
      stopLocalProgressTimer();
    }
  } catch (error) {
    currentNowPlayingTrack = null;
    currentSpotifyQueueTracks = [];
    currentPlaybackProgressMs = 0;
    currentPlaybackDurationMs = 0;
    isPlaybackActive = false;

    if (el.nowPlaying) el.nowPlaying.textContent = "Nothing currently loaded";
    if (el.nowPlayingMeta) {
      el.nowPlayingMeta.textContent = error?.message || "Playback unavailable";
    }

    if (el.nowPlayingArt) {
      el.nowPlayingArt.src = "";
      el.nowPlayingArt.style.visibility = "hidden";
    }

    updatePlaybackProgressUI(0, 0);
    updatePlaybackStateLabel();
    renderSpotifyQueue(null);
    stopLocalProgressTimer();
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
  removeApprovedItem(item.requestId, { silentStatus: true });

  try {
    await refreshPlayback();
  } catch (error) {
    console.warn("Playback refresh after add-to-queue failed:", error);
  }

  return item;
}

async function runManualTrackSearch() {
  const query = String(el.manualSearchInput?.value || "").trim();

  if (!query) {
    manualSearchResults = [];
    renderManualSearchResults();
    setStatus("Enter a song or artist to search Spotify.");
    return;
  }

  setStatus(`Searching Spotify for "${query}"...`);

  const tracks = await searchSpotifyTracks(query);
  manualSearchResults = tracks;
  renderManualSearchResults();

  if (!tracks.length) {
    setStatus("No Spotify tracks matched that search.");
    return;
  }

  setStatus(`Found ${tracks.length} Spotify track(s). Review the exact result before adding.`);
}

async function addManualSearchResultToQueue(trackId) {
  const track = manualSearchResults.find((item) => item.id === trackId);

  if (!track) {
    setStatus("Selected search result is no longer available.");
    return;
  }

  setStatus("Verifying selected Spotify track before adding...");

  let verifiedTrack;
  try {
    verifiedTrack = await getTrackByIdWithRetry(trackId);
  } catch (error) {
    setStatus(error?.message || "Could not verify the selected Spotify track.");
    return;
  }

  const request = createManualApprovedRequest(verifiedTrack);
  const wasApproved = approveRequest(request, {
    silentStatus: true,
    allowExplicit: true,
    allowDuplicateTrack: true,
    selectAdded: true
  });

  if (!wasApproved) {
    setStatus("That Spotify track could not be added to the moderator queue.");
    renderManualSearchResults();
    return;
  }

  renderManualSearchResults();
  setStatus(`Moderator override added: ${request.spotify.artist} — ${request.spotify.name}`);
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
// MODERATION PANEL
// ======================================================
function openModerationPanel() {
  document.getElementById("modOverlay")?.classList.add("mod-is-open");
  document.getElementById("modBackdrop")?.classList.add("mod-is-open");
  document.body.classList.add("mod-panel-open");
}

function closeModerationPanel() {
  document.getElementById("modOverlay")?.classList.remove("mod-is-open");
  document.getElementById("modBackdrop")?.classList.remove("mod-is-open");

  const lyricsOpen = el.lyricsModal?.classList.contains("lyrics-is-open");
  if (!lyricsOpen) {
    document.body.classList.remove("mod-panel-open");
  }
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
      const item = await addSelectedApprovedToQueue();
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

  el.btnApproveAllCleanVisible?.addEventListener("click", () => {
    approveAllVisibleCleanRequests();
  });

  el.btnRemoveAllApproved?.addEventListener("click", () => {
    clearApprovedQueue();
  });

  el.btnUndoModerationAction?.addEventListener("click", () => {
    undoLastModerationAction();
  });

  el.btnSearchSongs?.addEventListener("click", async () => {
    try {
      await runManualTrackSearch();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Spotify search failed.");
    }
  });

  el.manualSearchInput?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();

    try {
      await runManualTrackSearch();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Spotify search failed.");
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

  el.manualSearchResults?.addEventListener("click", async (event) => {
    const addButton = event.target.closest(".add-search-result-btn");
    if (!addButton) return;

    try {
      await addManualSearchResultToQueue(addButton.dataset.trackId || "");
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Moderator add failed.");
    }
  });

  el.btnOpenModeration?.addEventListener("click", () => openModerationPanel());
  document.getElementById("btnCloseModeration")?.addEventListener("click", () => closeModerationPanel());
  document.getElementById("modBackdrop")?.addEventListener("click", () => closeModerationPanel());

  el.btnNowPlayingLyrics?.addEventListener("click", () => {
    if (!currentNowPlayingTrack) {
      setStatus("No active track is currently playing.");
      return;
    }

    const artist = (currentNowPlayingTrack.artists || []).map((a) => a.name).join(", ");
    const title = currentNowPlayingTrack.name || "Unknown Song";
    const url = buildGeniusUrl(artist, title);

    openLyricsModal({
      url,
      songId: getGeniusSongIdFromUrl(url),
      title,
      artist
    });
  });

  el.btnCloseLyrics?.addEventListener("click", () => {
    closeLyricsModal();
  });

  el.lyricsBackdrop?.addEventListener("click", () => {
    closeLyricsModal();
  });

  document.addEventListener("click", (event) => {
    const lyricsButton = event.target.closest(".lyrics-popup-btn");
    if (!lyricsButton) return;

    openLyricsModal({
      url: lyricsButton.dataset.geniusUrl || "",
      songId: lyricsButton.dataset.geniusSongId || "",
      title: lyricsButton.dataset.title || "Lyrics Preview",
      artist: lyricsButton.dataset.artist || "Unknown Artist"
    });
  });

  el.btnPrevTrack?.addEventListener("click", async () => {
    try {
      setTransportBusy(true);
      await skipToPreviousTrack();
      setStatus("Skipped to previous track.");
      await wait(500);
      await refreshPlayback();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not go to previous track.");
    } finally {
      setTransportBusy(false);
    }
  });

  el.btnPlayPause?.addEventListener("click", async () => {
    try {
      setTransportBusy(true);
      await togglePlayPause();
      await wait(350);
      await refreshPlayback();
      setStatus(isPlaybackActive ? "Playback resumed." : "Playback paused.");
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not toggle playback.");
    } finally {
      setTransportBusy(false);
    }
  });

  el.btnNextTrack?.addEventListener("click", async () => {
    try {
      setTransportBusy(true);
      await skipToNextTrack();
      setStatus("Skipped to next track.");
      await wait(500);
      await refreshPlayback();
    } catch (error) {
      console.error(error);
      setStatus(error?.message || "Could not go to next track.");
    } finally {
      setTransportBusy(false);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModerationPanel();
      closeLyricsModal();
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
  renderApprovedPreview();
  renderManualSearchResults();
  buildRequestSummary([]);
  resetNowPlayingUI();

  await handleSpotifyCallback();

  let hasActiveSpotifyLogin = false;

  try {
    const me = await getCurrentUserProfile();
    hasActiveSpotifyLogin = true;

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

  if (hasActiveSpotifyLogin || !!localStorage.getItem(LS.accessToken)) {
    startPlaybackPolling();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error(error);
    setStatus(error?.message || "App failed to initialize.");
  });
});
