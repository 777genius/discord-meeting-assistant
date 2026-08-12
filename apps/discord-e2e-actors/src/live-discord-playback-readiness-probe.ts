import { createHash } from "node:crypto";

import { playbackManifestSchema } from "./recording-playback-evidence-probe-policy.js";
import type {
  LiveDiscordPlaybackReadinessProbe,
  LiveDiscordPlaybackReadinessProof,
} from "./live-discord-playback-link-observer.js";

const maximumManifestBytes = 256 * 1024;

export class HttpLiveDiscordPlaybackReadinessProbe implements LiveDiscordPlaybackReadinessProbe {
  readonly #expectedOrigin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMilliseconds: number;

  public constructor(options: {
    readonly expectedOrigin: string;
    readonly fetch?: typeof fetch;
    readonly timeoutMilliseconds?: number;
  }) {
    this.#expectedOrigin = parseHttpsOrigin(options.expectedOrigin);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? 15_000;
  }

  public async prove(input: {
    readonly messageId: string;
    readonly recordingId: string;
    readonly recordingPlaybackUrl: string;
  }): Promise<LiveDiscordPlaybackReadinessProof> {
    const link = parsePlaybackLink(input.recordingPlaybackUrl, this.#expectedOrigin);
    const capability = link.hash.slice(1);
    const response = await this.#fetch(new URL("/recordings/session", link.origin), {
      headers: { authorization: `Bearer ${capability}` },
      method: "POST",
      signal: AbortSignal.timeout(this.#timeoutMilliseconds),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`Recording playback readiness probe failed with status ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maximumManifestBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Recording playback readiness manifest exceeds 256 KiB");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumManifestBytes) {
      throw new Error("Recording playback readiness manifest exceeds 256 KiB");
    }
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new Error("Recording playback readiness probe returned invalid JSON");
    }
    const manifest = playbackManifestSchema.parse(raw);
    if (
      manifest.recordingId !== input.recordingId ||
      manifest.status !== "ready" || manifest.tracks.length === 0
    ) {
      throw new Error("Recording playback link was visible before its exact recording was ready");
    }
    return Object.freeze({
      capabilitySha256: createHash("sha256").update(capability, "utf8").digest("hex"),
      messageId: input.messageId,
      recordingId: manifest.recordingId,
      status: "ready" as const,
      trackCount: manifest.tracks.length,
    });
  }
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
