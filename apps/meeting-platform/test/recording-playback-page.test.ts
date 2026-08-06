import { runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  recordingPlaybackClientScript,
  recordingPlaybackStyle,
} from "../src/recording-playback/adapters/recording-playback-page.js";

type Listener = () => void;
type AudioMode = "error" | "loaded" | "stalled";

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<Listener>>();
  hidden = false;
  max = "";
  textContent = "";
  value = "";

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  append(child: FakeElement): void {
    this.children.push(child);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

class FakeAudio extends FakeElement {
  currentTime = 0;
  muted = false;
  paused = true;
  preload = "";
  removed = false;
  src = "";
  volume = 1;
  private playCalls = 0;
  private pendingPlayRejection: ((error: Error) => void) | undefined;

  constructor(
    private readonly mode: AudioMode,
    readonly duration: number,
    private readonly failFromPlayCall = Number.POSITIVE_INFINITY,
    private readonly interruptiblePlayCall = Number.POSITIVE_INFINITY,
  ) {
    super();
  }

  load(): void {
    if (this.src.length === 0) {
      return;
    }
    if (this.mode === "loaded") {
      this.emit("loadedmetadata");
    }
    if (this.mode === "error") {
      this.emit("error");
    }
  }

  pause(): void {
    this.paused = true;
    const reject = this.pendingPlayRejection;
    this.pendingPlayRejection = undefined;
    if (reject !== undefined) {
      queueMicrotask(() => {
        reject(new Error("playback interrupted"));
      });
    }
  }

  play(): Promise<void> {
    this.playCalls += 1;
    if (this.playCalls >= this.failFromPlayCall) {
      this.paused = true;
      return Promise.reject(new Error("playback rejected"));
    }
    this.paused = false;
    if (this.playCalls === this.interruptiblePlayCall) {
      return new Promise((_resolve, reject) => {
        this.pendingPlayRejection = reject;
      });
    }
    return Promise.resolve();
  }

  remove(): void {
    this.removed = true;
  }

  removeAttribute(name: string): void {
    if (name === "src") {
      this.src = "";
    }
  }
}

interface TrackFixture {
  readonly audio: FakeAudio;
  readonly timelineOffsetMs: number;
}

interface PageHarness {
  readonly audios: readonly FakeAudio[];
  readonly current: FakeElement;
  readonly notice: FakeElement;
  readonly player: FakeElement;
  readonly seek: FakeElement;
  readonly status: FakeElement;
  readonly toggle: FakeElement;
  advanceClock(milliseconds: number): void;
  animationFrameRequestCount(): number;
  restoreVisibility(): void;
  runAnimationFrame(): void;
}

function setWindowTimeout(callback: () => void, milliseconds: number) {
  return setTimeout(callback, milliseconds);
}

function createPageHarness(trackFixtures: readonly TrackFixture[]): PageHarness {
  const status = new FakeElement();
  const player = new FakeElement();
  player.hidden = true;
  const notice = new FakeElement();
  notice.hidden = true;
  const tracks = new FakeElement();
  tracks.hidden = true;
  const toggle = new FakeElement();
  const seek = new FakeElement();
  const current = new FakeElement();
  const duration = new FakeElement();
  const elements = new Map<string, FakeElement>([
    ["#status", status],
    ["#player", player],
    ["#notice", notice],
    ["#tracks", tracks],
    ["#toggle", toggle],
    ["#seek", seek],
    ["#current", current],
    ["#duration", duration],
  ]);
  const audioQueue = trackFixtures.map((fixture) => fixture.audio);
  let clock = 0;
  let animationFrame: ((now: number) => void) | undefined;
  let animationFrameRequests = 0;
  const documentListeners = new Map<string, Listener>();
  const document = {
    hidden: false,
    addEventListener: (type: string, listener: Listener) => {
      documentListeners.set(type, listener);
    },
    createElement: (tag: string) => {
      if (tag !== "audio") {
        throw new Error(`Unexpected element: ${tag}`);
      }
      const audio = audioQueue.shift();
      if (audio === undefined) {
        throw new Error("Missing audio fixture");
      }
      return audio;
    },
    querySelector: (selector: string) => elements.get(selector),
  };
  const window = {
    clearTimeout,
    location: { hash: `#${"a".repeat(48)}` },
    setTimeout: setWindowTimeout,
  };
  const fetch = vi.fn(async () => ({
    json: async () => ({
      status: "ready",
      tracks: trackFixtures.map((fixture, index) => ({
        timelineOffsetMs: fixture.timelineOffsetMs,
        url: `/recordings/s/test/tracks/${index}`,
      })),
    }),
    ok: true,
  }));

  runInNewContext(recordingPlaybackClientScript, {
    document,
    fetch,
    performance: { now: () => clock },
    requestAnimationFrame: (callback: (now: number) => void) => {
      animationFrame = callback;
      animationFrameRequests += 1;
      return 1;
    },
    window,
  });

  return {
    audios: trackFixtures.map((fixture) => fixture.audio),
    current,
    notice,
    player,
    seek,
    status,
    toggle,
    advanceClock: (milliseconds) => {
      clock += milliseconds;
    },
    animationFrameRequestCount: () => animationFrameRequests,
    restoreVisibility: () => {
      document.hidden = false;
      documentListeners.get("visibilitychange")?.();
    },
    runAnimationFrame: () => {
      const callback = animationFrame;
      animationFrame = undefined;
      callback?.(clock);
    },
  };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 32; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("recording playback browser page", () => {
  it("keeps the hidden player out of layout", () => {
    expect(recordingPlaybackStyle).toContain(".player[hidden] { display: none; }");
  });

  it("times out a stalled metadata request and exposes the available tracks", async () => {
    vi.useFakeTimers();
    const available = new FakeAudio("loaded", 12);
    const stalled = new FakeAudio("stalled", Number.NaN);
    const page = createPageHarness([
      { audio: available, timelineOffsetMs: 0 },
      { audio: stalled, timelineOffsetMs: 250 },
    ]);

    await flushAsync();
    expect(page.player.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    expect(page.player.hidden).toBe(false);
    expect(page.status.textContent).toBe("Готово к прослушиванию");
    expect(page.notice.hidden).toBe(false);
    expect(page.notice.textContent).toBe("Часть дорожек недоступна");
    expect(stalled.removed).toBe(true);
    expect(stalled.src).toBe("");
    expect(stalled.listeners.get("loadedmetadata")?.size ?? 0).toBe(0);
    expect(stalled.listeners.get("error")?.size ?? 0).toBe(0);
  });

  it("shows unavailable when every metadata request times out", async () => {
    vi.useFakeTimers();
    const stalled = new FakeAudio("stalled", Number.NaN);
    const page = createPageHarness([{ audio: stalled, timelineOffsetMs: 0 }]);

    await vi.advanceTimersByTimeAsync(15_000);
    await flushAsync();

    expect(page.status.textContent).toBe("Запись недоступна");
    expect(page.player.hidden).toBe(true);
    expect(stalled.removed).toBe(true);
  });

  it("removes an errored media element immediately", async () => {
    const available = new FakeAudio("loaded", 12);
    const errored = new FakeAudio("error", Number.NaN);
    const page = createPageHarness([
      { audio: available, timelineOffsetMs: 0 },
      { audio: errored, timelineOffsetMs: 0 },
    ]);
    await flushAsync();

    expect(page.player.hidden).toBe(false);
    expect(page.notice.hidden).toBe(false);
    expect(errored.removed).toBe(true);
    expect(errored.src).toBe("");
  });

  it("freezes the meeting timeline on the slowest active media track", async () => {
    const ahead = new FakeAudio("loaded", 20);
    const stalled = new FakeAudio("loaded", 20);
    const page = createPageHarness([
      { audio: ahead, timelineOffsetMs: 0 },
      { audio: stalled, timelineOffsetMs: 0 },
    ]);
    await flushAsync();
    page.toggle.emit("click");
    await flushAsync();

    ahead.currentTime = 2;
    stalled.currentTime = 0;
    page.advanceClock(2_000);
    page.runAnimationFrame();
    await flushAsync();

    expect(page.seek.value).toBe("0");
    expect(page.current.textContent).toBe("0:00");
    expect(ahead.currentTime).toBe(0);
  });

  it("starts a newly active offset track without waiting for the periodic sync", async () => {
    const first = new FakeAudio("loaded", 20);
    const later = new FakeAudio("loaded", 20);
    const page = createPageHarness([
      { audio: first, timelineOffsetMs: 0 },
      { audio: later, timelineOffsetMs: 650 },
    ]);
    await flushAsync();
    page.toggle.emit("click");
    await flushAsync();

    first.currentTime = 1;
    page.advanceClock(100);
    page.runAnimationFrame();
    await flushAsync();

    expect(later.paused).toBe(false);
    expect(later.currentTime).toBeCloseTo(0.35);
  });

  it("resumes a backgrounded page from the media position instead of stale UI state", async () => {
    const audio = new FakeAudio("loaded", 20);
    const page = createPageHarness([{ audio, timelineOffsetMs: 0 }]);
    await flushAsync();
    page.toggle.emit("click");
    await flushAsync();

    audio.currentTime = 3;
    page.advanceClock(3_000);
    page.restoreVisibility();

    expect(page.seek.value).toBe("3");
    expect(audio.currentTime).toBe(3);
  });

  it("drops a track rejected during playback and continues with the healthy track", async () => {
    const healthy = new FakeAudio("loaded", 20);
    const rejected = new FakeAudio("loaded", 20, 2);
    const page = createPageHarness([
      { audio: healthy, timelineOffsetMs: 0 },
      { audio: rejected, timelineOffsetMs: 0 },
    ]);
    await flushAsync();
    page.toggle.emit("click");
    await flushAsync();

    expect(page.player.hidden).toBe(false);
    expect(page.notice.textContent).toBe("Часть дорожек недоступна");
    expect(rejected.paused).toBe(true);

    healthy.currentTime = 1;
    page.advanceClock(1_000);
    page.runAnimationFrame();

    expect(page.seek.value).toBe("1");
  });

  it("does not drop a healthy track when pause interrupts a pending play", async () => {
    const audio = new FakeAudio(
      "loaded",
      20,
      Number.POSITIVE_INFINITY,
      2,
    );
    const page = createPageHarness([{ audio, timelineOffsetMs: 0 }]);
    await flushAsync();
    page.toggle.emit("click");
    await flushAsync();

    page.toggle.emit("click");
    await flushAsync();

    expect(page.notice.hidden).toBe(true);
    expect(page.status.textContent).toBe("Готово к прослушиванию");

    page.toggle.emit("click");
    await flushAsync();
    audio.currentTime = 1;
    page.advanceClock(1_000);
    page.runAnimationFrame();

    expect(page.seek.value).toBe("1");
    expect(audio.paused).toBe(false);
  });

  it("coalesces rapid play clicks into one animation loop", async () => {
    const audio = new FakeAudio("loaded", 20);
    const page = createPageHarness([{ audio, timelineOffsetMs: 0 }]);
    await flushAsync();

    page.toggle.emit("click");
    page.toggle.emit("click");
    await flushAsync();

    expect(page.animationFrameRequestCount()).toBe(1);
  });
});
