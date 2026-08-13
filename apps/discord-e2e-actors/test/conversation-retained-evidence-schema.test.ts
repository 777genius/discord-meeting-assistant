import { describe, expect, it } from "vitest";

import { conversationVoiceEvidenceV3Schema } from
  "../src/conversation-retained-evidence-schema.js";
import { retainedV8Evidence } from "./e2e-evidence-fixtures.js";

describe("conversation voice retained duration proof", () => {
  it("accepts a capture whose measured duration is inside its retained range", () => {
    const capture = retainedV8Evidence().conversation.voice[0]!;

    expect(() => conversationVoiceEvidenceV3Schema.parse(capture)).not.toThrow();
  });

  it("rejects measured duration below or above the capture's retained range", () => {
    for (const acceptedDurationMilliseconds of [99, 201]) {
      const capture = structuredClone(retainedV8Evidence().conversation.voice[0]!);
      capture.capture.acceptedDurationMilliseconds = acceptedDurationMilliseconds;

      expect(() => conversationVoiceEvidenceV3Schema.parse(capture))
        .toThrow("Accepted duration must be within the retained expected duration range");
    }
  });

  it("rejects an inverted retained duration range", () => {
    const capture = structuredClone(retainedV8Evidence().conversation.voice[0]!);
    capture.capture.expectedDuration = {
      maximumMilliseconds: 99,
      minimumMilliseconds: 100,
    };

    expect(() => conversationVoiceEvidenceV3Schema.parse(capture))
      .toThrow("Expected duration minimum must not exceed maximum");
  });
});
