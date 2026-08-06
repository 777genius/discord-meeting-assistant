import { describe, expect, it } from "vitest";

import { verifySummarySemantics } from "../src/e2e-evidence-summary-verification.js";
import type {
  FixtureManifestV1,
  RetainedE2eEvidence,
} from "../src/e2e-evidence.js";

describe("strict E2E summary semantics", () => {
  it("rejects dropped deliverables, unsupported evidence, and extra partial actions", () => {
    const dropped = evidence();
    dropped.summary.actionItems[0]!.text = "Проверить Redis queue";
    expect(codes(dropped)).toContain("ACTION_SEMANTICS_MISSING");

    const unsupported = evidence();
    unsupported.summary.actionItems[0]!.evidenceTurnIds = ["turn-a"];
    expect(codes(unsupported)).toEqual(expect.arrayContaining([
      "ACTION_EVIDENCE_MISSING",
      "ACTION_OWNER_EVIDENCE_MISSING",
    ]));

    const extra = evidence();
    extra.summary.actionItems.push({
      actionItemId: "action-extra",
      deadline: null,
      evidenceTurnIds: ["turn-a"],
      ownerSpeakerId: null,
      text: "Piqer B проверить Discord thread",
    });
    expect(codes(extra)).toContain("ACTION_COUNT_MISMATCH");
  });
});

function codes(value: RetainedE2eEvidence): string[] {
  const failures: string[] = [];
  verifySummarySemantics(manifest(), value, (code) => failures.push(code));
  return failures;
}

function manifest(): FixtureManifestV1 {
  return {
    summaryExpectations: {
      actionItems: [{
        deadline: "до 7 августа 2026 года",
        ownerSpeakerId: "speaker-b",
        requiredTerms: ["Redis queue", "idempotency key", "Discord thread"],
      }],
      decisionTerms: ["пятницу"],
      topicTerms: ["Meeting Platform"],
    },
  } as FixtureManifestV1;
}

function evidence(): RetainedE2eEvidence {
  return {
    summary: {
      actionItems: [{
        actionItemId: "action-1",
        deadline: "до 7 августа 2026 года",
        evidenceTurnIds: ["turn-b", "turn-b-deadline"],
        ownerSpeakerId: "speaker-b",
        text: "Проверить Redis queue и idempotency key, результат оставить в Discord thread",
      }],
      decisions: [{ decisionId: "decision-1", evidenceTurnIds: ["turn-a"], text: "Выпустить в пятницу" }],
      topics: [{ evidenceTurnIds: ["turn-a"], points: ["Meeting Platform"], title: "Pipeline" }],
    },
    transcript: {
      turns: [
        { speakerId: "speaker-a", text: "Meeting Platform, выпуск в пятницу", turnId: "turn-a" },
        { speakerId: "speaker-b", text: "Я проверю Redis queue и idempotency key", turnId: "turn-b" },
        { speakerId: "speaker-b", text: "до 7 августа 2026 года, результат в Discord thread", turnId: "turn-b-deadline" },
      ],
    },
  } as RetainedE2eEvidence;
}
