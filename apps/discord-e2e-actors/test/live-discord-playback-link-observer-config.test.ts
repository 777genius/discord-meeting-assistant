import { describe, expect, it } from "vitest";

import { loadLiveDiscordPlaybackLinkObserverConfig } from "../src/live-discord-playback-link-observer-config.js";
import { createObservedMeetingProjectionMarkers } from "../src/live-discord-projection-marker-contract.js";

const environment = {
  DISCORD_E2E_PLAYBACK_LINK_DURATION_MS: "60000",
  DISCORD_E2E_PLAYBACK_LINK_OUTPUT: "/tmp/playback-link-proof.json",
  DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS: "2000",
  DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON: JSON.stringify({
    id: "33333333333333333", kind: "thread", name: "Meeting results", parentId: "11111111111111111",
  }),
  DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER: "meeting-projection:0123456789abcdef0123",
  DISCORD_E2E_PLAYBACK_LINK_RECORDING_PLAYBACK_ORIGIN: "https://recordings.example.test",
  DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID: "recording-42",
  DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID: "11111111111111111",
  DISCORD_E2E_PLAYBACK_LINK_RUN_ID: "run-42",
  DISCORD_E2E_PLAYBACK_LINK_SUT_APPLICATION_ID: "22222222222222222",
} as const;

describe("live Discord playback-link observer config", () => {
  it("binds the proof to exact run, recording, marker, application, channel and container", () => {
    expect(loadLiveDiscordPlaybackLinkObserverConfig(environment)).toMatchObject({
      container: { id: "33333333333333333", kind: "thread", parentId: "11111111111111111" },
      outputPath: "/tmp/playback-link-proof.json",
      projectionMarkers: ["meeting-projection:0123456789abcdef0123"],
      recordingId: "recording-42",
      resultChannelId: "11111111111111111",
      runId: "run-42",
      sutApplicationId: "22222222222222222",
    });
  });

  it("fails closed for a malformed or cross-channel container", () => {
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment,
      DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON: "not-json",
    })).toThrow();
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment,
      DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON: JSON.stringify({
        kind: "channel-message", parentChannelId: "99999999999999999",
      }),
    })).toThrow("must match the result channel");
  });

  it("derives canonical live and final channel-message markers in hosted mode", () => {
    const hosted = loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment,
      DISCORD_E2E_PLAYBACK_LINK_MEETING_ID: "meeting-42",
      DISCORD_E2E_PLAYBACK_LINK_MODE: "hosted",
      DISCORD_E2E_PLAYBACK_LINK_PROJECTION_CONTAINER_JSON: undefined,
      DISCORD_E2E_PLAYBACK_LINK_PROJECTION_MARKER: undefined,
    });
    expect(hosted.container).toEqual({
      kind: "channel-message", parentChannelId: environment.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID,
    });
    expect(hosted.meetingId).toBe("meeting-42");
    expect(hosted.projectionMarkers).toEqual(createObservedMeetingProjectionMarkers(
      "meeting-42", environment.DISCORD_E2E_PLAYBACK_LINK_RESULT_CHANNEL_ID,
    ));
  });

  it("requires exact meeting and recording identities in hosted mode", () => {
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment, DISCORD_E2E_PLAYBACK_LINK_MODE: "hosted",
    })).toThrow();
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment, DISCORD_E2E_PLAYBACK_LINK_MEETING_ID: "meeting-42",
      DISCORD_E2E_PLAYBACK_LINK_MODE: "hosted", DISCORD_E2E_PLAYBACK_LINK_RECORDING_ID: undefined,
    })).toThrow();
  });

  it("requires bounded polling and an absolute non-root private output coordinate", () => {
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment, DISCORD_E2E_PLAYBACK_LINK_POLL_INTERVAL_MS: "1999",
    })).toThrow();
    expect(() => loadLiveDiscordPlaybackLinkObserverConfig({
      ...environment, DISCORD_E2E_PLAYBACK_LINK_OUTPUT: "relative.json",
    })).toThrow();
  });
});
