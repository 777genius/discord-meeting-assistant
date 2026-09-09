import { afterEach, describe, expect, it } from "vitest";

import { createFastifyPlatformHttpHost } from "../src/http/fastify-platform-http-host.js";
import {
  GetRecordingPlayback,
  type RecordingPlaybackAudioReader,
  type RecordingPlaybackCatalog,
} from "../src/recording-playback/application/recording-playback.js";
import { HmacRecordingPlaybackAccess } from "../src/recording-playback/adapters/hmac-recording-playback-access.js";
import { createRecordingPlaybackRoutesPlugin } from "../src/recording-playback/adapters/recording-playback-routes.js";

const hosts: ReturnType<typeof createFastifyPlatformHttpHost>[] = [];
const secret = "a-secure-recording-playback-secret-with-more-than-32-bytes";

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
});

function createContext(
  status: "processing" | "ready" | "unavailable" = "ready",
  secureCookies = false,
) {
  const access = new HmacRecordingPlaybackAccess({
    publicBaseUrl: "http://recordings.example.test",
    secret,
  });
  const catalog: RecordingPlaybackCatalog = {
    findByMeetingId: async () => ({
      status,
      tracks: status === "ready"
        ? [{ artifactRevision: "v-a", audioLocator: "s3://meeting-artifacts/recordings/a.ogg", checksumSha256: "a".repeat(64), sizeBytes: 10, timelineOffsetMs: 725 }]
        : [],
    }),
  };
  const audio: RecordingPlaybackAudioReader = {
    describe: async () => ({ contentType: "audio/ogg", eTag: '"etag-1"', sizeBytes: 10 }),
    read: async ({ range }) => {
      const resolved = range === undefined
        ? undefined
        : "suffixLength" in range
          ? { end: 9, start: 10 - range.suffixLength }
          : { end: range.end ?? 9, start: range.start };
      const contentLength = resolved === undefined ? 10 : resolved.end - resolved.start + 1;
      return {
        body: (async function* () {
          yield Uint8Array.from(
            { length: contentLength },
            (_, index) => (resolved?.start ?? 0) + index,
          );
        })(),
        contentLength,
        contentType: "audio/ogg",
        eTag: '"etag-1"',
        ...(resolved === undefined ? {} : { range: resolved }),
        sizeBytes: 10,
      };
    },
  };
  const host = createFastifyPlatformHttpHost({
    bindAddress: "127.0.0.1",
    port: 0,
    routePlugins: [createRecordingPlaybackRoutesPlugin({
      access,
      playback: new GetRecordingPlayback(catalog, audio),
      secureCookies,
    })],
  });
  hosts.push(host);
  const token = new URL(access.issueUrl("meeting-1")).hash.slice(1);
  return { host, token };
}

async function openSession(context: ReturnType<typeof createContext>) {
  return context.host.inject({
    headers: { authorization: `Bearer ${context.token}` },
    method: "POST",
    url: "/recordings/session",
  });
}

function sessionCookie(
  response: Awaited<ReturnType<typeof openSession>>,
): string | undefined {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return value?.split(";", 1)[0];
}

describe("recording playback HTTP routes", () => {
  it("serves a generic no-store page without receiving the fragment secret", async () => {
    const context = createContext();

    const response = await context.host.inject({
      method: "GET",
      url: "/recordings/playback",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-security-policy"]).toContain("media-src 'self'");
    expect(response.body).toContain("Meeting recording");
    expect(response.body).not.toContain(context.token);
  }, 15_000);

  it("exchanges a bearer for a scoped cookie and a locator-free manifest", async () => {
    const context = createContext();

    const unauthenticated = await context.host.inject({
      method: "POST",
      url: "/recordings/session",
    });
    const response = await openSession(context);

    expect(unauthenticated.statusCode).toBe(404);
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
    expect(response.headers["set-cookie"]).not.toContain("Secure");
    const body = response.json<{
      readonly recordingId: string;
      readonly schemaVersion: number;
      readonly sessionId: string;
      readonly status: string;
      readonly tracks: readonly {
        readonly timelineOffsetMs: number;
        readonly url: string;
      }[];
    }>();
    expect(body.recordingId).toBe("meeting-1");
    expect(body.schemaVersion).toBe(1);
    expect(body.sessionId.length).toBeGreaterThan(0);
    expect(body.status).toBe("ready");
    expect(body.tracks).toHaveLength(1);
    expect(body.tracks[0]?.timelineOffsetMs).toBe(725);
    expect(body.tracks[0]?.url).toContain("/tracks/0");
    expect(response.body).not.toContain("s3://");
  });

  it("resumes a stripped-fragment session only with its scoped cookie", async () => {
    const context = createContext();
    const opened = await openSession(context);
    const body = opened.json<{
      readonly recordingId: string;
      readonly sessionId: string;
      readonly tracks: readonly { readonly url: string }[];
    }>();
    const cookie = sessionCookie(opened);
    if (cookie === undefined) {
      throw new Error("session fixture has no cookie");
    }
    const url = `/recordings/s/${body.sessionId}/session`;

    const resumed = await context.host.inject({
      headers: { cookie, "x-recording-playback-session": "resume" },
      method: "POST",
      url,
    });
    const withoutIntent = await context.host.inject({
      headers: { cookie },
      method: "POST",
      url,
    });
    const wrongSession = await context.host.inject({
      headers: { cookie, "x-recording-playback-session": "resume" },
      method: "POST",
      url: "/recordings/s/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/session",
    });
    const withoutCookie = await context.host.inject({
      headers: { "x-recording-playback-session": "resume" },
      method: "POST",
      url,
    });

    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      recordingId: "meeting-1",
      sessionId: body.sessionId,
      status: "ready",
      tracks: body.tracks,
    });
    expect(resumed.headers["cache-control"]).toBe("private, no-store");
    expect(resumed.headers["set-cookie"]).toBeUndefined();
    expect(resumed.body).not.toContain(context.token);
    expect(resumed.body).not.toContain("s3://");
    expect(withoutIntent.statusCode).toBe(404);
    expect(wrongSession.statusCode).toBe(404);
    expect(withoutCookie.statusCode).toBe(404);
  });

  it("marks the production playback cookie as secure", async () => {
    const response = await openSession(createContext("ready", true));

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("Secure");
  });

  it("streams partial audio with seek headers only for the scoped session", async () => {
    const context = createContext();
    const session = await openSession(context);
    const body = session.json<{
      readonly tracks: readonly { readonly url: string }[];
    }>();
    const cookie = sessionCookie(session);
    if (cookie === undefined || body.tracks[0] === undefined) {
      throw new Error("session fixture is incomplete");
    }

    const forbidden = await context.host.inject({
      method: "GET",
      url: body.tracks[0].url,
    });
    const response = await context.host.inject({
      headers: { cookie, range: "bytes=2-5" },
      method: "GET",
      url: body.tracks[0].url,
    });
    const suffix = await context.host.inject({
      headers: { cookie, range: "bytes=-4" },
      method: "GET",
      url: body.tracks[0].url,
    });
    const head = await context.host.inject({
      headers: { cookie },
      method: "HEAD",
      url: body.tracks[0].url,
    });

    expect(forbidden.statusCode).toBe(404);
    expect(response.statusCode).toBe(206);
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-range"]).toBe("bytes 2-5/10");
    expect(response.headers["content-length"]).toBe("4");
    expect(response.rawPayload).toEqual(Buffer.from([2, 3, 4, 5]));
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe("bytes 6-9/10");
    expect(suffix.headers["content-length"]).toBe("4");
    expect(suffix.rawPayload).toEqual(Buffer.from([6, 7, 8, 9]));
    expect(head.statusCode).toBe(200);
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.headers["content-length"]).toBe("10");
    expect(head.headers["content-type"]).toContain("audio/ogg");
    expect(head.headers.etag).toBe('"etag-1"');
    expect(head.body).toBe("");
  });

  it("returns processing without track URLs and rejects multi-range requests", async () => {
    const processing = createContext("processing");
    const pendingSession = await openSession(processing);
    expect(pendingSession.json()).toMatchObject({ status: "processing", tracks: [] });

    const ready = createContext();
    const session = await openSession(ready);
    const trackUrl = session.json<{ tracks: { url: string }[] }>().tracks[0]?.url;
    const cookie = sessionCookie(session);
    if (trackUrl === undefined || cookie === undefined) {
      throw new Error("session fixture is incomplete");
    }
    const invalid = await ready.host.inject({
      headers: { cookie, range: "bytes=0-1,4-5" },
      method: "GET",
      url: trackUrl,
    });

    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers["content-range"]).toBe("bytes */10");
  });
});
