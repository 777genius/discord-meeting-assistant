import { describe, expect, it } from "vitest";

import {
  toVoicetextPortFailure,
  VoicetextTransportError,
} from "../src/errors.js";

describe("Voicetext transport retry classification", () => {
  it.each([
    [1_008, false],
    [1_009, false],
    [1_011, true],
  ])("maps WebSocket close code %i", (closeCode, retryable) => {
    const failure = toVoicetextPortFailure(new VoicetextTransportError(
      "closed",
      "provider closed",
      { closeCode },
    ));

    expect(failure.retryable).toBe(retryable);
  });

  it.each([
    [401, false],
    [429, true],
    [503, true],
  ])("maps WebSocket handshake status %i", (status, retryable) => {
    const failure = toVoicetextPortFailure(new VoicetextTransportError(
      "handshake",
      "upgrade rejected",
      { status },
    ));

    expect(failure.retryable).toBe(retryable);
  });
});
