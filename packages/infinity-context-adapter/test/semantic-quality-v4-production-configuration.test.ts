import { describe, expect, it } from "vitest";

import { decodeSemanticQualityV4OperatorConfiguration } from
  "./semantic-quality-v4-production-composition.js";

const common = Object.freeze(Object.fromEntries([
  "adjudicationDirectory", "artifactKeyId", "artifactKeyPath", "artifactRoot",
  "campaignReceiptDirectory", "campaignRunId", "infinityBaseUrl", "infinityCapabilityPath",
  "infinityServiceAttestationReceiptPath", "infinityTokenPath",
  "exchangeObservationReceiptDirectory", "executionObservationReceiptPath", "journalRoot",
  "postgresUrlPath", "questionReviewReceiptsPath", "runtimeAddress",
  "runtimeServiceAttestationReceiptPath", "runtimeTokenPath", "topologyKeyPath",
  "topologyPath", "trustAnchorPath", "workflowRoot",
].map((key) => [key, `/synthetic-private/${key}`])));

describe("production qualification corpus profile selection", () => {
  it("retains the exact legacy operator configuration", () => {
    const input = { ...common, privateQuestionPath: "/private/questions.json",
      privateRubricPath: "/private/rubric.json", privateTranscriptPath: "/private/transcript.json" };
    expect(decodeSemanticQualityV4OperatorConfiguration(input)).toEqual(input);
  });

  it("selects the human corpus manifest explicitly without legacy file fields", () => {
    const input = { ...common, privateHumanCorpusManifestPath: "/private/human-corpus.json" };
    expect(decodeSemanticQualityV4OperatorConfiguration(input)).toEqual(input);
  });

  it("rejects mixed profiles, absent selection, and caller-supplied review authority", () => {
    const input = { ...common, privateHumanCorpusManifestPath: "/private/human-corpus.json" };
    for (const malformed of [common, { ...input, privateQuestionPath: "/private/questions.json" },
      { ...input, pinnedReviewerKeys: [] }, { ...input, privateHumanCorpusManifestPath: "" }]) {
      expect(() => decodeSemanticQualityV4OperatorConfiguration(malformed)).toThrow();
    }
  });
});
