import { createHash } from "node:crypto";

import { playbackManifestSchema } from "./recording-playback-evidence-probe-policy.js";
import type { PlaybackManifest } from "./recording-playback-evidence-probe-policy.js";
import {
  readRecordingPlaybackBody,
  recordingPlaybackFailure,
  requestRecordingPlayback,
} from "./recording-playback-evidence-http.js";
import type {
  LiveDiscordPlaybackReadinessProbe,
  LiveDiscordPlaybackReadinessProof,
} from "./live-discord-playback-link-observer.js";

const maximumManifestBytes = 256 * 1024;

export class HttpLiveDiscordPlaybackReadinessProbe implements LiveDiscordPlaybackReadinessProbe {
  readonly #expectedOrigin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;
  readonly #maximumProcessingAttempts: number;
  readonly #retryDelayMilliseconds: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  public constructor(options: {
    readonly expectedOrigin: string;
    readonly fetch?: typeof fetch;
    readonly maximumProcessingAttempts?: number;
    readonly retryDelayMilliseconds?: number;
    readonly timeoutMilliseconds?: number;
    readonly wait?: (milliseconds: number) => Promise<void>;
  }) {
    this.#expectedOrigin = parseHttpsOrigin(options.expectedOrigin);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
    this.#maximumProcessingAttempts = options.maximumProcessingAttempts ?? 301;
    this.#retryDelayMilliseconds = options.retryDelayMilliseconds ?? 2_000;
    this.#wait = options.wait ?? ((milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }));
  }

  public async prove(input: {
    readonly messageId: string;
    readonly recordingId?: string;
    readonly recordingPlaybackUrl: string;
  }): Promise<LiveDiscordPlaybackReadinessProof> {
    const link = parsePlaybackLink(input.recordingPlaybackUrl, this.#expectedOrigin);
    const capability = link.hash.slice(1);
    const statuses: Array<"processing" | "ready"> = [];
    let cookie: string | undefined;
    let sessionId: string | undefined;
    let manifest: PlaybackManifest | undefined;
    for (let attempt = 0; attempt < this.#maximumProcessingAttempts; attempt += 1) {
      const exchanging = cookie === undefined;
      const response = await this.#requestManifest(
        new URL(exchanging
          ? "/recordings/session"
          : `/recordings/s/${encodeURIComponent(sessionId!)}/session`, link.origin),
        exchanging
          ? { authorization: `Bearer ${capability}` }
          : { cookie: cookie!, "x-recording-playback-session": "resume" },
      );
      manifest = response.manifest;
      if (input.recordingId !== undefined && manifest.recordingId !== input.recordingId) {
        throw new Error("Recording playback readiness manifest belongs to another recording");
      }
      if (cookie === undefined) {
        cookie = sessionCookie(response.response, capability, manifest.sessionId);
        sessionId = manifest.sessionId;
      } else if (response.response.headers.has("set-cookie") || manifest.sessionId !== sessionId) {
        throw new Error("Recording playback readiness session changed while polling");
      }
      if (manifest.status === "unavailable") {
        throw new Error("Recording playback link was broken when first visible");
      }
      statuses.push(manifest.status);
      if (manifest.status === "ready") {
        break;
      }
      if (attempt + 1 < this.#maximumProcessingAttempts) {
        await this.#wait(this.#retryDelayMilliseconds);
      }
    }
    if (manifest?.status !== "ready" || manifest.tracks.length === 0) {
      throw new Error("Recording playback did not become ready in the bounded live-link window");
    }
    assertSafeTracks(manifest, link.origin);
    const processingObserved = statuses.slice(0, -1).includes("processing");
    return Object.freeze({
      capabilitySha256: createHash("sha256").update(capability, "utf8").digest("hex"),
      messageId: input.messageId,
      readinessExpectation: processingObserved ? "processing-to-ready" as const : "already-ready" as const,
      recordingId: manifest.recordingId,
      status: "ready" as const,
      statuses: Object.freeze(statuses),
      trackCount: manifest.tracks.length,
    });
  }

  async #requestManifest(
    url: URL,
    headers: Readonly<Record<string, string>>,
  ): Promise<{ readonly manifest: PlaybackManifest; readonly response: Response }> {
    return requestRecordingPlayback({
      consume: async (response, signal) => {
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw recordingPlaybackFailure(
            `Recording playback readiness probe failed with status ${response.status}`,
          );
        }
        const bytes = await readRecordingPlaybackBody(response, signal, maximumManifestBytes);
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        } catch {
          throw recordingPlaybackFailure("Recording playback readiness probe returned invalid JSON");
        }
        return { manifest: playbackManifestSchema.parse(raw), response };
      },
      fetch: this.#fetch,
      init: { headers, method: "POST" },
      timeoutMilliseconds: this.#timeoutMilliseconds,
      url,
    });
  }
}

function assertSafeTracks(manifest: PlaybackManifest, origin: string): void {
  for (const [index, track] of manifest.tracks.entries()) {
    const url = new URL(track.url, origin);
    if (url.origin !== origin ||
      url.pathname !== `/recordings/s/${manifest.sessionId}/tracks/${index}` ||
      url.search !== "" || url.hash !== "") {
      throw new Error("Recording playback readiness manifest contains an unsafe track link");
    }
  }
}

function sessionCookie(response: Response, capability: string, sessionId: string): string {
  const parts = response.headers.get("set-cookie")?.split(";").map((part) => part.trim()) ?? [];
  const pair = parts[0];
  const attributes = new Map(parts.slice(1).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0
      ? [part.toLowerCase(), ""]
      : [part.slice(0, separator).toLowerCase(), part.slice(separator + 1)];
  }));
  if (pair !== `recording_playback_access=${capability}` ||
    !attributes.has("httponly") || !attributes.has("secure") ||
    attributes.get("samesite")?.toLowerCase() !== "strict" ||
    attributes.get("path") !== `/recordings/s/${sessionId}` ||
    attributes.get("max-age") !== "604800" || attributes.has("domain")) {
    throw new Error("Recording playback readiness session lacks a secure scoped cookie");
  }
  return pair;
}

function parsePlaybackLink(value: string, expectedOrigin: string): URL {
  const link = new URL(value);
  if (
    link.protocol !== "https:" || link.origin !== expectedOrigin ||
    link.username !== "" || link.password !== "" ||
    link.pathname !== "/recordings/playback" || link.search !== "" ||
    !/^#[A-Za-z0-9._-]{1,1024}$/u.test(link.hash)
  ) {
    throw new Error("Observed recording playback link is not an exact possession URL");
  }
  return link;
}

function parseHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.origin !== value ||
    url.username !== "" || url.password !== "" ||
    url.pathname !== "/" || url.search !== "" || url.hash !== ""
  ) {
    throw new Error("Playback readiness probe requires an exact HTTPS origin");
  }
  return url.origin;
}
