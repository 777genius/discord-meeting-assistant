import { createHash } from "node:crypto";

import {
  recordingPlaybackEvidenceV1Schema,
  type RecordingPlaybackEvidenceV1,
} from "./recording-playback-evidence-schema.js";
import {
  hashRecordingPlaybackBody,
  readRecordingPlaybackBody,
  recordingPlaybackFailure,
  requestRecordingPlayback,
} from "./recording-playback-evidence-http.js";
import {
  mapConcurrently,
  maximumTracks,
  playbackManifestSchema,
  type PlaybackManifest,
  wait,
} from "./recording-playback-evidence-probe-policy.js";

const maximumTransientFailures = 6;
const maximumProcessingAttempts = 361;
const manifestRetryDelayMilliseconds = 5_000;
const processingTimeoutMilliseconds = 30 * 60 * 1_000;
const requestTimeoutMilliseconds = 15_000;
const trackRequestTimeoutMilliseconds = 240_000;
const trackProofConcurrency = 2;
const playbackPathname = "/recordings/playback";
const sessionPathname = "/recordings/session";
const maximumManifestBytes = 256 * 1024;
export interface RecordingPlaybackProbeInput {
  readonly expectedRecordingId: string;
  readonly expectedTracks: readonly {
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }[];
  readonly readinessExpectation: "already-ready" | "transition";
  readonly recordingPlaybackUrl: string;
}
export interface RecordingPlaybackEvidenceProbe {
  collect(input: RecordingPlaybackProbeInput): Promise<RecordingPlaybackEvidenceV1>;
}
export interface HttpRecordingPlaybackEvidenceProbeOptions {
  readonly expectedOrigin: string;
  readonly fetch?: typeof fetch;
  readonly maximumProcessingAttempts?: number;
  readonly maximumTransientFailures?: number;
  readonly requestTimeoutMilliseconds?: number;
  readonly retryDelayMilliseconds?: number;
  readonly trackRequestTimeoutMilliseconds?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}
export class HttpRecordingPlaybackEvidenceProbe
  implements RecordingPlaybackEvidenceProbe {
  readonly #expectedOrigin: string;
  readonly #fetch: typeof fetch;
  readonly #maximumProcessingAttempts: number;
  readonly #maximumTransientFailures: number;
  readonly #retryDelayMilliseconds: number;
  readonly #requestTimeoutMilliseconds: number;
  readonly #trackRequestTimeoutMilliseconds: number;
  readonly #wait: (milliseconds: number) => Promise<void>;

  public constructor(options: HttpRecordingPlaybackEvidenceProbeOptions) {
    this.#expectedOrigin = parseHttpsOrigin(options.expectedOrigin);
    this.#fetch = options.fetch ?? fetch;
    this.#maximumProcessingAttempts = options.maximumProcessingAttempts ??
      Math.min(
        maximumProcessingAttempts,
        Math.floor(processingTimeoutMilliseconds /
          Math.max(1, options.retryDelayMilliseconds ?? manifestRetryDelayMilliseconds)) + 1,
      );
    this.#maximumTransientFailures = options.maximumTransientFailures ?? maximumTransientFailures;
    this.#requestTimeoutMilliseconds =
      options.requestTimeoutMilliseconds ?? requestTimeoutMilliseconds;
    this.#retryDelayMilliseconds = options.retryDelayMilliseconds ?? manifestRetryDelayMilliseconds;
    this.#trackRequestTimeoutMilliseconds = options.trackRequestTimeoutMilliseconds ??
      trackRequestTimeoutMilliseconds;
    this.#wait = options.wait ?? wait;
  }

  public async collect(input: RecordingPlaybackProbeInput): Promise<RecordingPlaybackEvidenceV1> {
    if (input.expectedTracks.length === 0 || input.expectedTracks.length > maximumTracks) {
      throw new Error(`Recording playback proof requires 1-${maximumTracks} expected tracks`);
    }
    const link = parsePlaybackLink(input.recordingPlaybackUrl, this.#expectedOrigin);
    const capability = link.hash.slice(1);
    const statuses: PlaybackManifest["status"][] = [];
    let cookie: string | undefined;
    let activeSessionId: string | undefined;
    let readyManifest: PlaybackManifest | undefined;
    let processingAttempts = 0;
    let transientFailures = 0;

    while (processingAttempts < this.#maximumProcessingAttempts) {
      let result: { readonly manifest?: PlaybackManifest; readonly response: Response };
      try {
        const exchanging = cookie === undefined;
        const pathname = exchanging
          ? sessionPathname
          : `/recordings/s/${encodeURIComponent(activeSessionId!)}/session`;
        result = await this.#request(new URL(pathname, link.origin), {
          headers: exchanging
            ? { authorization: `Bearer ${capability}` }
            : { cookie, "x-recording-playback-session": "resume" },
          method: "POST",
        }, consumeSessionResponse);
      } catch (error) {
        transientFailures += 1;
        if (transientFailures >= this.#maximumTransientFailures) {
          throw error;
        }
        await this.#wait(this.#retryDelayMilliseconds);
        continue;
      }
      const { manifest, response } = result;
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) &&
          ++transientFailures < this.#maximumTransientFailures) {
          await this.#wait(this.#retryDelayMilliseconds);
          continue;
        }
        throw new Error(`Recording playback session exchange failed with status ${response.status}`);
      }
      if (manifest === undefined) {
        throw new Error("Recording playback session returned no manifest");
      }
      transientFailures = 0;
      assertManifestIdentity(manifest, input.expectedRecordingId, link.origin);
      if (cookie === undefined) {
        cookie = sessionCookie(response, capability, manifest.sessionId);
        activeSessionId = manifest.sessionId;
      } else if (response.headers.has("set-cookie") || manifest.sessionId !== activeSessionId) {
        throw new Error("Recording playback session changed during readiness polling");
      }
      statuses.push(manifest.status);
      processingAttempts += 1;
      if (manifest.status === "ready") {
        readyManifest = manifest;
        break;
      }
      if (processingAttempts < this.#maximumProcessingAttempts) {
        await this.#wait(this.#retryDelayMilliseconds);
      }
    }
    if (readyManifest === undefined || cookie === undefined) {
      throw new Error("Recording playback did not become ready within the bounded probe window");
    }
    assertReadinessExpectation(statuses, input.readinessExpectation);

    const resumed = await this.#resumeSession(
      link.origin,
      cookie,
      readyManifest.sessionId,
      input.expectedRecordingId,
    );
    const tracks = await mapConcurrently(
      readyManifest.tracks,
      trackProofConcurrency,
      (_track, index) => this.#proveTrack(
        link.origin,
        cookie,
        readyManifest,
        input.expectedTracks,
        index,
      ),
    );
    const evidence = recordingPlaybackEvidenceV1Schema.parse({
      capabilitySha256: digest(capability),
      link: { origin: link.origin, pathname: link.pathname },
      manifest: {
        readinessExpectation: input.readinessExpectation,
        recordingId: readyManifest.recordingId,
        statuses,
      },
      resume: {
        manifestStatus: resumed.manifest.status,
        recordingId: resumed.manifest.recordingId,
        statusCode: resumed.statusCode,
      },
      tracks,
    });
    assertNoCapabilityRetained(evidence, capability);
    return evidence;
  }

  async #resumeSession(
    origin: string,
    cookie: string,
    sessionId: string,
    expectedRecordingId: string,
  ): Promise<{ readonly manifest: PlaybackManifest; readonly statusCode: number }> {
    const { manifest, response } = await this.#request(
      new URL(`/recordings/s/${encodeURIComponent(sessionId)}/session`, origin),
      {
        headers: { cookie, "x-recording-playback-session": "resume" },
        method: "POST",
      }, consumeSessionResponse,
    );
    if (!response.ok) {
      throw new Error(`Recording playback session resume failed with status ${response.status}`);
    }
    if (response.headers.has("set-cookie")) {
      throw new Error("Recording playback resume unexpectedly rotated its possession cookie");
    }
    if (manifest === undefined) {
      throw new Error("Recording playback session returned no manifest");
    }
    assertManifestIdentity(manifest, expectedRecordingId, origin);
    if (manifest.status !== "ready" || manifest.sessionId !== sessionId) {
      throw new Error("Recording playback resumed session is not ready");
    }
    return { manifest, statusCode: response.status };
  }

  async #proveTrack(
    origin: string,
    cookie: string,
    manifest: PlaybackManifest,
    expectedTracks: RecordingPlaybackProbeInput["expectedTracks"],
    index: number,
  ): Promise<RecordingPlaybackEvidenceV1["tracks"][number]> {
    if (
      expectedTracks.length === 0 ||
      manifest.tracks.length === 0 ||
      manifest.tracks.length !== expectedTracks.length
    ) {
      throw new Error("Recording playback manifest track count differs from authoritative S3");
    }
    const track = manifest.tracks[index]!;
    const expected = expectedTracks[index]!;
    const trackUrl = new URL(track.url, origin);
    if (
      trackUrl.origin !== origin ||
      trackUrl.pathname !== `/recordings/s/${manifest.sessionId}/tracks/${index}` ||
      trackUrl.search.length > 0 ||
      trackUrl.hash.length > 0
    ) {
      throw new Error("Recording playback manifest contains an unsafe track URL");
    }
    const rangeEnd = expected.sizeBytes - 1;
    const { hash, response } = await this.#request(trackUrl, {
      headers: { cookie, range: `bytes=0-${rangeEnd}` },
      method: "GET",
    }, async (item, signal) => ({
      hash: await hashRecordingPlaybackBody(item, signal, expected.sizeBytes),
      response: item,
    }), this.#trackRequestTimeoutMilliseconds);
    const contentRange = response.headers.get("content-range");
    const contentLength = Number(response.headers.get("content-length"));
    const expectedContentRange = `bytes 0-${rangeEnd}/${expected.sizeBytes}`;
    if (
      response.status !== 206 ||
      contentRange !== expectedContentRange ||
      contentLength !== rangeEnd + 1
    ) {
      throw new Error("Recording playback range response does not match authoritative track size");
    }
    const receivedBytes = hash.byteLength;
    if (receivedBytes !== expected.sizeBytes) {
      throw new Error("Recording playback range response ended before authoritative track size");
    }
    const checksumSha256 = hash.sha256;
    if (checksumSha256 !== expected.checksumSha256) {
      throw new Error("Recording playback track checksum differs from authoritative S3");
    }
    return {
      checksumSha256,
      contentLength: receivedBytes,
      contentRange,
      index,
      statusCode: 206,
    };
  }

  async #request<T>(
    url: URL,
    init: RequestInit,
    consume: (response: Response, signal: AbortSignal) => Promise<T>,
    timeoutMilliseconds = this.#requestTimeoutMilliseconds,
  ): Promise<T> {
    return requestRecordingPlayback({
      consume,
      fetch: this.#fetch,
      init,
      timeoutMilliseconds,
      url,
    });
  }
}

function assertReadinessExpectation(
  statuses: readonly PlaybackManifest["status"][],
  expectation: RecordingPlaybackProbeInput["readinessExpectation"],
): void {
  const pending = statuses.slice(0, -1);
  if (
    (expectation === "already-ready" && statuses.length !== 1) ||
    (expectation === "transition" &&
      !pending.some((status) => status === "processing" || status === "unavailable"))
  ) {
    throw new Error(`Recording playback did not satisfy the explicit ${expectation} readiness gate`);
  }
}

function parsePlaybackLink(value: string, expectedOrigin: string): URL {
  const link = new URL(value);
  if (
    link.protocol !== "https:" ||
    link.origin !== expectedOrigin ||
    link.username.length > 0 ||
    link.password.length > 0 ||
    link.pathname !== playbackPathname ||
    link.search.length > 0 ||
    !/^#[A-Za-z0-9._-]{40,1024}$/u.test(link.hash)
  ) {
    throw new Error("Discord recording playback link is not a valid possession URL");
  }
  return link;
}

function parseHttpsOrigin(value: string): string {
  const origin = new URL(value);
  if (
    origin.protocol !== "https:" ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== "/" ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error("Recording playback probe requires an explicit HTTPS origin");
  }
  return origin.origin;
}

async function parseManifest(response: Response, signal: AbortSignal): Promise<PlaybackManifest> {
  const bytes = await readRecordingPlaybackBody(response, signal, maximumManifestBytes);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw recordingPlaybackFailure("Recording playback session returned invalid JSON");
  }
  const parsed = playbackManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw recordingPlaybackFailure("Recording playback session returned an invalid manifest");
  }
  return parsed.data;
}

async function consumeSessionResponse(
  response: Response,
  signal: AbortSignal,
): Promise<{ readonly manifest?: PlaybackManifest; readonly response: Response }> {
  if (response.ok) {
    return { manifest: await parseManifest(response, signal), response };
  }
  await response.body?.cancel().catch(() => {});
  return { response };
}

function assertManifestIdentity(
  manifest: PlaybackManifest,
  expectedRecordingId: string,
  origin: string,
): void {
  if (manifest.recordingId !== expectedRecordingId) {
    throw new Error("Recording playback manifest is bound to a different recording");
  }
  for (const track of manifest.tracks) {
    const url = new URL(track.url, origin);
    const index = manifest.tracks.indexOf(track);
    if (
      url.origin !== origin ||
      url.pathname !== `/recordings/s/${manifest.sessionId}/tracks/${index}` ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("Recording playback manifest crosses the possession-link origin");
    }
  }
}

function sessionCookie(response: Response, capability: string, sessionId: string): string {
  const setCookie = response.headers.get("set-cookie");
  const parts = setCookie?.split(";").map((part) => part.trim()) ?? [];
  const pair = parts[0];
  const attributes = new Map(parts.slice(1).map((part) => {
    const separator = part.indexOf("=");
    return separator < 0
      ? [part.toLowerCase(), ""]
      : [part.slice(0, separator).toLowerCase(), part.slice(separator + 1)];
  }));
  if (
    pair !== `recording_playback_access=${capability}` ||
    !attributes.has("httponly") ||
    !attributes.has("secure") ||
    attributes.get("samesite")?.toLowerCase() !== "strict" ||
    attributes.get("path") !== `/recordings/s/${sessionId}` ||
    attributes.get("max-age") !== "604800" ||
    attributes.has("domain")
  ) {
    throw new Error("Recording playback session did not return a secure scoped cookie");
  }
  return pair;
}

function assertNoCapabilityRetained(evidence: RecordingPlaybackEvidenceV1, capability: string): void {
  if (JSON.stringify(evidence).includes(capability)) {
    throw new Error("Recording playback capability escaped into retained evidence");
  }
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
