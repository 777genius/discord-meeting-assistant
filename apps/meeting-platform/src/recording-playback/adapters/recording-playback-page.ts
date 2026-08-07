export const recordingPlaybackPageHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Запись встречи</title>
  <link rel="stylesheet" href="/recordings/player.css">
</head>
<body>
  <main class="shell">
    <section class="card" aria-labelledby="title">
      <div class="eyebrow">QUANTA MEETING</div>
      <h1 id="title">Запись встречи</h1>
      <p id="status" class="status" role="status">Проверяем доступ...</p>
      <div id="player" class="player" hidden>
        <button id="toggle" class="toggle" type="button" aria-label="Воспроизвести">▶</button>
        <div class="timeline">
          <input id="seek" type="range" min="0" max="1" value="0" step="0.01" aria-label="Позиция записи">
          <div class="times"><span id="current">0:00</span><span id="duration">0:00</span></div>
        </div>
      </div>
      <p id="notice" class="notice" hidden></p>
      <div id="tracks" hidden></div>
    </section>
  </main>
  <script src="/recordings/player.js" defer></script>
</body>
</html>`;

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
.timeline { width: 100%; min-width: 0; }
input[type="range"] { width: 100%; accent-color: #a78bfa; cursor: pointer; }
.times { display: flex; justify-content: space-between; margin-top: 8px; color: #8d8d99; font-variant-numeric: tabular-nums; font-size: 13px; }
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
  let gapClock = null;
  const metadataTimeoutMs = 15000;

  const token = window.location.hash.slice(1);
  if (!/^[A-Za-z0-9._-]{40,1024}$/.test(token)) {
    showUnavailable();
    return;
  }
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );

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
    setStatus("Запись недоступна");
    playerNode.hidden = true;
  }

  async function openSession() {
    try {
      const response = await fetch("/recordings/session", {
        method: "POST",
        headers: { authorization: "Bearer " + token },
      });
      if (!response.ok) {
        showUnavailable();
        return;
      }
      const manifest = await response.json();
      if (manifest.status === "processing") {
        setStatus("Запись обрабатывается");
        window.setTimeout(openSession, 5000);
        return;
      }
      if (manifest.status !== "ready" || manifest.tracks.length === 0) {
        showUnavailable();
        return;
      }
      await prepareTracks(manifest.tracks);
    } catch {
      showUnavailable();
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
      showUnavailable();
      return;
    }
    tracks = available;
    duration = Math.max(...tracks.map((track) => track.offset + track.audio.duration));
    seekNode.max = String(duration);
    durationNode.textContent = formatTime(duration);
    playerNode.hidden = false;
    setStatus("Готово к прослушиванию");
    if (tracks.length < manifestTracks.length) {
      noticeNode.textContent = "Часть дорожек недоступна";
      noticeNode.hidden = false;
    }
    renderPosition(0);
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
        noticeNode.textContent = "Часть дорожек недоступна";
        noticeNode.hidden = false;
      }
      playing = true;
      gapClock = null;
      toggleNode.textContent = "❚❚";
      toggleNode.setAttribute("aria-label", "Пауза");
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
    toggleNode.setAttribute("aria-label", "Воспроизвести");
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
            noticeNode.textContent = "Часть дорожек недоступна";
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
