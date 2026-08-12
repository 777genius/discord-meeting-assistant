import { describe, expect, it } from "vitest";

import {
  createMeetingDiscordFinalSummaryProjectionKey,
  createMeetingDiscordProjectionKey,
  createProjectionMarker,
} from "@discord-meeting/discord-adapter";

import { createObservedMeetingProjectionMarkers } from "../src/live-discord-projection-marker-contract.js";

describe("live Discord projection marker contract", () => {
  it.each([
    ["meeting-42", "11111111111111111"],
    ["meeting.with:punctuation", "99999999999999999999"],
  ])("matches the publishing adapter for meeting %s", (meetingId, channelId) => {
    expect(createObservedMeetingProjectionMarkers(meetingId, channelId)).toEqual([
      createProjectionMarker(createMeetingDiscordProjectionKey(meetingId, channelId)),
      createProjectionMarker(createMeetingDiscordFinalSummaryProjectionKey(meetingId, channelId)),
    ]);
  });
});
