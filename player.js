const CONFIG = {
  clientId: "cbfd828db1414a2183039d01ceeaf181",
  redirectUri: "https://coltonsharp-dev.github.io/American-Leadership-Academy-Music-Queue/player.html",
  scopes: [
    "user-read-private",
    "user-read-email",
    "user-read-playback-state",
    "user-modify-playback-state",
    "streaming"
  ],
  playbackPollMs: 10000
};

const LS = {
  pkceVerifier: "ala_player_pkce_verifier",
  accessToken: "ala_player_access_token",
  refreshToken: "ala_player_refresh_token",
  expiresAt: "ala_player_expires_at"
};

const el = {
  btnLogin: document.getElementById("btnLogin"),
  btnLogout: document.getElementById("btnLogout"),
  btnActivatePlayer: document.getElementById("btnActivatePlayer"),
  btnRefreshPlayback: document.getElementById("btnRefreshPlayback"),
  btnPrevious: document.getElementById("btnPrevious"),
  btnPause: document.getElementById("btnPause"),
  btnResume: document.getElementById("btnResume"),
  btnNext: document.getElementById("btnNext"),
  btnAddManualQueue: document.getElementById("btnAddManualQueue"),

  status: document.getElementById("status"),
  nowPlaying: document.getElementById("nowPlaying"),
  nowPlayingMeta: document.getElementById("nowPlayingMeta"),
  nowPlayingArt: document.getElementById("nowPlayingArt"),
  queueTrackUri: document.getElementById("queueTrackUri")
};

let webPlayer = null;
let webPlayerDeviceId = null;
let playbackTimer = null;

function setStatus(message) {
  if (el.status) el.status.textContent = message;
  console.log(message);
}

function msToMinSec(ms) {
  const totalSeconds = Math.floor(Number(ms || 0) / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}:${String(sec).padStart(2, "0")}`;
}

function extractSpotifyTrackUri(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  if (raw.startsWith("spotify:track:")) return raw;

  const match = raw.match(/spotify\.com\/track\/([A-Za-z0-9]+)/i);
  if (match) return `spotify:track:${match[1]}`;

  return null;
}

function randomString(length = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
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
  return crypto.subtle.digest("SHA-256", encoder.encode(plain));
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createCodeChallenge(verifier) {
  return base64UrlEncode(await sha256(verifier));
}

async function loginToSpotify() {
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
    setStatus("Missing PKCE verifier.");
    return;
  }

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: CONFIG.redirectUri,
    code_verifier: verifier
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
  localStorage.setItem(LS.expiresAt, String(Date.now() + json.expires_in * 1000 - 30000));

  url.searchParams.delete("code");
  window.history.replaceState({}, document.title, url.toString());

  setStatus("Spotify login successful.");
}

async function getAccessToken() {
  const accessToken = localStorage.getItem(LS.accessToken);
  const expiresAt = Number(localStorage.getItem(LS.expiresAt) || "0");

  if (accessToken && Date.now() < expiresAt) return accessToken;

  const refreshToken = localStorage.getItem(LS.refreshToken);
  if (!refreshToken) return null;

  const body = new URLSearchParams({
    client_id: CONFIG.clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Refresh failed: ${response.status} ${text}`);
  }

  const json = await response.json();
  localStorage.setItem(LS.accessToken, json.access_token);
  localStorage.setItem(LS.expiresAt, String(Date.now() + json.expires_in * 1000 - 30000));
  return json.access_token;
}

function logoutSpotify() {
  localStorage.removeItem(LS.accessToken);
  localStorage.removeItem(LS.refreshToken);
  localStorage.removeItem(LS.expiresAt);
  localStorage.removeItem(LS.pkceVerifier);
  setStatus("Logged out of Spotify.");
}

async function spotifyFetch(path, options = {}) {
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

  if (response.status === 204) return null;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }

  return response.json();
}

async function getCurrentlyPlaying() {
  try {
    return await spotifyFetch("/me/player/currently-playing");
  } catch {
    return null;
  }
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

async function addTrackToQueue(trackUri) {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  if (!webPlayerDeviceId) {
    throw new Error("Browser player is not ready yet.");
  }

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

async function resumePlayback() {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player/play", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
}

async function pausePlayback() {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player/pause", {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok && response.status !== 204) {
    const text = await response.text();
    throw new Error(`${response.status} ${text}`);
  }
}

async function nextTrack() {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player/next", {
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

async function previousTrack() {
  const token = await getAccessToken();
  if (!token) throw new Error("Spotify login required.");

  const response = await fetch("https://api.spotify.com/v1/me/player/previous", {
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

async function refreshPlayback() {
  try {
    const data = await getCurrentlyPlaying();

    if (!data || !data.item) {
      el.nowPlaying.textContent = "Nothing currently loaded";
      el.nowPlayingMeta.textContent = "Waiting for playback data...";
      el.nowPlayingArt.src = "";
      el.nowPlayingArt.style.visibility = "hidden";
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
    el.nowPlayingMeta.textContent = `${item.album?.name || "Unknown Album"} | ${msToMinSec(item.duration_ms)}`;

    el.nowPlayingArt.src = image;
    el.nowPlayingArt.alt = `${item.name} cover art`;
    el.nowPlayingArt.style.visibility = image ? "visible" : "hidden";
  } catch (error) {
    setStatus(error?.message || "Playback refresh failed.");
  }
}

function startPlaybackPolling() {
  stopPlaybackPolling();
  playbackTimer = window.setInterval(async () => {
    try {
      await refreshPlayback();
    } catch {}
  }, CONFIG.playbackPollMs);
}

function stopPlaybackPolling() {
  if (playbackTimer) {
    window.clearInterval(playbackTimer);
    playbackTimer = null;
  }
}

window.onSpotifyWebPlaybackSDKReady = () => {
  webPlayer = new Spotify.Player({
    name: "ALA Music Queue Web Player",
    getOAuthToken: async (cb) => {
      const token = await getAccessToken();
      cb(token);
    },
    volume: 0.8
  });

  webPlayer.addListener("ready", ({ device_id }) => {
    webPlayerDeviceId = device_id;
    setStatus(`Browser player ready. Device ID: ${device_id}`);
  });

  webPlayer.addListener("not_ready", ({ device_id }) => {
    setStatus(`Player went offline: ${device_id}`);
  });

  webPlayer.addListener("initialization_error", ({ message }) => {
    setStatus(`Player init error: ${message}`);
  });

  webPlayer.addListener("authentication_error", ({ message }) => {
    setStatus(`Player auth error: ${message}`);
  });

  webPlayer.addListener("account_error", ({ message }) => {
    setStatus(`Player account error: ${message}`);
  });

  webPlayer.connect();
};

function wireEvents() {
  el.btnLogin?.addEventListener("click", async () => {
    try {
      await loginToSpotify();
    } catch (error) {
      setStatus(error?.message || "Login failed.");
    }
  });

  el.btnLogout?.addEventListener("click", () => {
    logoutSpotify();
  });

  el.btnActivatePlayer?.addEventListener("click", async () => {
    try {
      if (!webPlayerDeviceId) {
        setStatus("Player not ready yet.");
        return;
      }

      await transferPlaybackToDevice(webPlayerDeviceId, false);
      setStatus("Playback transferred to browser player.");
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Could not activate browser player.");
    }
  });

  el.btnRefreshPlayback?.addEventListener("click", async () => {
    try {
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Refresh failed.");
    }
  });

  el.btnPause?.addEventListener("click", async () => {
    try {
      await pausePlayback();
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Pause failed.");
    }
  });

  el.btnResume?.addEventListener("click", async () => {
    try {
      await resumePlayback();
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Resume failed.");
    }
  });

  el.btnNext?.addEventListener("click", async () => {
    try {
      await nextTrack();
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Next failed.");
    }
  });

  el.btnPrevious?.addEventListener("click", async () => {
    try {
      await previousTrack();
      await refreshPlayback();
    } catch (error) {
      setStatus(error?.message || "Previous failed.");
    }
  });

  el.btnAddManualQueue?.addEventListener("click", async () => {
    try {
      const trackUri = extractSpotifyTrackUri(el.queueTrackUri?.value || "");
      if (!trackUri) {
        setStatus("Enter a valid Spotify track URL or URI.");
        return;
      }

      await addTrackToQueue(trackUri);
      setStatus(`Added to queue: ${trackUri}`);
      el.queueTrackUri.value = "";
    } catch (error) {
      setStatus(error?.message || "Could not add track to queue.");
    }
  });
}

async function init() {
  wireEvents();
  await handleSpotifyCallback();
  await refreshPlayback();
  startPlaybackPolling();
  setStatus("Ready.");
}

window.addEventListener("DOMContentLoaded", () => {
  init().catch((error) => {
    console.error(error);
    setStatus(error?.message || "Player failed to initialize.");
  });
});
