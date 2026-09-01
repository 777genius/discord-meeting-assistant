import { describe, expect, it } from "vitest";

import { QUALIFICATION_PROVIDER_INPUT_CONTRACT,
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
  mapperSha256: d("mapper"), model: "gpt-5.6-sol", policySha256: d("policy"),
  promptSha256: d("prompt"), reasoning: "xhigh", sdkArchiveSha256: d("sdk"),
  serviceTier: "default", targetInventoryAuthorityKeySha256: d("inventory"),
  tokenizerSha256: d("tokenizer") } satisfies QualityCampaignRelease);

describe("canonical production provider-input contract", () => {
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
