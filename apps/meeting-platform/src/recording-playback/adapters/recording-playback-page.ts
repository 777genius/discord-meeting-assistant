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
  let startedAt = 0;
  let playing = false;
  let lastSyncAt = 0;

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
    return Math.min(duration, position + (performance.now() - startedAt) / 1000);
  }

  function setStatus(message) {
    statusNode.textContent = message;
  }

  function showUnavailable() {
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
      return { audio, offset: item.timelineOffsetMs / 1000, available: true };
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
      const finish = (available) => {
        if (settled) return;
        settled = true;
        track.available = available && Number.isFinite(track.audio.duration);
        resolve();
      };
      track.audio.addEventListener("loadedmetadata", () => finish(true), { once: true });
      track.audio.addEventListener("error", () => finish(false), { once: true });
      track.audio.load();
    });
  }

  async function unlockTracks() {
    await Promise.all(tracks.map(async (track) => {
      track.audio.muted = true;
      try {
        await track.audio.play();
        track.audio.pause();
      } catch {
        track.available = false;
      } finally {
        track.audio.muted = false;
        track.audio.currentTime = 0;
      }
    }));
  }

  async function startPlayback() {
    if (position >= duration) position = 0;
    await unlockTracks();
    playing = true;
    startedAt = performance.now();
    toggleNode.textContent = "❚❚";
    toggleNode.setAttribute("aria-label", "Пауза");
    await syncTracks(true);
    requestAnimationFrame(tick);
  }

  function pausePlayback() {
    position = currentPosition();
    playing = false;
    tracks.forEach((track) => track.audio.pause());
    toggleNode.textContent = "▶";
    toggleNode.setAttribute("aria-label", "Воспроизвести");
    renderPosition(position);
  }

  async function syncTracks(shouldPlay) {
    const master = currentPosition();
    await Promise.all(tracks.map(async (track) => {
      const relative = master - track.offset;
      const active = relative >= 0 && relative < track.audio.duration;
      if (!active) {
        track.audio.pause();
        if (relative < 0) track.audio.currentTime = 0;
        return;
      }
      if (Math.abs(track.audio.currentTime - relative) > 0.18) {
        track.audio.currentTime = relative;
      }
      if (shouldPlay && track.audio.paused) {
        try { await track.audio.play(); } catch { track.available = false; }
      }
    }));
  }

  function renderPosition(value) {
    seekNode.value = String(value);
    currentNode.textContent = formatTime(value);
  }

  function tick(now) {
    if (!playing) return;
    const master = currentPosition();
    renderPosition(master);
    if (master >= duration) {
      position = duration;
      pausePlayback();
      return;
    }
    if (now - lastSyncAt > 350) {
      lastSyncAt = now;
      void syncTracks(true);
    }
    requestAnimationFrame(tick);
  }

  toggleNode.addEventListener("click", () => {
    if (playing) pausePlayback();
    else void startPlayback();
  });
  seekNode.addEventListener("input", () => {
    position = Number(seekNode.value);
    startedAt = performance.now();
    renderPosition(position);
    void syncTracks(playing);
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && playing) void syncTracks(true);
  });
  void openSession();
})();
`;
