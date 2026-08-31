import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { decodeHumanSemanticQualityV4Corpus } from
  "./semantic-quality-v4-human-corpus.js";
import { canonicalIntegerJson } from "./semantic-quality-v4-manifest.js";
import { loadRealSemanticQualityV4Corpus } from "./semantic-quality-v4-private-corpus.js";
import { semanticQualityV4ReceiptSigningBytes } from "./semantic-quality-v4-trusted-receipts.js";

const meetingId = "synthetic-human-meeting";
const approvedCommit = "a".repeat(40);
const bindingPaths = Object.freeze({
  dataset: "private/synthetic-dataset.json",
  identity: "private/synthetic-identity.json",
  source: "private/synthetic-source.json",
});

describe("semantic quality V4 human corpus decoder", () => {
  it("admits an exactly bound synthetic corpus without leaking oracle query filters", () => {
    const fixture = buildFixture();
    const corpus = decodeHumanSemanticQualityV4Corpus(fixture.input);

    expect(corpus.profile).toBe("human_corpus_v1");
    expect(corpus.safeCounts).toMatchObject({
      abstention: 11,
      answerable: 29,
      locales: { en: 10, ru: 30 },
      questions: 40,
      speakers: 6,
      turns: 1769,
    });
    expect(corpus.questions.every(({ speakerIds, timeWindow }) =>
      speakerIds.length === 0 && timeWindow === null)).toBe(true);
    expect(corpus.questions.filter(({ kind }) => kind === "unsupported")
      .every(({ evidenceTurnIds, expectedClaimIds }) =>
        evidenceTurnIds.length === 0 && expectedClaimIds.length === 0)).toBe(true);
    expect(corpus.privateGoldAuthority).toEqual(fixture.gold);
    expect(JSON.stringify(corpus.bindings)).not.toContain("SYNTHETIC_PRIVATE_TEXT");
  });

  it("fails closed on each raw-file pin and on evidence-derived mutations", () => {
    const fixture = buildFixture();
    for (const key of ["source", "dataset", "identity", "gold"] as const) {
      expect(() => decodeHumanSemanticQualityV4Corpus({
        ...fixture.input,
        pinnedSha256: { ...fixture.input.pinnedSha256, [key]: "f".repeat(64) },
      }), key).toThrow(/raw-file digest/u);
    }

    const dataset = structuredClone(fixture.dataset);
    const answer = dataset.cases[0] as {
      evidence: Array<{ startMs: number }>;
    };
    answer.evidence[0]!.startMs += 1;
    const datasetBytes = jsonBytes(dataset);
    expect(() => decodeHumanSemanticQualityV4Corpus({
      ...fixture.input,
      datasetBytes,
      pinnedSha256: {
        ...fixture.input.pinnedSha256,
        dataset: sha256(datasetBytes),
      },
    })).toThrow();
  });

  it("does not promote abstention distractors to positive recall gold", () => {
    const fixture = buildFixture();
    const corpus = decodeHumanSemanticQualityV4Corpus(fixture.input);
    const unsupported = corpus.questions.find(({ id }) => id === "case-29")!;
    expect((fixture.dataset.cases[29] as {
      distractorEvidence: unknown[];
    }).distractorEvidence).toHaveLength(1);
    expect(unsupported.kind).toBe("unsupported");
    expect(unsupported.evidenceTurnIds).toEqual([]);
  });
});

function buildFixture() {
  const humanSpeakerIds = Array.from({ length: 6 }, (_, index) => `human-${index + 1}`);
  const botId = "excluded-bot";
  const turns = [
    ...Array.from({ length: 10 }, (_, index) => ({
      endMs: index * 1000 + 900,
      speakerId: botId,
      startMs: index * 1000,
      text: `SYNTHETIC_PRIVATE_BOT_TEXT_${index}`,
      turnId: `bot-turn-${index}`,
    })),
    ...Array.from({ length: 1769 }, (_, index) => ({
      endMs: (index + 10) * 1000 + 900,
      speakerId: humanSpeakerIds[index % humanSpeakerIds.length]!,
      startMs: (index + 10) * 1000,
      text: `SYNTHETIC_PRIVATE_TEXT_${index}`,
      turnId: `human-turn-${index}`,
    })),
  ];
  const source = {
    meetingId,
    summary: { synthetic: true },
    transcript: {
      readableSegments: [],
      recordingId: "synthetic-recording",
      transcriptId: "synthetic-transcript",
      turns,
      version: 1,
    },
  };
  const sourceBytes = jsonBytes(source);
  const sourceSha256 = sha256(sourceBytes);
  const identity = {
    authorityKind: "operator_confirmed_discord_identity_map",
    canonicalSha256Semantics: {
      algorithm: "sha256",
      canonicalization: "RFC8785",
      encoding: "UTF-8",
      framing: "single_trailing_lf",
      scope: "entire_document",
    },
    entries: humanSpeakerIds.map((speakerId, index) => ({
      displayName: `Synthetic Human ${index + 1}`,
      speakerId,
      type: "human",
    })),
    excludedIds: [{ reason: "synthetic bot", speakerId: botId }],
    meetingId,
    schema: "meeting-identity-authority",
    sourceSha256,
    version: 1,
  };
  const identityBytes = canonicalBytes(identity);
  const identitySha256 = sha256(identityBytes);
  const cases = Array.from({ length: 40 }, (_, index) => {
    const turn = turns[10 + index]!;
    const locator = {
      endMs: turn.endMs,
      speakerId: turn.speakerId,
      speakerName: `Synthetic Human ${(index % 6) + 1}`,
      startMs: turn.startMs,
      turnId: turn.turnId,
    };
    const base = {
      adjudicationRule: "Compare each claim with its canonical synthetic evidence.",
      caseId: `case-${index}`,
      category: `category_${index % 4}`,
      expectedDisposition: index < 29 ? "answer" as const : "abstain" as const,
      language: index < 30 ? "ru" as const : "en" as const,
      question: `Synthetic question ${index}?`,
      tags: [`synthetic-${index}`],
    };
    return index < 29 ? {
      ...base,
      evidence: [locator],
      expectedAnswer: `SYNTHETIC_EXPECTED_ANSWER_${index}`,
    } : {
      ...base,
      abstentionReason: `SYNTHETIC_ABSTENTION_REASON_${index}`,
      distractorEvidence: [locator],
    };
  });
  const dataset = {
    cases,
    identityAuthoritySha256: identitySha256,
    meetingId,
    schemaVersion: "meeting-memory-human-eval-v1",
    sourceTurnCount: 1779,
  };
  const datasetBytes = jsonBytes(dataset);
  const datasetSha256 = sha256(datasetBytes);
  let nextClaim = 0;
  let nextForbidden = 0;
  const goldCases = cases.map((item, index) => {
    const locator = "evidence" in item ? item.evidence[0]! : item.distractorEvidence[0]!;
    const goldLocator = {
      endMs: locator.endMs,
      speakerId: locator.speakerId,
      startMs: locator.startMs,
      turnId: locator.turnId,
    };
    if (index >= 29) {
      return {
        caseId: item.caseId,
        distractorLocators: [goldLocator],
        expectedDisposition: "abstain",
        forbiddenAssertions: [{
          assertionId: `assertion-${index}`,
          normalizedAssertion: `SYNTHETIC_FORBIDDEN_ASSERTION_${index}`,
        }],
        forbiddenCategories: ["synthetic"],
      };
    }
    const claimCount = index < 14 ? 3 : 2;
    const forbiddenCount = index < 5 ? 2 : 1;
    return {
      caseId: item.caseId,
      evidenceLocators: [goldLocator],
      expectedDisposition: "answer",
      forbiddenClaims: Array.from({ length: forbiddenCount }, () => {
        const id = nextForbidden++;
        return {
          category: "synthetic",
          claimId: `forbidden-${id}`,
          normalizedClaim: `SYNTHETIC_FORBIDDEN_CLAIM_${id}`,
        };
      }),
      requiredClaims: Array.from({ length: claimCount }, () => {
        const id = nextClaim++;
        return {
          claimId: `claim-${id}`,
          dimensions: ["semantic_correctness", "citation_entailment", "speaker_identity",
            ...(id < 44 ? ["time_phase"] : []),
            ...(id < 10 ? ["latest_correction"] : [])],
          ...(id < 44 ? { timeTarget: "synthetic phase" } : {}),
          ...(id < 10 ? { latestCorrectionTarget: "synthetic correction" } : {}),
          evidenceTurnIds: [goldLocator.turnId],
          normalizedClaim: `SYNTHETIC_REQUIRED_CLAIM_${id}`,
          speakerTargets: [goldLocator.speakerId],
        };
      }),
    };
  });
  const gold = {
    bindings: {
      dataset: {
        approvedCommit,
        path: bindingPaths.dataset,
        sha256: datasetSha256,
      },
      identityAuthority: {
        path: bindingPaths.identity,
        sha256: identitySha256,
      },
      meetingId,
      source: {
        path: bindingPaths.source,
        sha256: sourceSha256,
      },
    },
    canonicalization: {
      encoding: "UTF-8",
      framing: "single_trailing_lf",
      scheme: "RFC8785",
    },
    cases: goldCases,
    denominators: {
      citation_entailment: 72,
      latest_correction: 10,
      semantic_correctness: 72,
      speaker_identity: 72,
      time_phase: 44,
    },
    dimensionDefinitions: {
      synthetic_private_opaque_leaf: {
        forbidden_material: "SYNTHETIC_PRIVATE_GOLD_BYTES_RETAINED",
      },
    },
    schemaVersion: "gold-claims-v1",
  };
  const goldBytes = canonicalBytes(gold);
  return {
    dataset,
    gold,
    identity,
    source,
    input: {
      approvedCommit,
      bindingPaths,
      datasetBytes,
      goldBytes,
      identityBytes,
      meetingId,
      pinnedSha256: {
        dataset: datasetSha256,
        gold: sha256(goldBytes),
        identity: identitySha256,
        source: sourceSha256,
      },
      sourceBytes,
    },
  };
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalIntegerJson(value)}\n`);
}

function refreshBindings(fixture: ReturnType<typeof buildFixture>) {
  const sourceBytes = jsonBytes(fixture.source);
  fixture.identity.sourceSha256 = sha256(sourceBytes);
  const identityBytes = canonicalBytes(fixture.identity);
  fixture.dataset.identityAuthoritySha256 = sha256(identityBytes);
  const datasetBytes = jsonBytes(fixture.dataset);
  fixture.gold.bindings.source.sha256 = sha256(sourceBytes);
  fixture.gold.bindings.identityAuthority.sha256 = sha256(identityBytes);
  fixture.gold.bindings.dataset.sha256 = sha256(datasetBytes);
  const goldBytes = canonicalBytes(fixture.gold);
  return { ...fixture.input, sourceBytes, identityBytes, datasetBytes, goldBytes,
    pinnedSha256: { source: sha256(sourceBytes), identity: sha256(identityBytes),
      dataset: sha256(datasetBytes), gold: sha256(goldBytes) } };
}

describe("human corpus structural authority", () => {
  it("uses the public loader and requires two exact identity-bound independent reviews", () => {
    const fixture = buildFixture();
    const decoded = decodeHumanSemanticQualityV4Corpus(fixture.input);
    const root = mkdtempSync(join(tmpdir(), "synthetic-human-corpus-"));
    const reviewers = ["synthetic-reviewer-a", "synthetic-reviewer-b"].map((keyId) => {
      const keys = generateKeyPairSync("ed25519");
      return { keys, pinned: { keyId,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        roles: ["question_rubric_review"] as const } };
    });
    const receipts = (binding: Readonly<Record<string, string>>) => reviewers.map((reviewer) => {
      const unsigned = { binding, decisionDigestSha256: sha256(new TextEncoder().encode(
        `synthetic-decision-${reviewer.pinned.keyId}`)),
        receiptId: `${reviewer.pinned.keyId}-decision`, reviewerKeyId: reviewer.pinned.keyId,
        role: "question_rubric_review" as const,
        schemaVersion: "meeting_knowledge.semantic_quality_review_receipt.v1" as const };
      return { ...unsigned, signatureBase64: sign(null,
        semanticQualityV4ReceiptSigningBytes(unsigned), reviewer.keys.privateKey).toString("base64") };
    });
    try {
      for (const [name, bytes] of [["source", fixture.input.sourceBytes],
        ["dataset", fixture.input.datasetBytes], ["gold", fixture.input.goldBytes],
        ["identity", fixture.input.identityBytes]] as const) {
        writeFileSync(join(root, `${name}.json`), bytes, { mode: 0o600, flag: "wx" });
      }
      const input = { profile: "human_corpus_v1" as const, approvedCommit, bindingPaths, meetingId,
        sourcePath: join(root, "source.json"), datasetPath: join(root, "dataset.json"),
        identityPath: join(root, "identity.json"), goldPath: join(root, "gold.json"),
        pinnedSha256: fixture.input.pinnedSha256,
        pinnedReviewerKeys: reviewers.map(({ pinned }) => pinned),
        reviewReceipts: receipts(decoded.bindings) };
      expect(loadRealSemanticQualityV4Corpus(input).reviewReceipts).toHaveLength(2);
      expect(() => loadRealSemanticQualityV4Corpus({ ...input, reviewReceipts: [] }))
        .toThrow(/not independent exact-binding receipts/u);
      expect(() => loadRealSemanticQualityV4Corpus({ ...input,
        reviewReceipts: [input.reviewReceipts[0], input.reviewReceipts[0]] }))
        .toThrow(/not independent exact-binding receipts/u);
      const incomplete = Object.fromEntries(Object.entries(decoded.bindings)
        .filter(([key]) => key !== "identityFileSha256"));
      expect(() => loadRealSemanticQualityV4Corpus({ ...input, reviewReceipts: receipts(incomplete) }))
        .toThrow(/not independent exact-binding receipts/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown and multiply mapped actors after all hashes are refreshed", () => {
    const unknown = buildFixture();
    unknown.source.transcript.turns[12]!.speakerId = "unknown-human";
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(unknown)))
      .toThrow(/does not cover every source speaker/u);
    const duplicate = buildFixture();
    duplicate.identity.entries[1]!.speakerId = duplicate.identity.entries[0]!.speakerId;
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(duplicate)))
      .toThrow(/actor map/u);
  });

  it("rejects duplicate turns, invalid intervals and duplicate cases", () => {
    const duplicate = buildFixture();
    duplicate.source.transcript.turns[1]!.turnId = duplicate.source.transcript.turns[0]!.turnId;
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(duplicate)))
      .toThrow(/source aggregates/u);
    const interval = buildFixture();
    interval.source.transcript.turns[1]!.endMs = interval.source.transcript.turns[1]!.startMs;
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(interval)))
      .toThrow(/source turn/u);
    const cases = buildFixture();
    cases.dataset.cases[1]!.caseId = cases.dataset.cases[0]!.caseId;
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(cases)))
      .toThrow(/dataset case authority/u);
  });

  it("rejects gold speaker substitutions and duplicate metric dimensions", () => {
    const speaker = buildFixture();
    speaker.gold.cases[0]!.requiredClaims![0]!.speakerTargets = ["unknown-human"];
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(speaker)))
      .toThrow(/required claim/u);
    const dimensions = buildFixture();
    dimensions.gold.cases[0]!.requiredClaims![0]!.dimensions.push("semantic_correctness");
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(dimensions)))
      .toThrow(/required claim/u);
  });

  it("recomputes denominators instead of trusting declared totals", () => {
    const fixture = buildFixture();
    const claim = fixture.gold.cases[0]!.requiredClaims![0]!;
    claim.dimensions = claim.dimensions.filter((dimension) => dimension !== "time_phase");
    delete claim.timeTarget;
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(fixture)))
      .toThrow(/gold aggregates/u);
  });

  it("rejects duplicate evidence and missing positive claims", () => {
    const duplicate = buildFixture();
    const datasetCase = duplicate.dataset.cases[0]!;
    if (!("evidence" in datasetCase)) {throw new Error("expected answer fixture");}
    datasetCase.evidence.push(datasetCase.evidence[0]!);
    duplicate.gold.cases[0]!.evidenceLocators!.push(duplicate.gold.cases[0]!.evidenceLocators![0]!);
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(duplicate)))
      .toThrow(/dataset and gold evidence disagree/u);
    const empty = buildFixture();
    empty.gold.cases[0]!.requiredClaims = [];
    expect(() => decodeHumanSemanticQualityV4Corpus(refreshBindings(empty)))
      .toThrow(/answer gold/u);
  });

  it("rejects oversized or invalid JSON without including private text in errors", () => {
    const fixture = buildFixture();
    expect(() => decodeHumanSemanticQualityV4Corpus({ ...fixture.input,
      sourceBytes: new Uint8Array(4_000_001) })).toThrow(/file size/u);
    const sourceBytes = new TextEncoder().encode("SYNTHETIC_PRIVATE_TEXT_INVALID_JSON");
    expect(() => decodeHumanSemanticQualityV4Corpus({ ...fixture.input, sourceBytes,
      pinnedSha256: { ...fixture.input.pinnedSha256, source: sha256(sourceBytes) } }))
      .toThrow(/^semantic quality V4 human private JSON is invalid$/u);
  });

  it("retains immutable complete negative gold without converting it to positive evidence", () => {
    const fixture = buildFixture();
    const corpus = decodeHumanSemanticQualityV4Corpus(fixture.input);
    const gold = corpus.privateGoldAuthority as typeof fixture.gold;
    expect(Object.isFrozen(gold)).toBe(true);
    expect(Object.isFrozen(gold.cases)).toBe(true);
    expect(Object.isFrozen(gold.cases[29]!.forbiddenAssertions)).toBe(true);
    expect(gold.cases[29]!.forbiddenAssertions).toEqual(fixture.gold.cases[29]!.forbiddenAssertions);
    expect(corpus.questions[29]!.evidenceTurnIds).toEqual([]);
    expect(corpus.bindings.goldFileSha256).toBe(fixture.input.pinnedSha256.gold);
  });
});

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
