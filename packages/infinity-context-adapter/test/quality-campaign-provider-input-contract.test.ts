import { describe, expect, it } from "vitest";
import { DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY } from
  "@discord-meeting/meeting-core/meeting-knowledge";

import { QUALIFICATION_PROVIDER_INPUT_CONTRACT,
  QUALIFICATION_PROVIDER_INPUT_CONTRACT_SHA256, QUALIFICATION_THRESHOLDS,
  assertQualificationProviderAccounting, measureQualificationModelInput,
  sha256, type QualityCampaignRelease } from
  "@discord-meeting/infinity-context-adapter/quality-campaign";
import { qualificationProviderAccountingFixture } from
  "./quality-campaign-provider-accounting-fixture.js";

const d = (value: string) => sha256({ value });
const RELEASE = Object.freeze({ answerImageSha256: d("answer-image"),
  answerProcessIdentitySha256: d("answer-process"), answerReleaseSha256: d("runtime"),
  artifactKeyCustodySha256: d("custody"), authorityPolicySha256: d("policy-authority"),
  discordCommitSha256: d("discord-commit"), discordImageSha256: d("discord-image"),
  discordReleaseSha256: d("discord-release"), infinityCapabilitySha256: d("capability"),
  infinityCommitSha256: d("infinity-commit"), infinityImageSha256: d("infinity-image"),
  infinityProfileSha256: d("profile"), infinityReleaseSha256: d("infinity-release"),
  mapperSha256: d("mapper"), model: "gpt-5.6-terra", policySha256: d("policy"),
  promptSha256: d("prompt"), reasoning: "low", sdkArchiveSha256: d("sdk"),
  serviceTier: "default", targetInventoryAuthorityKeySha256: d("inventory"),
  tokenizerSha256: d("tokenizer") } satisfies QualityCampaignRelease);

describe("canonical production provider-input contract", () => {
  it("aligns the focused production budget with evaluation without relaxing other limits", () => {
    const policy = DEFAULT_FOCUSED_LOCATOR_RETRIEVAL_V2_POLICY;
    expect(policy).toEqual({ candidateLimit: 100, deadlineMs: 2_000,
      evidenceByteLimit: 16_000, maximumSources: 100, responseByteLimit: 16_384,
      resultLimit: 10, version: "meeting-knowledge.locator-retrieval.v2" });
    expect(QUALIFICATION_PROVIDER_INPUT_CONTRACT).toEqual({
      answer: { maximumInputUtf8Bytes: 16_000, maximumOutputBytes: 16_384,
        maximumOutputTokens: 2_048, repairCalls: { maximum: 1, minimum: 0 } },
      retrieval: { candidateLimit: policy.candidateLimit, deadlineMs: policy.deadlineMs,
        evidenceByteLimit: policy.evidenceByteLimit, maximumQueries: 4, neighborRadius: 0,
        responseByteLimit: policy.responseByteLimit, resultLimit: policy.resultLimit },
      schemaVersion: "meeting_knowledge.semantic_quality_provider_input_contract.v1",
    });
    expect(QUALIFICATION_THRESHOLDS.maximumRetrievalLatencyP95Us).toBe(3_000_000);
  });

  it("rejects the unchanged-schema 1000 ms accounting identity", () => {
    const staleContractSha256 = "ca773c4516342ea2e034ba2714fddd5742a80e78761944ea20f5da7a43317bf3";
    expect(sha256({ ...QUALIFICATION_PROVIDER_INPUT_CONTRACT,
      retrieval: { ...QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval, deadlineMs: 1_000 },
    })).toBe(staleContractSha256);
    expect(QUALIFICATION_PROVIDER_INPUT_CONTRACT_SHA256).not.toBe(staleContractSha256);
    const current = qualificationProviderAccountingFixture(RELEASE, "retrieval");
    expect(assertQualificationProviderAccounting(current,
      { callKind: "retrieval", release: RELEASE })).toEqual(current);
    expect(() => assertQualificationProviderAccounting({ ...current,
      contractSha256: staleContractSha256 },
    { callKind: "retrieval", release: RELEASE })).toThrow(/frozen production bindings/u);
  });

  it("measures UTF-8 bytes at the exact 16000-byte boundary", () => {
    for (const unit of ["a", "Ж", "😀", "e\u0301"]) {
      const fixedBytes = 2; // the two canonical LF separators
      const unitBytes = new TextEncoder().encode(unit).byteLength;
      const count = Math.floor((16_000 - fixedBytes) / unitBytes);
      const prompt = unit.repeat(count);
      const measured = measureQualificationModelInput({ outputSchema: "", systemPrompt: "",
        userPrompt: prompt });
      expect(measured.fullInputUtf8Bytes).toBe(fixedBytes + count * unitBytes);
      expect(measured.fullInputUtf8Bytes).toBeLessThanOrEqual(16_000);
      expect(() => measureQualificationModelInput({ outputSchema: "", systemPrompt: "",
        userPrompt: `${prompt}${unit}` })).toThrow(/16000 UTF-8 bytes/u);
    }
    expect("😀".length).toBe(2);
    expect(new TextEncoder().encode("😀").byteLength).toBe(4);
  });

  it("rejects extra calls, limit overflow, missing bindings, and caller accounting fields", () => {
    const exact = qualificationProviderAccountingFixture(RELEASE, "answer");
    const hostile: unknown[] = [
      { ...exact, repair: { callCount: 2, inputUtf8Bytes: 2, outputBytes: 2 } },
      { ...exact, original: { ...exact.original, inputUtf8Bytes: 16_001 } },
      { ...exact, original: { ...exact.original, outputBytes: 16_385 } },
      { ...exact, runtimeSha256: undefined },
      { ...exact, candidateCount: 101 },
      { ...exact, outcomeSuppliedAccounting: exact },
    ];
    for (const value of hostile) {
      expect(() => assertQualificationProviderAccounting(value,
        { callKind: "answer", release: RELEASE })).toThrow();
    }
    expect(QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.neighborRadius).toBe(0);
    expect(QUALIFICATION_PROVIDER_INPUT_CONTRACT.retrieval.candidateLimit).toBe(100);
  });

  it("requires exactly one resolver call only for resolver effects", () => {
    const resolver = qualificationProviderAccountingFixture(RELEASE, "resolver");
    expect(resolver.resolver.callCount).toBe(1);
    expect(() => assertQualificationProviderAccounting({ ...resolver,
      original: { callCount: 1, inputUtf8Bytes: 1, outputBytes: 1 } },
    { callKind: "resolver", release: RELEASE })).toThrow(/hidden calls/u);
    expect(() => assertQualificationProviderAccounting({ ...resolver,
      resolver: { callCount: 0, inputUtf8Bytes: 0, outputBytes: 0 } },
    { callKind: "resolver", release: RELEASE })).toThrow(/hidden calls/u);
  });
});
