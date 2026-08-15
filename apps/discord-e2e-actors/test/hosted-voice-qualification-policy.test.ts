import { describe, expect, it } from "vitest";

import {
  admitHostedVoiceQualificationPolicy,
  HOSTED_VOICE_QUALIFICATION_POLICY_V1,
  hostedVoiceQualificationPolicyV1Schema,
} from "../src/hosted-voice-qualification-policy.js";

describe("governed hosted voice latency policy", () => {
  it("retains version, owner, review date, thresholds and content digest", () => {
    expect(hostedVoiceQualificationPolicyV1Schema.parse(
      HOSTED_VOICE_QUALIFICATION_POLICY_V1,
    )).toMatchObject({
      owner: "conversation",
      policyId: "hosted-voice-latency",
      policyVersion: 1,
      preparedCueFirstPacketMilliseconds: 750,
      schemaVersion: 1,
    });
  });

  it("does not allow an external campaign file to widen a threshold", () => {
    expect(admitHostedVoiceQualificationPolicy(
      HOSTED_VOICE_QUALIFICATION_POLICY_V1.thresholds,
    )).toBe(HOSTED_VOICE_QUALIFICATION_POLICY_V1);
    expect(() => admitHostedVoiceQualificationPolicy({
      ...HOSTED_VOICE_QUALIFICATION_POLICY_V1.thresholds,
      "question-end-to-answer-first-packet": 4_001,
    })).toThrow("do not match");
  });
});
