import type { InfinityContextClient } from "@infinity-context/sdk";
import { ingestHistoricalDocument } from "../src/infinity-context-sdk-contract.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalHistoricalPlannerJson,
  buildHistoricalIndexPlan,
  buildHistoricalIndexPlanFromPreparedWindows,
  type AcceptedFinalMeetingV1,
  type HistoricalEvidenceBlockPolicyV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  CooperativeHistoricalIndexPlanner,
  HmacHistoricalOpaqueIds,
  PinnedMultilingualMiniLmTokenizer,
  Sha256HistoricalReceiptDigest,
} from "../src/index.js";
import {
  infinityDocumentEmbeddingInput,
  normalizeInfinityEmbeddingInput,
} from "../src/infinity-embedding-input.js";

const policy: HistoricalEvidenceBlockPolicyV1 = {
  maximumEmbeddingTokens: 96,
  maxBlockUtf8Bytes: 4_096,
  maxBlocksPerMeeting: 500,
  maxTurnsPerBlock: 14,
  turnOverlap: 2,
  version: "meeting-knowledge.block-policy.v1",
};

function meeting(texts: readonly string[]): AcceptedFinalMeetingV1 {
  return {
    authoritativeDurationMs: 7_200_000,
    binding: {
      acceptedMeetingRevision: 7,
      desiredGeneration: 2,
      evidencePolicyVersion: "meeting-knowledge.evidence-block.v1",
      meetingId: "synthetic-budget-meeting",
      releaseId: "synthetic-release",
      roomId: "synthetic-room",
      schemaVersion: 1,
      scopeId: "synthetic-scope",
      transcriptId: "synthetic-transcript",
      transcriptVersion: 3,
    },
    humanTurns: texts.map((text, index) => ({
      endMs: index * 4_000 + 3_900,
      speakerId: `speaker-${index % 3}`,
      startMs: index * 4_000,
      text,
      turnId: `turn-${index}`,
    })),
    schemaVersion: 1,
  };
}

function ids(seed = "synthetic-budget-seed"): HmacHistoricalOpaqueIds {
  return new HmacHistoricalOpaqueIds(seed.padEnd(64, "!"));
}

describe("historical document embedding input budget", () => {
  const tokenizer = new PinnedMultilingualMiniLmTokenizer();
  const active: CooperativeHistoricalIndexPlanner[] = [];

  afterEach(async () => {
    await Promise.all(active.splice(0).map((planner) => planner.close()));
  });

  it("preserves the raw encoder maximum and publishes the normalized body reserve", () => {
    expect(tokenizer.profile.maxInputTokens).toBe(128);
    expect(tokenizer.profile.inputBudget).toEqual({
      identity: "meeting-knowledge.normalized-document-title-reserve56.v1",
      maximumBodyTokens: 72,
    });
    expect(tokenizer.countTokens("word ".repeat(94).trim())).toBe(96);
  });

  it("reproduces title overflow and splits the formerly accepted 96-token body", () => {
    const body = "word ".repeat(94).trim();
    const title = `mkevidence1.${ids().keyedId("historical-document-title", ["old-window"])}`;
    expect(tokenizer.countTokens(infinityDocumentEmbeddingInput(title, body)))
      .toBeGreaterThan(128);
    expect(() => { tokenizer.assertDocumentInput(title, body); }).toThrow(/maximum/u);
    const plan = buildHistoricalIndexPlan(meeting([body]), ids(), policy, tokenizer);
    expect(plan.documents.length).toBeGreaterThan(1);
    for (const document of plan.documents) {
      expect(document.manifest.embeddingTokenEstimate).toBeLessThanOrEqual(72);
      expect(tokenizer.countTokens(infinityDocumentEmbeddingInput(
        document.title, document.embeddingText,
      ))).toBeLessThanOrEqual(128);
      expect(() => { tokenizer.assertDocumentInput(document.title, document.embeddingText); })
        .not.toThrow();
    }
  });

  it.each([
    ["\u001cHELLO\u0085WORLD\u001f", "hello world"],
    ["\u00a0ПРИВЕТ\u2003Mixed\u3000", "привет mixed"],
    ["\ufeffHELLO\ufeff", "\ufeffhello\ufeff"],
    ["ΟΣ ΣΑ Σ", "ος σα σ"],
    ["İ K ẞ", "i\u0307 k ß"],
    ["👩‍🚀\t𒀀", "👩‍🚀 𒀀"],
  ])("counts Infinity normalization while preserving original input %j", (body, normalized) => {
    expect(normalizeInfinityEmbeddingInput(body)).toBe(normalized);
    expect(tokenizer.countBodyTokens(body)).toBe(tokenizer.countTokens(normalized));
  });

  it.each(["", "mkevidence1.short", `mkevidence1.${"a".repeat(42)}!`])(
    "rejects malformed opaque title %j",
    (title) => {
      expect(() => { tokenizer.assertDocumentInput(title, "short body"); })
        .toThrow(/title/u);
    },
  );

  it.each(["\ud800", String.fromCodePoint(0x1c89)])(
    "fails closed for unsupported normalization %j",
    (body) => {
      expect(() => tokenizer.countBodyTokens(body)).toThrow(/Unsupported Unicode/u);
    },
  );

  it("does not prepend a title already present under Infinity case folding", () => {
    const title = `mkevidence1.${"s".repeat(43)}`;
    const body = `${title.toUpperCase()}\n Details`;
    expect(infinityDocumentEmbeddingInput(title, body)).toBe(`${title} details`);
  });

  it("keeps every full document within 128 across keys, ordinals and languages", () => {
    const source = meeting([
      "word ".repeat(250),
      "Обсуждаем запуск и проверяем результат. ".repeat(60),
      "Mixed обсуждение release readiness. ".repeat(60),
    ]);
    for (const seed of ["seed-one", "seed-two", "seed-three"]) {
      const plan = buildHistoricalIndexPlan(source, ids(seed), {
        ...policy, maximumEmbeddingTokens: 512,
      }, tokenizer);
      expect(plan.documents.length).toBeGreaterThan(5);
      for (const document of plan.documents) {
        expect(document.manifest.embeddingTokenLimit).toBe(72);
        expect(document.manifest.embeddingTokenEstimate)
          .toBe(tokenizer.countBodyTokens(document.embeddingText));
        expect(tokenizer.countTokens(infinityDocumentEmbeddingInput(
          document.title, document.embeddingText,
        ))).toBeLessThanOrEqual(128);
      }
    }
  });

  it("matches cooperative identities and preserves original source offsets and content", async () => {
    const source = meeting([
      "word ".repeat(94).trim(),
      "\u001cПРИВЕТ\u0085 Mixed 👩‍🚀 İ \ufeff ".repeat(35),
    ]);
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const prepared = await planner.prepareWindows(source, policy);
    const actual = buildHistoricalIndexPlanFromPreparedWindows(
      source, ids(), policy, prepared, new Sha256HistoricalReceiptDigest(),
    );
    expect(actual).toEqual(buildHistoricalIndexPlan(source, ids(), policy, tokenizer));
    expect(prepared.receipt.workerRevision).toBe("meeting-knowledge.exact-window-planner.v2");
    for (const turn of source.humanTurns) {
      const points = Array.from(turn.text);
      const covered = new Set<number>();
      for (const segment of prepared.windows.flatMap((window) => window.segments)
        .filter((candidate) => candidate.turnId === turn.turnId)) {
        expect(segment.text).toBe(points.slice(
          segment.sourceStartCodePoint, segment.sourceEndCodePoint,
        ).join(""));
        for (let index = segment.sourceStartCodePoint; index < segment.sourceEndCodePoint; index += 1) {
          covered.add(index);
        }
      }
      // Projection intentionally trims whitespace at partition boundaries.
      const omitted = points.filter((_, index) => !covered.has(index)).join("");
      expect(omitted.trim()).toBe("");
      expect(covered.size).toBeGreaterThan(0);
    }
  }, 30_000);

  it("rejects legacy worker revisions even when request and result receipts are recomputed", async () => {
    const source = meeting(["synthetic evidence"]);
    const planner = new CooperativeHistoricalIndexPlanner();
    active.push(planner);
    const prepared = await planner.prepareWindows(source, policy);
    const digest = new Sha256HistoricalReceiptDigest();
    expect(prepared.planningProfile.maximumInputTokens).toBe(128);
    expect(prepared.planningProfile.maximumBodyTokens).toBe(72);
    expect(prepared.planningProfile.digestSha256).toBe(digest.digestUtf8(
      canonicalHistoricalPlannerJson({
        identity: prepared.planningProfile.identity,
        maximumInputTokens: 128,
        maximumBodyTokens: 72,
      }),
    ));
    expect(() => buildHistoricalIndexPlanFromPreparedWindows(
      source, ids(), policy, prepared, digest,
    )).not.toThrow();
    const { receipt, ...result } = prepared;
    const legacy = {
      ...result,
      receipt: {
        ...receipt,
        requestSha256: digest.digestUtf8(canonicalHistoricalPlannerJson({ meeting: source, policy })),
        resultSha256: digest.digestUtf8(canonicalHistoricalPlannerJson(result)),
        workerRevision: "meeting-knowledge.exact-window-planner.v1",
      },
    };
    expect(() => buildHistoricalIndexPlanFromPreparedWindows(
      source, ids(), policy, legacy as typeof prepared, digest,
    )).toThrow(/receipt is invalid/u);
  });

  it("rejects overflowing input before SDK submission or actor projection", async () => {
    const plan = buildHistoricalIndexPlan(meeting(["short evidence"]), ids(), policy, tokenizer);
    const ingestDocument = vi.fn();
    const activeActorKey = vi.fn();
    const client = { documents: { ingestDocument } } as unknown as InfinityContextClient;
    const document = plan.documents[0]!;
    await expect(ingestHistoricalDocument(
      client, plan.topology,
      { ...document, embeddingText: "word ".repeat(150) },
      { activeActorKey }, new AbortController().signal,
    )).rejects.toThrow(/maximum/u);
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(activeActorKey).not.toHaveBeenCalled();
  });

  it("fails explicitly when complete coverage would require more than 500 blocks", () => {
    const source = meeting(Array.from({ length: 501 }, () => "word"));
    expect(() => buildHistoricalIndexPlan(source, ids(), {
      ...policy, maxTurnsPerBlock: 1, turnOverlap: 0,
    }, tokenizer)).toThrow();
  });
});
