import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { HttpLiveDiscordPlaybackReadinessProbe } from "../src/live-discord-playback-readiness-probe.js";

const origin = "https://recordings.example.test";
const capability = "fixture-capability";
const sessionId = "a".repeat(32);

describe("live recording playback readiness probe", () => {
  it("proves the visible processing link remains valid through ready", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch([
      { recordingId: "recording-42", schemaVersion: 1, sessionId, status: "processing", tracks: [] },
      { recordingId: "recording-42", schemaVersion: 1, sessionId, status: "ready",
        tracks: [{ timelineOffsetMs: 0, url: `/recordings/s/${sessionId}/tracks/0` }] },
    ]), retryDelayMilliseconds: 1, wait: async () => {} });

    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).resolves.toEqual({
      capabilitySha256: createHash("sha256").update(capability).digest("hex"),
      messageId: "message-42", readinessExpectation: "processing-to-ready",
      recordingId: "recording-42", status: "ready", statuses: ["processing", "ready"], trackCount: 1,
    });
  });

  it.each(["processing", "unavailable"] as const)(
    "rejects a visible link while the exact recording is %s",
    async (status) => {
      const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch([{
        recordingId: "recording-42", schemaVersion: 1, sessionId, status, tracks: [],
      }]), maximumProcessingAttempts: 1 });
      await expect(probe.prove({
        messageId: "message-42", recordingId: "recording-42",
        recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
      })).rejects.toThrow(status === "unavailable" ? "broken when first visible" : "did not become ready");
    },
  );

  it("rejects a ready manifest for another recording", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch([{
      recordingId: "other-recording", schemaVersion: 1, sessionId, status: "ready",
      tracks: [{ timelineOffsetMs: 0, url: `/recordings/s/${sessionId}/tracks/0` }],
    }]) });
    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).rejects.toThrow("belongs to another recording");
  });

  it("rejects a ready manifest without tracks", async () => {
    const probe = new HttpLiveDiscordPlaybackReadinessProbe({ expectedOrigin: origin, fetch: fakeFetch([{
      recordingId: "recording-42", schemaVersion: 1, sessionId, status: "ready", tracks: [],
    }]) });
    await expect(probe.prove({
      messageId: "message-42", recordingId: "recording-42",
      recordingPlaybackUrl: `${origin}/recordings/playback#${capability}`,
    })).rejects.toThrow("did not become ready");
  });
});

function fakeFetch(manifests: readonly unknown[]): typeof fetch {
  let call = 0;
  return (input, init) => {
    const current = manifests[call++];
    expect(init).toMatchObject({ method: "POST" });
    if (call === 1) {
      expect(init).toMatchObject({ headers: { authorization: `Bearer ${capability}` } });
    } else {
      expect(new Request(input).url).toBe(`${origin}/recordings/s/${sessionId}/session`);
      expect(init).toMatchObject({
        headers: {
          cookie: `recording_playback_access=${capability}`,
          "x-recording-playback-session": "resume",
        },
      });
    }
    return Promise.resolve(new Response(JSON.stringify(current), {
      headers: {
        "content-type": "application/json",
        ...(call === 1 ? { "set-cookie": `recording_playback_access=${capability}; HttpOnly; Secure; SameSite=Strict; Path=/recordings/s/${sessionId}; Max-Age=604800` } : {}),
      }, status: 200,
    }));
  };
}
