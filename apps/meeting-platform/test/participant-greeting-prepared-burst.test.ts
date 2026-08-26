import { describe, expect, it } from "vitest";

import {
  englishParticipantId,
  fixture,
  logger,
  occurredAt,
  russianParticipantId,
} from "./participant-greeting-bridge.support.js";

describe("prepared participant greeting bursts", () => {
  it("starts two close joins in deterministic order with their prepared cues", async () => {
    const context = fixture(
      true,
      "ru",
      logger,
      () => 321,
      ({ participantId }) => ({
        cueId: `prepared-${participantId}`,
        pcmChunks: [Uint8Array.of(1, 0, 2, 0)],
        playbackAttemptId: `registry-${participantId}`,
      }),
    );

    context.bridge.participantsPresent(
      [russianParticipantId, englishParticipantId],
      occurredAt,
    );
    await context.bridge.settle();

    expect(context.coordinator.preparedCalls).toEqual([
      expect.objectContaining({
        cueId: `prepared-${russianParticipantId}`,
        playbackNotAfterMs: 5_321,
        speakerId: russianParticipantId,
      }),
      expect.objectContaining({
        cueId: `prepared-${englishParticipantId}`,
        playbackNotAfterMs: 5_321,
        speakerId: englishParticipantId,
      }),
    ]);
  });
});
