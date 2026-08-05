import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCraigInboundRoutesPlugin,
  maximumCraigJsonBodyBytes,
  type CraigIngressPort,
} from "../src/adapters/inbound/craig/craig-inbound-routes.js";
import { MeetingPublicationTargetUnavailableError } from "../src/application/platform-ingress.js";
import {
  RecordingIngressRejectedError,
  type AuthoritativeSpeakerTrackUpload,
} from "../src/application/recording-ingress.js";
import { createDiscordInstallRoutesPlugin } from "../src/discord-install-http/discord-install-routes.js";
import {
  createFastifyPlatformHttpHost,
  type FastifyPlatformHttpHost,
} from "../src/http/fastify-platform-http-host.js";
import { createOperationsRoutesPlugin } from "../src/operations-http/operations-routes.js";

const token = "test-craig-bearer-token";
const hosts: FastifyPlatformHttpHost[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map(async (host) => host.close()));
});

function createHost(
  overrides: {
    readonly activeGuildVoiceChannels?: readonly {
      readonly guildId: string;
      readonly voiceChannelId: string;
    }[];
    readonly configurationError?: Error;
    readonly ingress?: CraigIngressPort;
    readonly installUrls?: { readonly craig: string; readonly meetingPlatform: string };
    readonly onInternalError?: (error: unknown) => void;
    readonly ready?: boolean;
  } = {},
) {
  const fallbackIngress = createIngress();
  const ingress = overrides.ingress ?? fallbackIngress.port;
  const listActiveGuildVoiceChannels = vi.fn(async () => {
    if (overrides.configurationError !== undefined) {
      throw overrides.configurationError;
    }
    return overrides.activeGuildVoiceChannels ?? [];
  });
  const host = createFastifyPlatformHttpHost({
    bindAddress: "127.0.0.1",
    port: 0,
    ...(overrides.onInternalError === undefined
      ? {}
      : { onInternalError: overrides.onInternalError }),
    routePlugins: [
      createOperationsRoutesPlugin({
        bearerToken: token,
        health: {
          metrics: () => "meeting_ingress_accepted_total 1\n",
          readiness: async () => ({ ready: overrides.ready ?? true }),
        },
      }),
      createDiscordInstallRoutesPlugin(
        overrides.installUrls === undefined
          ? {}
          : { installUrls: overrides.installUrls },
      ),
      createCraigInboundRoutesPlugin({
        bearerToken: token,
        configuration: { listActiveGuildVoiceChannels },
        ingress,
      }),
    ],
  });
  hosts.push(host);
  return { host, listActiveGuildVoiceChannels };
}

function createIngress() {
  const ingestAuthoritativeTrack = vi.fn(async () => ({ replayed: false }));
  const ingestLifecycle = vi.fn(async () => {});
  const ingestVoiceBatch = vi.fn(async () => {});
  return {
    ingestAuthoritativeTrack,
    ingestLifecycle,
    ingestVoiceBatch,
    port: { ingestAuthoritativeTrack, ingestLifecycle, ingestVoiceBatch } satisfies CraigIngressPort,
  };
}

describe("Fastify platform HTTP host", () => {
  it("mounts an additional native Fastify route without changing the host", async () => {
    const host = createFastifyPlatformHttpHost({
      bindAddress: "127.0.0.1",
      port: 0,
      routePlugins: [
        (app, _options, done) => {
          app.get("/v1/extension", async () => ({ status: "mounted" }));
          done();
        },
      ],
    });
    hosts.push(host);

    const response = await host.inject({ method: "GET", url: "/v1/extension" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "mounted" });
  }, 15_000);

  it("keeps operations, installation redirects, and Craig configuration routes separate", async () => {
    const context = createHost({
      activeGuildVoiceChannels: [
        { guildId: "33333333333333333", voiceChannelId: "88888888888888888" },
        { guildId: "11111111111111111", voiceChannelId: "99999999999999999" },
      ],
      installUrls: {
        craig: "https://discord.com/oauth2/authorize?client_id=22222222222222222",
        meetingPlatform: "https://discord.com/oauth2/authorize?client_id=11111111111111111",
      },
      ready: false,
    });

    // The first inject lazily prepares Fastify. Keep that initialization
    // serialized so this boundary test does not race several readiness calls.
    const live = await context.host.inject({ method: "GET", url: "/livez" });
    const ready = await context.host.inject({ method: "GET", url: "/readyz" });
    const metrics = await context.host.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/metrics",
    });
    const unauthenticatedMetrics = await context.host.inject({
      method: "GET",
      url: "/metrics",
    });
    const configuration = await context.host.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/v1/craig/configuration",
    });
    const platformInstall = await context.host.inject({
      method: "GET",
      url: "/discord/install",
    });
    const craigInstall = await context.host.inject({
      method: "GET",
      url: "/discord/install/craig",
    });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: "live" });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.headers["content-type"]).toContain("text/plain; version=0.0.4");
    expect(metrics.body).toContain("meeting_ingress_accepted_total");
    expect(unauthenticatedMetrics.statusCode).toBe(401);
    expect(configuration.statusCode).toBe(200);
    expect(configuration.json()).toEqual({
      channels: [
        { guildId: "11111111111111111", voiceChannelId: "99999999999999999" },
        { guildId: "33333333333333333", voiceChannelId: "88888888888888888" },
      ],
      schemaVersion: 1,
    });
    expect(platformInstall.statusCode).toBe(302);
    expect(platformInstall.headers.location).toContain("11111111111111111");
    expect(craigInstall.statusCode).toBe(302);
    expect(craigInstall.headers.location).toContain("22222222222222222");
  });

  it("rejects unauthenticated Craig payloads before dispatch", async () => {
    const ingress = createIngress();
    const context = createHost({ ingress: ingress.port });

    const response = await context.host.inject({
      headers: { "content-type": "application/json" },
      method: "POST",
      payload: "not-json",
      url: "/v1/craig/voice-packets",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "UNAUTHORIZED" });
    expect(ingress.ingestVoiceBatch).not.toHaveBeenCalled();
  });

  it("parses Craig lifecycle and voice packet contracts only inside the inbound adapter", async () => {
    const ingress = createIngress();
    const context = createHost({ ingress: ingress.port });

    const [event, voicePackets] = await Promise.all([
      context.host.inject({
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        payload: JSON.stringify({
          channelId: "1533228823045214398",
          eventId: "recording-1:1",
          guildId: "1533228590643155034",
          occurredAt: "2026-08-02T00:00:00.000Z",
          participantIds: ["1533227577286852649"],
          recordingId: "recording-1",
          schemaVersion: 1,
          type: "meeting.started",
        }),
        url: "/v1/craig/events",
      }),
      context.host.inject({
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        payload: JSON.stringify({
          packets: [
            {
              channelId: "1533228823045214398",
              guildId: "1533228590643155034",
              opusBase64: "AQID",
              receivedAtMs: 1_000,
              recordingId: "recording-1",
              relativeTimeMs: 20,
              rtpSequence: 7,
              rtpTimestamp: 42,
              schemaVersion: 1,
              speakerId: "1533227577286852649",
            },
          ],
          schemaVersion: 1,
        }),
        url: "/v1/craig/voice-packets",
      }),
    ]);

    expect(event.statusCode).toBe(202);
    expect(voicePackets.statusCode).toBe(202);
    expect(ingress.ingestLifecycle).toHaveBeenCalledWith({
      eventId: "recording-1:1",
      occurredAt: "2026-08-02T00:00:00.000Z",
      participantIds: ["1533227577286852649"],
      recordingId: "recording-1",
      schemaVersion: 1,
      source: {
        roomId: "1533228823045214398",
        scopeId: "1533228590643155034",
      },
      type: "meeting.started",
    });
    expect(ingress.ingestVoiceBatch).toHaveBeenCalledWith({
      format: { channelCount: 1, codec: "opus", sampleRateHz: 48_000 },
      packets: [
        {
          mediaTimestamp: 42,
          payloadBase64: "AQID",
          receivedAtMs: 1_000,
          recordingId: "recording-1",
          relativeTimeMs: 20,
          schemaVersion: 1,
          sequenceNumber: 7,
          source: {
            roomId: "1533228823045214398",
            scopeId: "1533228590643155034",
          },
          speakerId: "1533227577286852649",
        },
      ],
      schemaVersion: 1,
    });
  });
});

describe("Fastify Craig ingress safeguards", () => {
  it("returns 413 for an oversized chunked JSON body without destroying the response", async () => {
    const context = createHost();

    const response = await context.host.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
      method: "POST",
      payload: `{"padding":"${"x".repeat(maximumCraigJsonBodyBytes)}"}`,
      url: "/v1/craig/voice-packets",
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toEqual({ code: "BODY_TOO_LARGE" });
  });

  it("keeps internal failures private while reporting them to the composition logger", async () => {
    const privateFailure = new Error("private database detail");
    const onInternalError = vi.fn();
    const context = createHost({
      configurationError: privateFailure,
      onInternalError,
    });

    const response = await context.host.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/v1/craig/configuration",
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(response.body).not.toContain("private database detail");
    expect(onInternalError).toHaveBeenCalledWith(privateFailure);
  });

  it("maps an application-owned unconfigured guild failure to a safe Craig response", async () => {
    const unavailableGuild = new MeetingPublicationTargetUnavailableError(
      "1533228590643155034",
      "1533228823045214398",
    );
    const ingress = createIngress();
    ingress.ingestLifecycle.mockRejectedValueOnce(unavailableGuild);
    const context = createHost({
      ingress: ingress.port,
    });

    const response = await context.host.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
      payload: JSON.stringify({
        channelId: "1533228823045214398",
        eventId: "recording-1:1",
        guildId: "1533228590643155034",
        occurredAt: "2026-08-02T00:00:00.000Z",
        participantIds: ["1533227577286852649"],
        recordingId: "recording-1",
        schemaVersion: 1,
        type: "meeting.started",
      }),
      url: "/v1/craig/events",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ code: "GUILD_NOT_CONFIGURED" });
  });

  it.each([
    ["invalid-request", 400, "INVALID_INGRESS_STATE"],
    ["conflict", 409, "INGRESS_CONFLICT"],
    ["limit-exceeded", 413, "INGRESS_LIMIT_EXCEEDED"],
  ] as const)(
    "maps application ingress rejection %s without concrete adapter knowledge",
    async (rejection, statusCode, code) => {
      const ingress = createIngress();
      ingress.ingestLifecycle.mockRejectedValueOnce(
        new RecordingIngressRejectedError(rejection),
      );
      const context = createHost({ ingress: ingress.port });

      const response = await context.host.inject({
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        payload: JSON.stringify({
          channelId: "1533228823045214398",
          eventId: "recording-1:1",
          guildId: "1533228590643155034",
          occurredAt: "2026-08-02T00:00:00.000Z",
          participantIds: ["1533227577286852649"],
          recordingId: "recording-1",
          schemaVersion: 1,
          type: "meeting.started",
        }),
        url: "/v1/craig/events",
      });

      expect(response.statusCode).toBe(statusCode);
      expect(response.json()).toEqual({ code });
    },
  );

  it("streams authoritative OGG data through the Craig ingress adapter", async () => {
    const received: Uint8Array[] = [];
    const ingestAuthoritativeTrack = vi.fn(
      async (_metadata: AuthoritativeSpeakerTrackUpload, body: AsyncIterable<Uint8Array>) => {
        for await (const chunk of body) {
          received.push(chunk);
        }
        return { replayed: false };
      },
    );
    const ingress: CraigIngressPort = {
      ingestAuthoritativeTrack,
      ingestLifecycle: vi.fn(async () => {}),
      ingestVoiceBatch: vi.fn(async () => {}),
    };
    const context = createHost({ ingress });
    const body = Buffer.from("OggS-authoritative-test", "utf8");

    const response = await context.host.inject({
      headers: {
        authorization: `Bearer ${token}`,
        "content-length": String(body.byteLength),
        "content-type": "audio/ogg",
        "x-craig-authoritative-track-metadata": authoritativeTrackMetadata(body.byteLength),
      },
      method: "POST",
      payload: body,
      url: "/v1/craig/authoritative-tracks",
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ status: "accepted" });
    expect(Buffer.concat(received)).toEqual(body);
    expect(ingestAuthoritativeTrack).toHaveBeenCalledOnce();
  });

  it("enforces the authoritative-track bearer, media type, and declared-size ACL", async () => {
    const ingress = createIngress();
    const context = createHost({ ingress: ingress.port });

    const [unauthenticated, wrongMediaType, wrongLength] = await Promise.all([
      context.host.inject({
        headers: {
          "content-length": "1",
          "content-type": "audio/ogg",
          "x-craig-authoritative-track-metadata": authoritativeTrackMetadata(1),
        },
        method: "POST",
        payload: "x",
        url: "/v1/craig/authoritative-tracks",
      }),
      context.host.inject({
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": "1",
          "content-type": "application/json",
          "x-craig-authoritative-track-metadata": authoritativeTrackMetadata(1),
        },
        method: "POST",
        payload: "x",
        url: "/v1/craig/authoritative-tracks",
      }),
      context.host.inject({
        headers: {
          authorization: `Bearer ${token}`,
          "content-length": "1",
          "content-type": "audio/ogg",
          "x-craig-authoritative-track-metadata": authoritativeTrackMetadata(2),
        },
        method: "POST",
        payload: "x",
        url: "/v1/craig/authoritative-tracks",
      }),
    ]);

    expect(unauthenticated.statusCode).toBe(401);
    expect(wrongMediaType.statusCode).toBe(415);
    expect(wrongLength.statusCode).toBe(400);
    expect(ingress.ingestAuthoritativeTrack).not.toHaveBeenCalled();
  });
});

function authoritativeTrackMetadata(sizeBytes: number): string {
  return Buffer.from(
    JSON.stringify({
      channelId: "1533224474609057794",
      checksumSha256: "a".repeat(64),
      guildId: "1533224474609057793",
      recordingId: "recording-1",
      schemaVersion: 1,
      sizeBytes,
      speakerId: "1533224474609057795",
      timelineOffsetMs: 0,
      trackNumber: 1,
      uploadId: "recording-1:track:1",
    }),
    "utf8",
  ).toString("base64url");
}
