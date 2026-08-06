import { describe, expect, it } from "vitest";

import { HmacRecordingPlaybackAccess } from "../src/recording-playback/adapters/hmac-recording-playback-access.js";

const secret = "a-secure-recording-playback-secret-with-more-than-32-bytes";

describe("HmacRecordingPlaybackAccess", () => {
  it("issues stable unguessable fragment links and verifies their meeting", () => {
    const access = new HmacRecordingPlaybackAccess({
      publicBaseUrl: "https://recordings.example.com",
      secret,
    });
    const link = new URL(access.issueUrl("meeting:DyDiHRy0kaYR"));
    const token = link.hash.slice(1);

    expect(link.origin).toBe("https://recordings.example.com");
    expect(link.pathname).toBe("/recordings/playback");
    expect(link.search).toBe("");
    expect(access.verify(token)).toEqual(expect.objectContaining({
      meetingId: "meeting:DyDiHRy0kaYR",
      token,
    }));
    expect(access.issueUrl("meeting:DyDiHRy0kaYR")).toBe(link.href);
  });

  it("fails closed for tampered and malformed tokens", () => {
    const access = new HmacRecordingPlaybackAccess({
      publicBaseUrl: "https://recordings.example.com",
      secret,
    });
    const token = new URL(access.issueUrl("meeting-1")).hash.slice(1);

    expect(access.verify(`${token.slice(0, -1)}x`)).toBeNull();
    expect(access.verify("v1.invalid.invalid")).toBeNull();
    expect(access.verify("x".repeat(1_025))).toBeNull();
    const rotated = new HmacRecordingPlaybackAccess({
      publicBaseUrl: "https://recordings.example.com",
      secret: `${secret}-rotated`,
    });
    expect(rotated.verify(token)).toBeNull();
  });

  it("rejects weak secrets and public URLs with hidden path state", () => {
    expect(() => new HmacRecordingPlaybackAccess({
      publicBaseUrl: "https://recordings.example.com/path",
      secret,
    })).toThrow("HTTP(S) origin");
    expect(() => new HmacRecordingPlaybackAccess({
      publicBaseUrl: "https://recordings.example.com",
      secret: "too-short",
    })).toThrow("at least 32 bytes");
  });
});
