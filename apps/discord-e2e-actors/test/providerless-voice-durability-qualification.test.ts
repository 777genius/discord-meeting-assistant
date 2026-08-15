import { describe, expect, it } from "vitest";

import {
  providerlessVoiceDurabilityQualificationV1Schema,
  qualifyProviderlessVoiceDurability,
} from "../src/providerless-voice-durability-qualification.js";

const release = {
  releaseBindingSha256: "1".repeat(64),
  releaseId: "voice-release-1",
  trustRootSha256: "2".repeat(64),
} as const;

describe("providerless two-hour voice durability qualification", () => {
  it("compresses two hours deterministically while proving all terminal invariants", () => {
    const first = qualifyProviderlessVoiceDurability({
      release,
      sourceRevision: "a".repeat(40),
    });
    const second = qualifyProviderlessVoiceDurability({
      release,
      sourceRevision: "a".repeat(40),
    });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      backpressure: {
        peakQueuedPackets: 64,
      },
      cancellation: {
        activeGroundedTurnAborted: true,
        factualPcmPacketsAfterAbort: 0,
      },
      executionMode: "virtual-time-providerless",
      finalizationOrder: [
        "recording-authoritative-ready",
        "transcript-finalized",
        "summary-finalized",
      ],
      greeting: { initialCount: 1, reconnectRepeatCount: 0 },
      memory: { peakLiveTranscriptTurns: 256 },
      networkLatencyEvidence: "excluded-use-retained-live-campaign-measurements",
      recording: { status: "authoritative-ready" },
      simulatedDurationMs: 7_200_000,
      summary: { status: "finalized" },
      transcript: { finalTurnEndMs: 7_200_000, status: "finalized" },
    });
    expect(first.recording.authoritativePacketCount).toBe(
      first.recording.generatedPacketCount,
    );
    expect(first.backpressure.derivedPacketsDropped).toBeGreaterThan(0);
    expect(first.backpressure.events).toBeGreaterThan(0);
  });

  it("detects retained artifact tampering", () => {
    const evidence = qualifyProviderlessVoiceDurability({
      release,
      sourceRevision: "a".repeat(40),
    });
    expect(() => providerlessVoiceDurabilityQualificationV1Schema.parse({
      ...evidence,
      cancellation: { ...evidence.cancellation, factualPcmPacketsAfterAbort: 1 },
    })).toThrow();
    expect(() => providerlessVoiceDurabilityQualificationV1Schema.parse({
      ...evidence,
      transcript: { ...evidence.transcript, durableTurnCount: 1 },
    })).toThrow();
  });
});
