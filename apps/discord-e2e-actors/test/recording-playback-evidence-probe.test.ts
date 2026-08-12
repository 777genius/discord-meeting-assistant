import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HttpRecordingPlaybackEvidenceProbe } from "../src/recording-playback-evidence-probe.js";

const recordingId = "recording-1";
const capability =
  `v1.${Buffer.from(recordingId).toString("base64url")}.${"s".repeat(43)}`;
const playbackUrl = `https://recordings.example.test/recordings/playback#${capability}`;
const trackBytes = Buffer.from("authoritative speaker track", "utf8");
const trackChecksum = createHash("sha256").update(trackBytes).digest("hex");

describe("HttpRecordingPlaybackEvidenceProbe", () => {
  it("proves unavailable to ready, cookie resume, Range bytes, and retains no capability", async () => {
    const http = fakePlaybackHttp(["unavailable", "processing", "ready"]);
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    const evidence = await probe.collect(input("transition"));

    expect(evidence).toEqual({
      capabilitySha256: createHash("sha256").update(capability).digest("hex"),
      link: {
        origin: "https://recordings.example.test",
        pathname: "/recordings/playback",
      },
      manifest: {
        readinessExpectation: "transition",
        recordingId,
        statuses: ["unavailable", "processing", "ready"],
      },
      resume: {
        manifestStatus: "ready",
        recordingId,
        statusCode: 200,
      },
      tracks: [{
        checksumSha256: trackChecksum,
        contentLength: trackBytes.length,
        contentRange: `bytes 0-${trackBytes.length - 1}/${trackBytes.length}`,
        index: 0,
        statusCode: 206,
      }],
    });
    expect(JSON.stringify(evidence)).not.toContain(capability);
    expect(http.requests.filter(({ kind }) => kind === "resume")).toHaveLength(3);
    expect(http.requests.at(-1)).toMatchObject({
      cookie: `recording_playback_access=${capability}`,
      kind: "track",
      range: `bytes=0-${trackBytes.length - 1}`,
    });
  });

  it.each([
    `http://recordings.example.test/recordings/playback#${capability}`,
    `https://recordings.example.test/not-playback#${capability}`,
    `https://recordings.example.test/recordings/playback?leak=true#${capability}`,
    `https://recordings.attacker.test/recordings/playback#${capability}`,
    "https://recordings.example.test/recordings/playback#short",
  ])("rejects false playback URL %s before HTTP", async (recordingPlaybackUrl) => {
    const http = fakePlaybackHttp(["ready"]);
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect({
      ...input("already-ready"),
      recordingPlaybackUrl,
    })).rejects.toThrow("valid possession URL");
    expect(http.requests).toEqual([]);
  });

  it("rejects a manifest bound to another meeting", async () => {
    const http = fakePlaybackHttp(["ready"], { recordingId: "recording-2" });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow(
      "different recording",
    );
  });

  it("accepts case-insensitive cookie names while preserving a mixed-case session path", async () => {
    const sessionId = "Aa".repeat(16);
    const http = fakePlaybackHttp(["ready"], { sessionId });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect(input("already-ready"))).resolves.toBeDefined();
  });

  it("rejects a session cookie that expires immediately", async () => {
    const http = fakePlaybackHttp(["ready"], { cookieMaxAge: "0" });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow("secure scoped cookie");
  });

  it("rejects a cookie path whose session ID differs only by case", async () => {
    const sessionId = "Aa".repeat(16);
    const http = fakePlaybackHttp(["ready"], {
      cookiePathSessionId: sessionId.toLowerCase(),
      sessionId,
    });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      maximumTransientFailures: 1,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow("secure scoped cookie");
  });

  it("rejects an oversized manifest body safely", async () => {
    const http = fakePlaybackHttp(["ready"], { oversizedManifest: true });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      maximumTransientFailures: 1,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow("size bound");
  });

  it("accepts eleven tracks and rejects expectations above the project bound", async () => {
    const eleven = Array.from({ length: 11 }, () => ({
      checksumSha256: trackChecksum,
      sizeBytes: trackBytes.length,
    }));
    const acceptedHttp = fakePlaybackHttp(["ready"], { manifestTrackCount: 11 });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: acceptedHttp.fetch,
    });

    await expect(probe.collect({
      ...input("already-ready"),
      expectedTracks: eleven,
    })).resolves.toMatchObject({ tracks: { length: 11 } });

    const tooMany = [...eleven, eleven[0]!];
    await expect(new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: fakePlaybackHttp(["ready"]).fetch,
    }).collect({
      ...input("already-ready"),
      expectedTracks: tooMany,
    })).rejects.toThrow("1-11 expected tracks");
  });

  it("rejects playback bytes with the wrong authoritative checksum", async () => {
    const tampered = Buffer.from(trackBytes);
    tampered[0] = tampered[0]! ^ 0xff;
    const http = fakePlaybackHttp(["ready"], { trackBytes: tampered });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow(
      "checksum differs",
    );
  });

  it("rejects a wrong checksum on the second authoritative track", async () => {
    const secondBytes = Buffer.from("second authoritative track", "utf8");
    const http = fakePlaybackHttp(["ready"], { secondTrackBytes: secondBytes });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect({
      ...input("already-ready"),
      expectedTracks: [
        { checksumSha256: trackChecksum, sizeBytes: trackBytes.length },
        { checksumSha256: "0".repeat(64), sizeBytes: secondBytes.length },
      ],
    })).rejects.toThrow("checksum differs");
    expect(http.requests.filter(({ kind }) => kind === "track")).toHaveLength(2);
  });

  it("bounds an unavailable recording instead of claiming readiness", async () => {
    const http = fakePlaybackHttp(["unavailable", "unavailable"]);
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      maximumProcessingAttempts: 2,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    await expect(probe.collect(input("transition"))).rejects.toThrow(
      "did not become ready",
    );
    expect(http.requests).toHaveLength(2);
  });

  it("keeps the default polling budget bounded with a zero test delay", async () => {
    const http = fakePlaybackHttp(["unavailable"]);
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    await expect(probe.collect(input("transition"))).rejects.toThrow(
      "did not become ready",
    );
    expect(http.requests).toHaveLength(361);
  });

  it("does not consume the processing budget on consecutive transient failures", async () => {
    const http = fakePlaybackHttp(["processing", "ready"], {
      exchangeStatuses: [503, 503, 200, 200],
    });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      maximumProcessingAttempts: 2,
      maximumTransientFailures: 3,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    const evidence = await probe.collect(input("transition"));

    expect(evidence.manifest.statuses).toEqual(["processing", "ready"]);
    expect(http.requests.filter(({ kind }) => kind === "exchange")).toHaveLength(3);
    expect(http.requests.filter(({ kind }) => kind === "resume")).toHaveLength(2);
  });

  it("bounds consecutive transient failures independently", async () => {
    const http = fakePlaybackHttp(["processing"], { exchangeStatuses: [503] });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      maximumProcessingAttempts: 10,
      maximumTransientFailures: 3,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    await expect(probe.collect(input("transition"))).rejects.toThrow("status 503");
    expect(http.requests).toHaveLength(3);
  });

  it("times out and cancels a stalled track body", async () => {
    const http = fakePlaybackHttp(["ready"], { stalledTrackBody: true });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      requestTimeoutMilliseconds: 10,
      trackRequestTimeoutMilliseconds: 20,
    });

    await expect(probe.collect(input("already-ready"))).rejects.toThrow("timed out");
    expect(http.trackBodyCancelled()).toBe(true);
  });

  it("allows a track body to outlive the shorter manifest timeout", async () => {
    const http = fakePlaybackHttp(["ready"], { trackBodyDelayMilliseconds: 30 });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      requestTimeoutMilliseconds: 10,
      trackRequestTimeoutMilliseconds: 100,
    });

    await expect(probe.collect(input("already-ready"))).resolves.toBeDefined();
  });

  it("requires an explicit transition instead of silently accepting already-ready", async () => {
    const http = fakePlaybackHttp(["ready"]);
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
    });

    await expect(probe.collect(input("transition"))).rejects.toThrow(
      "explicit transition readiness gate",
    );
  });
});

describe("HttpRecordingPlaybackEvidenceProbe transient response cleanup", () => {
  it("cancels a transient failure body before retrying", async () => {
    let cancelled = false;
    const http = fakePlaybackHttp(["ready"], {
      exchangeStatuses: [503, 200],
      failedExchangeBody: new ReadableStream({
        cancel: () => {
          cancelled = true;
        },
      }),
    });
    const probe = new HttpRecordingPlaybackEvidenceProbe({
      expectedOrigin: "https://recordings.example.test",
      fetch: http.fetch,
      retryDelayMilliseconds: 0,
      wait: async () => {},
    });

    await expect(probe.collect(input("already-ready"))).resolves.toBeDefined();
    expect(cancelled).toBe(true);
  });
});

function input(readinessExpectation: "already-ready" | "transition") {
  return {
    expectedRecordingId: recordingId,
    expectedTracks: [{ checksumSha256: trackChecksum, sizeBytes: trackBytes.length }],
    readinessExpectation,
    recordingPlaybackUrl: playbackUrl,
  } as const;
}

function fakePlaybackHttp(
  statuses: readonly ("processing" | "ready" | "unavailable")[],
  options: {
    readonly cookieMaxAge?: string;
    readonly exchangeStatuses?: readonly number[];
    readonly failedExchangeBody?: ReadableStream<Uint8Array>;
    readonly cookiePathSessionId?: string;
    readonly manifestTrackCount?: number;
    readonly oversizedManifest?: boolean;
    readonly recordingId?: string;
    readonly secondTrackBytes?: Buffer;
    readonly sessionId?: string;
    readonly stalledTrackBody?: boolean;
    readonly trackBodyDelayMilliseconds?: number;
    readonly trackBytes?: Buffer;
  } = {},
) {
  let exchange = 0;
  let exchangeRequest = 0;
  const requests: Array<{
    readonly cookie?: string;
    readonly kind: "exchange" | "resume" | "track";
    readonly range?: string;
  }> = [];
  const bytes = options.trackBytes ?? trackBytes;
  const observedRecordingId = options.recordingId ?? recordingId;
  const sessionId = options.sessionId ?? "s".repeat(32);
  let trackBodyCancelled = false;
  const trackResponse = (trackIndex: number, headers: Headers) => {
    const responseBytes = trackIndex === 1 ? options.secondTrackBytes ?? bytes : bytes;
    const cookie = headers.get("cookie") ?? undefined;
    const range = headers.get("range") ?? undefined;
    requests.push({
      ...(cookie === undefined ? {} : { cookie }),
      kind: "track",
      ...(range === undefined ? {} : { range }),
    });
    const body = options.stalledTrackBody === true
      ? new ReadableStream<Uint8Array>({
          cancel: () => {
            trackBodyCancelled = true;
          },
        })
      : options.trackBodyDelayMilliseconds === undefined
        ? responseBytes
        : new ReadableStream<Uint8Array>({
            start: (controller) => {
              setTimeout(() => {
                controller.enqueue(responseBytes);
                controller.close();
              }, options.trackBodyDelayMilliseconds);
            },
          });
    return new Response(body, {
      headers: {
        "content-length": String(responseBytes.length),
        "content-range": `bytes 0-${responseBytes.length - 1}/${responseBytes.length}`,
      },
      status: 206,
    });
  };
  const fakeFetch = async (requestInput: string | URL | Request, init?: RequestInit) => {
    const url = requestInput instanceof URL
      ? requestInput
      : new URL(typeof requestInput === "string" ? requestInput : requestInput.url);
    const headers = new Headers(init?.headers);
    if (
      url.pathname === "/recordings/session" ||
      url.pathname === `/recordings/s/${sessionId}/session`
    ) {
      const authorization = headers.get("authorization");
      const cookie = headers.get("cookie") ?? undefined;
      const kind = authorization === null ? "resume" : "exchange";
      requests.push({ ...(cookie === undefined ? {} : { cookie }), kind });
      if (kind === "resume" && cookie !== `recording_playback_access=${capability}`) {
        return new Response(null, { status: 404 });
      }
      const responseStatus = kind === "exchange"
        ? options.exchangeStatuses?.[
            Math.min(exchangeRequest, options.exchangeStatuses.length - 1)
          ] ?? 200
        : 200;
      if (kind === "exchange") {
        exchangeRequest += 1;
      }
      if (responseStatus < 200 || responseStatus >= 300) {
        return new Response(options.failedExchangeBody ?? null, { status: responseStatus });
      }
      const status = statuses[Math.min(exchange++, statuses.length - 1)] ?? "unavailable";
      if (options.oversizedManifest === true) {
        return new Response(`{"padding":"${"x".repeat(256 * 1024)}"}`, {
          headers: kind === "exchange" ? { "set-cookie": secureCookie() } : {},
        });
      }
      const trackCount = options.manifestTrackCount ??
        (options.secondTrackBytes === undefined ? 1 : 2);
      return Response.json({
        recordingId: observedRecordingId,
        schemaVersion: 1,
        sessionId,
        status,
        tracks: status === "ready"
          ? Array.from({ length: trackCount }, (_, index) => ({
              timelineOffsetMs: index * 250,
              url: `/recordings/s/${sessionId}/tracks/${index}`,
            }))
          : [],
      }, kind === "exchange"
        ? {
            headers: { "set-cookie": secureCookie() },
          }
        : {});
    }
    const trackMatch = url.pathname.match(new RegExp(
      `^/recordings/s/${sessionId}/tracks/(\\d+)$`,
      "u",
    ));
    if (trackMatch !== null) {
      return trackResponse(Number(trackMatch[1]), headers);
    }
    return new Response(null, { status: 404 });
  };
  function secureCookie(): string {
    return [
      `recording_playback_access=${capability}`,
      `pAtH=/recordings/s/${options.cookiePathSessionId ?? sessionId}`,
      `mAx-AgE=${options.cookieMaxAge ?? "604800"}`,
      "HttpOnly",
      "sAmEsItE=Strict",
      "Secure",
    ].join("; ");
  }
  return { fetch: fakeFetch, requests, trackBodyCancelled: () => trackBodyCancelled };
}
