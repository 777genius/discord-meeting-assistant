import { describe, expect, it } from "vitest";

import {
  digestVoicetextCanaryExpectationV1,
  produceVoicetextSemanticCanaryReceiptV1,
  type VoicetextCanaryInternalResultV1,
} from "../src/hosted-voicetext-semantic-canary-producer.js";

const expectedSegments = [
  { endMs: 1_000, startMs: 0, text: "Привет Botik" },
  { endMs: 2_000, startMs: 1_100, text: "hello Quanta" },
] as const;
const binding = {
  campaignId: "campaign-1", containerId: "platform-1", fixtureSha256: "a".repeat(64),
  host: "worker-test-1", imageDigestSha256: "b".repeat(64), planSha256: "c".repeat(64),
  sourceRevision: "d".repeat(40), transcriptExpectationSha256: digestVoicetextCanaryExpectationV1(expectedSegments),
} as const;
const endpoint = {
  batch: { origin: "https://voicetext.test", path: "/v2/listen" },
  live: { origin: "wss://voicetext.test", path: "/v1/listen" },
} as const;

describe("hosted Voicetext semantic canary producer", () => {
  it("computes semantic evidence locally and retains no transcript or token content", async () => {
    const internal = result();
    const receipt = await produceVoicetextSemanticCanaryReceiptV1(input(), {
      run: async () => internal,
    });
    expect(receipt.batch.firstSubmission).toEqual(receipt.batch.idempotentReplay);
    expect(receipt.quality).toMatchObject({
      characterErrorRate: 0, observedMaximumTimelineDeltaMs: 20,
      requiredTermMatches: 2, wordErrorRate: 0,
    });
    expect(receipt.expiresAtEpochMs).toBe(160_000);
    expect(JSON.stringify(receipt)).not.toMatch(/Привет|hello Quanta|secret-token/u);
  });

  it("timestamps the receipt after the slow canary completes", async () => {
    let currentTime = 100_000;
    const receipt = await produceVoicetextSemanticCanaryReceiptV1({
      ...input(), now: () => currentTime,
    }, { run: async () => {
      currentTime += 300_000;
      return result();
    } });

    expect(receipt.generatedAtEpochMs).toBe(400_000);
    expect(receipt.expiresAtEpochMs).toBe(460_000);
  });

  it("treats spoken and numeric Russian dates as the same semantic transcript", async () => {
    const spoken = [{
      endMs: 2_000,
      startMs: 0,
      text: "До седьмого августа две тысячи двадцать шестого года",
    }] as const;
    const numeric = [{ endMs: 2_000, startMs: 0, text: "До 7 августа 2026 года" }];
    const numericDigest = digestVoicetextCanaryExpectationV1(numeric);
    const internal: VoicetextCanaryInternalResultV1 = {
      ...result(),
      batch: {
        firstSubmission: { jobId: "job-date", resultId: "result-date", resultSha256: numericDigest },
        idempotentReplay: { jobId: "job-date", resultId: "result-date", resultSha256: numericDigest },
        segments: numeric,
        utteranceCount: 1,
      },
      live: { ...result().live, segments: numeric },
    };
    const receipt = await produceVoicetextSemanticCanaryReceiptV1({
      ...input(),
      binding: {
        ...binding,
        transcriptExpectationSha256: digestVoicetextCanaryExpectationV1(spoken),
      },
      expectedSegments: spoken,
      requiredTerms: ["августа", "2026"],
    }, { run: async () => internal });

    expect(receipt.quality).toMatchObject({
      characterErrorRate: 0,
      requiredTermMatches: 2,
      wordErrorRate: 0,
    });
  });

  it("rejects a receipt TTL longer than the admission freshness window", async () => {
    await expect(produceVoicetextSemanticCanaryReceiptV1({
      ...input(), ttlMs: 60_001,
    }, { run: async () => result() })).rejects.toThrow("producer input is invalid");
  });

  it.each([
    ["idempotency substitution", (value: VoicetextCanaryInternalResultV1) => ({ ...value, batch: { ...value.batch, idempotentReplay: { ...value.batch.idempotentReplay, resultId: "other" } } })],
    ["immutable result substitution", (value: VoicetextCanaryInternalResultV1) => ({ ...value, batch: { ...value.batch, firstSubmission: { ...value.batch.firstSubmission, resultSha256: "0".repeat(64) }, idempotentReplay: { ...value.batch.idempotentReplay, resultSha256: "0".repeat(64) } } })],
    ["missing live acknowledgement", (value: VoicetextCanaryInternalResultV1) => ({ ...value, live: { ...value.live, audioAcknowledgements: { expected: 2, received: 1 } } })],
    ["unfinalized live session", (value: VoicetextCanaryInternalResultV1) => ({ ...value, live: { ...value.live, finalizeComplete: false } })],
  ])("rejects %s", async (_label, mutate) => {
    await expect(produceVoicetextSemanticCanaryReceiptV1(input(), {
      run: async () => mutate(result()),
    })).rejects.toThrow();
  });

  it("rejects an expectation that does not match the pinned deployment binding", async () => {
    await expect(produceVoicetextSemanticCanaryReceiptV1({
      ...input(), expectedSegments: [{ endMs: 100, startMs: 0, text: "substituted" }],
    }, { run: async () => result() })).rejects.toThrow(/expectation binding/u);
  });
});

function input() {
  return {
    binding, endpoint, expectedSegments, fixturePath: "/fixtures/canary.ogg",
    now: () => 100_000, requiredTerms: ["Botik", "Quanta"], timeoutMs: 30_000, ttlMs: 60_000,
  } as const;
}

function result(): VoicetextCanaryInternalResultV1 {
  const batchSegments = [...expectedSegments];
  return {
    batch: {
      firstSubmission: { jobId: "job-1", resultId: "result-1", resultSha256: digestVoicetextCanaryExpectationV1(batchSegments) },
      idempotentReplay: { jobId: "job-1", resultId: "result-1", resultSha256: digestVoicetextCanaryExpectationV1(batchSegments) },
      segments: batchSegments, utteranceCount: 2,
    },
    live: {
      audioAcknowledgements: { expected: 2, received: 2 }, finalizeComplete: true, protocolReady: true,
      segments: [
        { endMs: 1_010, startMs: 10, text: "Привет Botik" },
        { endMs: 2_020, startMs: 1_120, text: "hello Quanta" },
      ],
    },
    schemaVersion: 1,
    tokenFile: { generationId: "generation-2", mode: 0o400, ownerUid: 10_001, path: "/run/secrets/voicetext" },
  };
}
