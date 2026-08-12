import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HttpLiveDiscordPlaybackReadinessProbe } from "../src/live-discord-playback-readiness-probe.js";

const origin = "https://recordings.example.test";
const capability = "fixture-capability";
const sessionId = "a".repeat(32);

describe("immediate recording playback readiness probe", () => {
  it("retains a sanitized proof for the exact ready recording with nonempty tracks", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch({
      recordingId: "recording-42", schemaVersion: 1, sessionId, status: "ready",
      tracks: [{ timelineOffsetMs: 0, url: `/recordings/s/${sessionId}/tracks/0` }],
    }) });

    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).resolves.toEqual({
      capabilitySha256: createHash("sha256").update(capability).digest("hex"),
      messageId: "message-42", recordingId: "recording-42", status: "ready", trackCount: 1,
    });
  });

  it.each(["processing", "unavailable"] as const)(
    "rejects a visible link while the exact recording is %s",
    async (status) => {
      const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch({
        recordingId: "recording-42", schemaVersion: 1, sessionId, status, tracks: [],
      }) });
      await expect(probe.prove({
        messageId: "message-42", recordingId: "recording-42",
        recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
      })).rejects.toThrow("visible before its exact recording was ready");
    },
  );

  it("rejects a ready manifest for another recording", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch({
      recordingId: "other-recording", schemaVersion: 1, sessionId, status: "ready",
      tracks: [{ timelineOffsetMs: 0, url: `/recordings/s/${sessionId}/tracks/0` }],
    }) });
    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).rejects.toThrow("visible before its exact recording was ready");
  });

  it("rejects a ready manifest without tracks", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch({
      recordingId: "recording-42", schemaVersion: 1, sessionId, status: "ready", tracks: [],
    }) });
    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).rejects.toThrow("visible before its exact recording was ready");
  });
});

function fakeFetch(manifest: unknown): typeof fetch {
  return (_input, init) => {
    expect(init).toMatchObject({
      headers: { authorization: `Bearer ${capability}` }, method: "POST",
    });
    return Promise.resolve(new Response(JSON.stringify(manifest), {
      headers: { "content-type": "application/json" }, status: 200,
    }));
  };
}
