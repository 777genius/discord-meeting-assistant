import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCraigHttpServer } from "../src/craig-http-server.js";

const token = "test-craig-bearer-token";
const servers: ReturnType<typeof createCraigHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }),
  );
});

async function startServer(
  overrides: {
    readonly installUrls?: { readonly craig: string; readonly meetingPlatform: string };
    readonly lifecycleError?: Error;
    readonly onInternalError?: (error: unknown) => void;
    readonly ready?: boolean;
  } = {},
) {
  const ingestLifecycle = vi.fn(async () => {});
  if (overrides.lifecycleError !== undefined) {
    ingestLifecycle.mockRejectedValue(overrides.lifecycleError);
  }
  const ingestVoiceBatch = vi.fn(async () => {});
  const ingestAuthoritativeTrack = vi.fn(async () => ({ replayed: false }));
  const server = createCraigHttpServer({
    bearerToken: token,
    health: {
      metrics: () => "meeting_ingress_accepted_total 1\n",
      readiness: async () => ({ ready: overrides.ready ?? true }),
    },
    ingress: { ingestAuthoritativeTrack, ingestLifecycle, ingestVoiceBatch },
    ...(overrides.installUrls === undefined ? {} : { installUrls: overrides.installUrls }),
    ...(overrides.onInternalError === undefined
      ? {}
      : { onInternalError: overrides.onInternalError }),
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    ingestLifecycle,
    ingestAuthoritativeTrack,
    ingestVoiceBatch,
  };
}

describe("Craig HTTP ingress", () => {
  it("redirects both explicit bot installation steps without OAuth token custody", async () => {
    const context = await startServer({
      installUrls: {
        craig: "https://discord.com/oauth2/authorize?client_id=22222222222222222",
        meetingPlatform: "https://discord.com/oauth2/authorize?client_id=11111111111111111",
      },
    });
    const platform = await fetch(`${context.baseUrl}/discord/install`, { redirect: "manual" });
    const craig = await fetch(`${context.baseUrl}/discord/install/craig`, { redirect: "manual" });
    expect(platform.status).toBe(302);
    expect(platform.headers.get("location")).toContain("11111111111111111");
    expect(craig.status).toBe(302);
    expect(craig.headers.get("location")).toContain("22222222222222222");
  });

  it("streams a bounded checksummed authoritative Craig track", async () => {
    const context = await startServer();
    const body = Buffer.from("OggS-authoritative-test", "utf8");
    const metadata = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        uploadId: "recording-1:track:1",
        recordingId: "recording-1",
        guildId: "1533224474609057793",
        channelId: "1533224474609057794",
        speakerId: "1533224474609057795",
        trackNumber: 1,
        timelineOffsetMs: 0,
        checksumSha256: "a".repeat(64),
        sizeBytes: body.byteLength,
      }),
      "utf8",
    ).toString("base64url");
    const response = await fetch(`${context.baseUrl}/v1/craig/authoritative-tracks`, {
      body,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "audio/ogg",
        "x-craig-authoritative-track-metadata": metadata,
      },
      method: "POST",
    });

    expect(response.status).toBe(201);
    expect(context.ingestAuthoritativeTrack).toHaveBeenCalledOnce();
  });

  it("authenticates and accepts a strict lifecycle event", async () => {
    const context = await startServer();
    const response = await fetch(`${context.baseUrl}/v1/craig/events`, {
      body: JSON.stringify({
        schemaVersion: 1,
        eventId: "recording-1:1",
        recordingId: "recording-1",
        guildId: "1533228590643155034",
        channelId: "1533228823045214398",
        occurredAt: "2026-08-02T00:00:00.000Z",
        type: "meeting.started",
        participantIds: ["1533227577286852649"],
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(202);
    expect(context.ingestLifecycle).toHaveBeenCalledOnce();
  });

  it("rejects unauthenticated packets before parsing their body", async () => {
    const context = await startServer();
    const response = await fetch(`${context.baseUrl}/v1/craig/voice-packets`, {
      body: "not-json",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(context.ingestVoiceBatch).not.toHaveBeenCalled();
  });

  it("reports the internal error while keeping response details private", async () => {
    const cause = new Error("private filesystem detail");
    const onInternalError = vi.fn();
    const context = await startServer({ lifecycleError: cause, onInternalError });
    const response = await fetch(`${context.baseUrl}/v1/craig/events`, {
      body: JSON.stringify({
        schemaVersion: 1,
        eventId: "recording-1:1",
        recordingId: "recording-1",
        guildId: "1533228590643155034",
        channelId: "1533228823045214398",
        occurredAt: "2026-08-02T00:00:00.000Z",
        type: "meeting.started",
        participantIds: ["1533227577286852649"],
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect(onInternalError).toHaveBeenCalledWith(cause);
  });

  it("fails closed on unknown contract fields", async () => {
    const context = await startServer();
    const response = await fetch(`${context.baseUrl}/v1/craig/voice-packets`, {
      body: JSON.stringify({
        schemaVersion: 1,
        packets: [
          {
            schemaVersion: 1,
            recordingId: "recording-1",
            guildId: "1533228590643155034",
            channelId: "1533228823045214398",
            speakerId: "1533227577286852649",
            rtpTimestamp: 42,
            rtpSequence: 7,
            receivedAtMs: 1_000,
            relativeTimeMs: 20,
            opusBase64: "AQID",
            accessKey: "forbidden",
          },
        ],
      }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(context.ingestVoiceBatch).not.toHaveBeenCalled();
  });

  it("exposes no readiness details and protects metrics", async () => {
    const context = await startServer({ ready: false });
    const readiness = await fetch(`${context.baseUrl}/readyz`);
    const unauthenticatedMetrics = await fetch(`${context.baseUrl}/metrics`);
    const metrics = await fetch(`${context.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({ status: "not_ready" });
    expect(unauthenticatedMetrics.status).toBe(401);
    expect(await metrics.text()).toContain("meeting_ingress_accepted_total");
  });
});
