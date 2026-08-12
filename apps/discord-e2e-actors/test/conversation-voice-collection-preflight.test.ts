import { describe, expect, it, vi } from "vitest";

import { accessDiscordWithBoundConversation } from
  "../src/conversation-voice-collection-preflight.js";
import { retainedV8Evidence } from "./e2e-evidence-fixtures.js";

describe("conversation voice collection preflight", () => {
  it("rejects a recording conflict before reading a secret or connecting", async () => {
    const rawVoice = retainedV8Evidence().conversation.voice;
    rawVoice[2]!.correlation.recordingId = "different-recording";
    const readSecret = vi.fn(async () => "secret-that-must-not-be-read");
    const connect = vi.fn(async () => {});
    const run = vi.fn(async () => {});

    await expect(accessDiscordWithBoundConversation({
      connect,
      rawVoice,
      readSecret,
      recordingId: "meeting-1",
      run,
    })).rejects.toThrow("bound to a different recording");

    expect(readSecret).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the same fully bound array downstream", async () => {
    const rawVoice = retainedV8Evidence().conversation.voice.map((capture) => ({
      ...capture,
      correlation: { ...capture.correlation, recordingId: null },
    }));
    let received: readonly unknown[] | undefined;

    await accessDiscordWithBoundConversation({
      connect: async () => {},
      rawVoice,
      readSecret: async () => "synthetic-token",
      recordingId: "meeting-1",
      run: async (boundVoice) => {
        received = boundVoice;
      },
    });

    expect(received).toHaveLength(6);
    expect(received?.map((capture) =>
      (capture as typeof rawVoice[number]).correlation.recordingId
    )).toEqual(Array.from({ length: 6 }, () => "meeting-1"));
  });
});
