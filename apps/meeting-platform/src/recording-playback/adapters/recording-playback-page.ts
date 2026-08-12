import { createHash } from "node:crypto";

import { recordingPlaybackStyle } from "./recording-playback-style.js";

export { recordingPlaybackStyle } from "./recording-playback-style.js";

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
  let gapClock = null, processingAttempts = 0, transientFailures = 0, metadataAttempts = 0;
  let activeSessionId = window.history.state?.recordingPlaybackSessionId;
  const testConfig = window.__recordingPlaybackTestConfig ?? {};
  const metadataTimeoutMs = testConfig.metadataTimeoutMs ?? 15000;
  const manifestRequestTimeoutMs = testConfig.manifestRequestTimeoutMs ?? 5000;
  const manifestRetryDelayMs = testConfig.manifestRetryDelayMs ?? 5000;
  const maximumProcessingAttempts = testConfig.maximumProcessingAttempts ?? Math.floor(4 * 60 * 60 * 1000 / manifestRetryDelayMs) + 1;
  const maximumTransientFailures = testConfig.maximumTransientFailures ?? 24;
  const maximumMetadataAttempts = testConfig.maximumMetadataAttempts ?? 3;

  function validSessionId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{32}$/.test(value); }
  const token = window.location.hash.slice(1), tokenIsValid = /^[A-Za-z0-9._-]{40,1024}$/.test(token);
  if (!tokenIsValid && !validSessionId(activeSessionId)) { showUnavailable(); return; }
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
    clearTracks();
    setStatus("Recording unavailable");
    playerNode.hidden = true;
  }

  function retryProcessing(message) {
    processingAttempts += 1;
    if (processingAttempts < maximumProcessingAttempts) {
      setStatus(message);
      window.setTimeout(openSession, manifestRetryDelayMs);
      return;
    }
    showUnavailable();
  }

  function retryTransient(message) {
    transientFailures += 1;
    if (transientFailures < maximumTransientFailures) {
      setStatus(message);
      window.setTimeout(openSession, manifestRetryDelayMs);
      return;
    }
    showUnavailable();
  }

  function clearTracks() {
    tracks.forEach((track) => {
      if (track.errorListener) track.audio.removeEventListener("error", track.errorListener);
      track.audio.pause();
      track.audio.removeAttribute("src");
      track.audio.load();
      track.audio.remove();
    });
    tracks = [];
  }

  async function openSession() {
    try {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), manifestRequestTimeoutMs);
      try {
        const exchangingCapability = !validSessionId(activeSessionId);
        const sessionUrl = exchangingCapability ? "/recordings/session" : "/recordings/s/" + activeSessionId + "/session";
        const response = await fetch(sessionUrl, {
          method: "POST", headers: exchangingCapability ? { authorization: "Bearer " + token }
            : { "x-recording-playback-session": "resume" },
          signal: controller.signal,
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500)
            retryTransient("Checking recording again...");
          else showUnavailable();
          return;
        }
        const manifest = await response.json();
        const returnedSessionId = manifest.sessionId;
        if (!validSessionId(returnedSessionId) || (!exchangingCapability && returnedSessionId !== activeSessionId)) { showUnavailable(); return; }
        if (manifest.status !== "processing" && manifest.status !== "unavailable" && manifest.status !== "ready") { showUnavailable(); return; }
        transientFailures = 0;
        if (exchangingCapability) {
          activeSessionId = returnedSessionId;
          window.history.replaceState({ recordingPlaybackSessionId: returnedSessionId }, "", window.location.pathname + window.location.search);
        }
        const pendingMessage = manifest.status === "processing" ? "Recording is being processed"
          : manifest.status === "unavailable" ? "Recording is not ready yet" : null;
        if (pendingMessage !== null) { retryProcessing(pendingMessage); return; }
        if (manifest.status !== "ready" || manifest.tracks.length === 0)
          { showUnavailable(); return; }
        processingAttempts = 0;
        metadataAttempts += 1;
        const tracksReady = await prepareTracks(manifest.tracks);
        if (!tracksReady) {
          if (metadataAttempts >= maximumMetadataAttempts) { showUnavailable(); return; }
          setStatus("Checking recording tracks again...");
          window.setTimeout(openSession, manifestRetryDelayMs);
          return;
        }
      } finally { window.clearTimeout(timeoutId); }
    } catch {
      retryTransient("Checking recording again...");
    }
  }

  async function prepareTracks(manifestTracks) {
    clearTracks();
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
        errorListener: null,
        playAttempt: 0,
      };
    });
    await Promise.all(tracks.map(loadMetadata));
    const available = tracks.filter((track) => track.available);
    if (available.length !== manifestTracks.length) {
      clearTracks();
      return false;
    }
    duration = Math.max(...tracks.map((track) => track.offset + track.audio.duration));
    seekNode.max = String(duration);
    durationNode.textContent = formatTime(duration);
    playerNode.hidden = false;
    setStatus("Ready to play");
    noticeNode.hidden = true;
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
        if (track.available) {
          track.errorListener = () => dropTrack(track);
          track.audio.addEventListener("error", track.errorListener);
        }
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
          dropTrack(track);
        });
      }
    });
  }

  function dropTrack(track) {
    if (!track.available) return;
    track.available = false;
    if (track.errorListener) track.audio.removeEventListener("error", track.errorListener);
    track.errorListener = null;
    pauseTrack(track);
    track.audio.removeAttribute("src");
    track.audio.load();
    track.audio.remove();
    if (!tracks.some((candidate) => candidate.available)) showUnavailable();
    else {
      noticeNode.textContent = "Some tracks are unavailable";
      noticeNode.hidden = false;
    }
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
