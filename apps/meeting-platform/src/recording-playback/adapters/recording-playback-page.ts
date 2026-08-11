import { createHash } from "node:crypto";

export const recordingPlaybackStyle = `
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; color: #f7f7f8; background: radial-gradient(circle at 20% 0%, #2a2145 0, transparent 36rem), #0b0b0f; }
.shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.card { width: min(720px, 100%); padding: clamp(26px, 5vw, 52px); border: 1px solid #ffffff1c; border-radius: 28px; background: #15151bdb; box-shadow: 0 30px 80px #0008; backdrop-filter: blur(18px); }
.eyebrow { color: #a78bfa; font-size: 12px; font-weight: 800; letter-spacing: .16em; }
h1 { margin: 10px 0 8px; font-size: clamp(32px, 7vw, 56px); line-height: 1; letter-spacing: -.045em; }
.status, .notice { color: #aaaab6; line-height: 1.55; }
.player { display: flex; align-items: center; gap: 20px; margin-top: 34px; padding: 18px; border: 1px solid #ffffff14; border-radius: 20px; background: #0d0d12; }
.player[hidden] { display: none; }
.toggle { width: 58px; height: 58px; flex: 0 0 auto; border: 0; border-radius: 50%; color: #121016; background: #c4b5fd; font-size: 22px; cursor: pointer; transition: transform .15s ease, background .15s ease; }
.toggle:hover { transform: scale(1.04); background: #ddd6fe; }
.toggle:focus-visible, input:focus-visible { outline: 3px solid #a78bfa; outline-offset: 3px; }
.timeline { width: 100%; min-width: 0; display: grid; gap: 2px; }
input[type="range"] {
  --seek-progress: 0%;
  width: 100%; height: 48px; margin: 0;
  appearance: none;
  -webkit-appearance: none;
  background: transparent; cursor: pointer;
  touch-action: none;
}
input[type="range"]::-webkit-slider-runnable-track {
  height: 12px;
  border: 1px solid #ffffff24;
  border-radius: 999px;
  background: linear-gradient(90deg, #8b5cf6 0, #c4b5fd var(--seek-progress), #302d39 var(--seek-progress), #302d39 100%);
  box-shadow: inset 0 1px 2px #0009, 0 0 24px #8b5cf638;
}
input[type="range"]::-webkit-slider-thumb {
  width: 30px;
  height: 30px;
  margin-top: -10px;
  border: 4px solid #17131f;
  border-radius: 50%;
  appearance: none;
  -webkit-appearance: none;
  background: linear-gradient(135deg, #ffffff, #a78bfa 72%);
  box-shadow: 0 0 0 2px #c4b5fd, 0 8px 24px #8b5cf680;
  transition: transform .15s ease, box-shadow .15s ease;
}
input[type="range"]::-moz-range-track {
  height: 12px;
  border: 1px solid #ffffff24;
  border-radius: 999px;
  background: #302d39;
  box-shadow: inset 0 1px 2px #0009, 0 0 24px #8b5cf638;
}
input[type="range"]::-moz-range-progress {
  height: 12px;
  border-radius: 999px;
  background: linear-gradient(90deg, #8b5cf6, #c4b5fd);
}
input[type="range"]::-moz-range-thumb {
  width: 22px;
  height: 22px;
  border: 4px solid #17131f;
  border-radius: 50%;
  background: linear-gradient(135deg, #ffffff, #a78bfa 72%);
  box-shadow: 0 0 0 2px #c4b5fd, 0 8px 24px #8b5cf680;
  transition: transform .15s ease, box-shadow .15s ease;
}
input[type="range"]:hover::-webkit-slider-thumb,
input[type="range"]:focus-visible::-webkit-slider-thumb { transform: scale(1.12); box-shadow: 0 0 0 4px #a78bfa40, 0 10px 30px #8b5cf6a0; }
input[type="range"]:hover::-moz-range-thumb,
input[type="range"]:focus-visible::-moz-range-thumb { transform: scale(1.12); box-shadow: 0 0 0 4px #a78bfa40, 0 10px 30px #8b5cf6a0; }
.times { display: flex; justify-content: space-between; color: #aaaab6; font-variant-numeric: tabular-nums; font-size: 13px; font-weight: 650; letter-spacing: .025em; }
.notice { margin: 18px 2px 0; color: #d8b4fe; }
@media (max-width: 520px) { .card { border-radius: 22px; } .player { gap: 14px; padding: 14px; } .toggle { width: 50px; height: 50px; } }
`;

export const recordingPlaybackClientScript = String.raw`
(() => {
  "use strict";
  const statusNode = document.querySelector("#status");
  const playerNode = document.querySelector("#player");
  const noticeNode = document.querySelector("#notice");
  const tracksNode = document.querySelector("#tracks");
  const toggleNode = document.querySelector("#toggle");
  const seekNode = document.querySelector("#seek");
  const currentNode = document.querySelector("#current");
  const durationNode = document.querySelector("#duration");
  let tracks = [];
  let duration = 0;
  let position = 0;
  let playing = false;
  let starting = false;
  let lastSyncAt = 0;
  let gapClock = null, manifestAttempts = 0, metadataRetryUsed = false;
  const metadataTimeoutMs = 15000;
  const manifestRequestTimeoutMs = 5000, manifestRetryDelayMs = 5000, maximumManifestAttempts = 24;

  const token = window.location.hash.slice(1);
  if (!/^[A-Za-z0-9._-]{40,1024}$/.test(token)) {
    showUnavailable();
    return;
  }
  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const rest = String(safe % 60).padStart(2, "0");
    return hours > 0
      ? hours + ":" + String(minutes).padStart(2, "0") + ":" + rest
      : minutes + ":" + rest;
  }

  function currentPosition() {
    if (!playing) return position;
    const active = activeTracksAt(position);
    if (active.length > 0) {
      gapClock = null;
      return Math.min(duration, Math.min(...active.map((track) =>
        track.offset + Math.max(0, Math.min(track.audio.currentTime, track.audio.duration))
      )));
    }
    if (gapClock === null) {
      gapClock = { position, startedAt: performance.now() };
    }
    return Math.min(duration, gapClock.position + (performance.now() - gapClock.startedAt) / 1000);
  }

  function activeTracksAt(master) {
    return tracks.filter((track) => {
      if (!track.available) return false;
      const relative = master - track.offset;
      return relative >= 0 && relative < track.audio.duration;
    });
  }

  function setStatus(message) {
    statusNode.textContent = message;
  }

  function showUnavailable() {
    playing = false;
    gapClock = null;
    tracks.forEach((track) => track.audio.pause());
    setStatus("Recording unavailable");
    playerNode.hidden = true;
  }

  function retryManifest(message) {
    if (manifestAttempts < maximumManifestAttempts) {
      setStatus(message);
      window.setTimeout(openSession, manifestRetryDelayMs);
      return;
    }
    showUnavailable();
  }

  async function openSession() {
    manifestAttempts += 1;
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), manifestRequestTimeoutMs);
      try {
        const response = await fetch("/recordings/session", {
          method: "POST", headers: { authorization: "Bearer " + token },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500)
            retryManifest("Checking recording again...");
          else showUnavailable();
          return;
        }
        const manifest = await response.json();
        const pendingMessage = manifest.status === "processing"
          ? "Recording is being processed"
          : manifest.status === "unavailable" ? "Recording is not ready yet" : null;
        if (pendingMessage !== null) { retryManifest(pendingMessage); return; }
        if (manifest.status !== "ready" || manifest.tracks.length === 0)
          { showUnavailable(); return; }
        const tracksReady = await prepareTracks(manifest.tracks);
        if (!tracksReady) {
          if (metadataRetryUsed) showUnavailable();
          else {
            metadataRetryUsed = true;
            retryManifest("Checking recording tracks again...");
          }
          return;
        }
        window.history.replaceState(
          null,
          "",
          window.location.pathname + window.location.search,
        );
      } finally { window.clearTimeout(timeoutId); }
    } catch {
      retryManifest("Checking recording again...");
    }
  }

  async function prepareTracks(manifestTracks) {
    const volume = Math.min(1, 0.9 / Math.sqrt(manifestTracks.length));
    tracks = manifestTracks.map((item) => {
      const audio = document.createElement("audio");
      audio.preload = "metadata";
      audio.src = item.url;
      audio.volume = volume;
      tracksNode.append(audio);
      return {
        audio,
        offset: item.timelineOffsetMs / 1000,
        available: true,
        playAttempt: 0,
      };
    });
    await Promise.all(tracks.map(loadMetadata));
    const available = tracks.filter((track) => track.available);
    if (available.length === 0) {
      return false;
    }
    tracks = available;
    duration = Math.max(...tracks.map((track) => track.offset + track.audio.duration));
    seekNode.max = String(duration);
    durationNode.textContent = formatTime(duration);
    playerNode.hidden = false;
    setStatus("Ready to play");
    if (tracks.length < manifestTracks.length) {
      noticeNode.textContent = "Some tracks are unavailable";
      noticeNode.hidden = false;
    }
    renderPosition(0);
    return true;
  }

  function loadMetadata(track) {
    return new Promise((resolve) => {
      let settled = false;
      let timeoutId;
      const loaded = () => finish(true);
      const failed = () => finish(false);
      const finish = (available) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        track.audio.removeEventListener("loadedmetadata", loaded);
        track.audio.removeEventListener("error", failed);
        track.available = available
          && Number.isFinite(track.audio.duration)
          && track.audio.duration > 0;
        if (!track.available) {
          track.audio.pause();
          track.audio.removeAttribute("src");
          track.audio.load();
          track.audio.remove();
        }
        resolve();
      };
      track.audio.addEventListener("loadedmetadata", loaded, { once: true });
      track.audio.addEventListener("error", failed, { once: true });
      timeoutId = window.setTimeout(() => finish(false), metadataTimeoutMs);
      track.audio.load();
    });
  }

  async function unlockTracks() {
    await Promise.all(tracks.map(async (track) => {
      track.audio.muted = true;
      try {
        await track.audio.play();
        pauseTrack(track);
      } catch {
        track.available = false;
      } finally {
        track.audio.muted = false;
        track.audio.currentTime = 0;
      }
    }));
  }

  async function startPlayback() {
    if (starting) return;
    starting = true;
    try {
      if (position >= duration) position = 0;
      await unlockTracks();
      if (!tracks.some((track) => track.available)) {
        showUnavailable();
        return;
      }
      if (tracks.some((track) => !track.available)) {
        noticeNode.textContent = "Some tracks are unavailable";
        noticeNode.hidden = false;
      }
      playing = true;
      gapClock = null;
      toggleNode.textContent = "❚❚";
      toggleNode.setAttribute("aria-label", "Pause");
      syncTracks(position, true);
      requestAnimationFrame(tick);
    } finally {
      starting = false;
    }
  }

  function pausePlayback() {
    position = currentPosition();
    playing = false;
    gapClock = null;
    tracks.forEach(pauseTrack);
    toggleNode.textContent = "▶";
    toggleNode.setAttribute("aria-label", "Play");
    renderPosition(position);
  }

  function syncTracks(master, shouldPlay) {
    tracks.forEach((track) => {
      if (!track.available) return;
      const relative = master - track.offset;
      const active = relative >= 0 && relative < track.audio.duration;
      if (!active) {
        pauseTrack(track);
        if (relative < 0) track.audio.currentTime = 0;
        return;
      }
      if (Math.abs(track.audio.currentTime - relative) > 0.18) {
        track.audio.currentTime = relative;
      }
      if (shouldPlay && track.audio.paused) {
        const playAttempt = ++track.playAttempt;
        void track.audio.play().catch(() => {
          if (playAttempt !== track.playAttempt || !playing) return;
          track.available = false;
          pauseTrack(track);
          if (!tracks.some((candidate) => candidate.available)) showUnavailable();
          else {
            noticeNode.textContent = "Some tracks are unavailable";
            noticeNode.hidden = false;
          }
        });
      }
    });
  }

  function pauseTrack(track) {
    track.playAttempt += 1;
    track.audio.pause();
  }

  function renderPosition(value) {
    seekNode.value = String(value);
    const maximum = Number(seekNode.max);
    const progress = maximum > 0
      ? Math.min(100, Math.max(0, value / maximum * 100))
      : 0;
    seekNode.style.setProperty("--seek-progress", progress + "%");
    currentNode.textContent = formatTime(value);
  }

  function tick(now) {
    if (!playing) return;
    const master = currentPosition();
    position = master;
    renderPosition(master);
    if (master >= duration) {
      position = duration;
      pausePlayback();
      return;
    }
    const activeTrackNeedsStart = activeTracksAt(master).some((track) => track.audio.paused);
    if (activeTrackNeedsStart || now - lastSyncAt > 350) {
      lastSyncAt = now;
      syncTracks(master, true);
    }
    requestAnimationFrame(tick);
  }

  toggleNode.addEventListener("click", () => {
    if (playing) pausePlayback();
    else void startPlayback();
  });
  seekNode.addEventListener("input", () => {
    position = Number(seekNode.value);
    gapClock = null;
    renderPosition(position);
    syncTracks(position, playing);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && playing) {
      const master = currentPosition();
      position = master;
      renderPosition(master);
      syncTracks(master, true);
    }
  });
  void openSession();
})();
`;

const recordingPlaybackAssetVersion = createHash("sha256")
  .update(recordingPlaybackStyle)
  .update(recordingPlaybackClientScript)
  .digest("hex")
  .slice(0, 12);

export const recordingPlaybackPageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Meeting recording</title>
  <link rel="stylesheet" href="/recordings/player.css?v=${recordingPlaybackAssetVersion}">
</head>
<body>
  <main class="shell">
    <section class="card" aria-labelledby="title">
      <div class="eyebrow">QUANTA MEETING</div>
      <h1 id="title">Meeting recording</h1>
      <p id="status" class="status" role="status">Checking access...</p>
      <div id="player" class="player" hidden>
        <button id="toggle" class="toggle" type="button" aria-label="Play">▶</button>
        <div class="timeline">
          <input id="seek" type="range" min="0" max="1" value="0" step="0.01" aria-label="Recording position">
          <div class="times"><span id="current">0:00</span><span id="duration">0:00</span></div>
        </div>
      </div>
      <p id="notice" class="notice" hidden></p>
      <div id="tracks" hidden></div>
    </section>
  </main>
  <script src="/recordings/player.js?v=${recordingPlaybackAssetVersion}" defer></script>
</body>
</html>`;
