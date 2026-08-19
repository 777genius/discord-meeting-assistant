import { describe, expect, it } from "vitest";

import {
  ProcessFinalReplyJob,
  SelectFocusedEvidence,
  type AnswerPublicationPort,
  type CanonicalFinalReplyEvidenceResult,
  type FinalReplyRendererPort,
  type FocusedEvidenceSelectionResultV1,
  type FocusedEvidenceSelectorPort,
  type GroundedAnswerGenerationRequest,
  type GroundedAnswerGenerationResult,
  type GroundedAnswerGenerator,
  type LocalFinalReplyPolicy,
} from "@discord-meeting/meeting-core/meeting-knowledge";

import {
  authorizationPolicyVersion,
  authority,
  AuthorizationFake,
  binding,
  EvidenceFake,
  MemoryFake,
  references,
  selectedTurns,
} from "./local-final-reply-application-fixtures.test.js";
import { QuestionJobStoreFake } from "./question-job-store.fake.test.js";

const policy: LocalFinalReplyPolicy = {
  admission: {
    guildQuestionsPerHour: 100,
    jobTtlSeconds: 900,
    requesterQuestionsPerHour: 10,
  },
  answerMessageMaximumCharacters: 2_000,
  authorizationPolicyVersion,
  groundingSafety: {
    maximumRequestBytes: 100_000,
    modelContextTokens: 128_000,
    outputTokensReserved: 2_048,
    reasoningTokensReserved: 4_096,
    safeInputTokens: 100_000,
    tokenDriftReserve: 8_192,
  },
  jobLeaseSeconds: 60,
  maximumProviderAttempts: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
  retrieval: { maximumCandidates: 24, neighborTurns: 2 },
};

const renderer: FinalReplyRendererPort = {
  renderAnswer: ({ answer, evidence }) => {
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    return answer.claims.map((claim) => [
      claim.text,
      ...claim.evidenceIds.map((id) => evidenceById.get(id)?.turnId ?? "missing"),
    ].join("\n")).join("\n\n");
  },
  renderFixed: ({ outcome }) => outcome,
};

class GeneratorFake implements GroundedAnswerGenerator {
  public generationCalls = 0;
  public requests: GroundedAnswerGenerationRequest[] = [];
  public result: GroundedAnswerGenerationResult = {
    answer: {
      claims: [{
        evidenceIds: ["evidence-000001", "evidence-000002"],
        text: "The corrected release day is Monday.",
      }],
      locale: "en",
      status: "answered",
    },
    status: "completed",
  };

  public measure(request: GroundedAnswerGenerationRequest) {
    this.requests.push(request);
    return Promise.resolve({
      inputTokens: 10_000,
      requestBytes: 40_000,
      runtimeProfile: "knowledge-answer-sol-medium-focused-v1",
    });
  }

  public generate(): Promise<GroundedAnswerGenerationResult> {
    this.generationCalls += 1;
    return Promise.resolve(this.result);
  }
}

class PublicationFake implements AnswerPublicationPort {
  public reserve(input: Parameters<AnswerPublicationPort["reserve"]>[0]) {
    return Promise.resolve({
      effectId: input.binding.questionId,
      status: "reserved",
    } as const);
  }

  public send() {
    return Promise.resolve({
      externalReceipt: "answer-message-1",
      status: "delivered",
    } as const);
  }

  public cancelBeforeRequest() {
    return Promise.resolve(true);
  }
}

function focusedSelector(
  result?: FocusedEvidenceSelectionResultV1,
  onSelect: () => void = () => {},
) {
  const provider: FocusedEvidenceSelectorPort = {
    profile: "focused-selector-test.v1",
    select: ({ candidates }) => {
      onSelect();
      return Promise.resolve(result ?? {
        schemaVersion: 1,
        selectedCandidateIds: candidates.slice(0, 2).map(({ candidateId }) =>
          candidateId
        ),
        status: "selected",
      });
    },
  };
  return new SelectFocusedEvidence(provider, () => {}, () => 1);
}

function processingFixture(selector = focusedSelector()) {
  const evidence = new EvidenceFake();
  const jobs = new QuestionJobStoreFake({
    answerCandidate: null,
    attempts: 0,
    binding: binding(),
    generation: 1,
    groundingPlan: null,
    jobId: "question-1",
    questionText: "When is the corrected release day?",
    state: "running",
  });
  const generator = new GeneratorFake();
  const processor = new ProcessFinalReplyJob({
    answerPublication: new PublicationFake(),
    authorization: new AuthorizationFake(),
    evidence,
    generator,
    jobs,
    memory: new MemoryFake(),
    policy,
    selector,
    renderer,
    workerId: "worker-1",
  });
  return { evidence, generator, jobs, processor };
}

describe("post-selector evidence rehydration", () => {
  it("rejects reordered initial hydration before selection or generation", async () => {
    let selectorCalls = 0;
    const selector = focusedSelector(undefined, () => {
      selectorCalls += 1;
    });
    const fixture = processingFixture(selector);
    fixture.evidence.hydrated = {
      binding: authority,
      status: "current",
      turns: selectedTurns.toReversed(),
    };

    await expect(fixture.processor.executeOnce()).resolves.toMatchObject({
      outcome: "unavailable",
      status: "settled",
    });
    expect(selectorCalls).toBe(0);
    expect(fixture.jobs.providerReservations).toEqual([]);
    expect(fixture.generator.requests).toEqual([]);
    expect(fixture.generator.generationCalls).toBe(0);
  });

  it("reserves the shared provider attempt before billed evidence selection", async () => {
    let fixture: ReturnType<typeof processingFixture> | undefined;
    let reservationsSeenBySelector = -1;
    const selector = focusedSelector(undefined, () => {
      reservationsSeenBySelector = fixture?.jobs.providerReservations.length ?? -1;
    });
    fixture = processingFixture(selector);

    await expect(fixture.processor.executeOnce()).resolves.toMatchObject({
      outcome: "answered",
    });
    expect(reservationsSeenBySelector).toBe(1);
    expect(fixture.jobs.providerReservations).toHaveLength(1);
    expect(fixture.generator.requests[0]?.attemptId).toBe(
      fixture.jobs.providerReservations[0]?.attemptId,
    );
  });

  it("rehydrates only the exact selected references after semantic selection", async () => {
    const selector = focusedSelector({
      schemaVersion: 1,
      selectedCandidateIds: ["candidate-000002"],
      status: "selected",
    });
    const { evidence, generator, processor } = processingFixture(selector);
    generator.result = {
      answer: {
        claims: [{
          evidenceIds: ["evidence-000001"],
          text: "The corrected release day is Monday.",
        }],
        locale: "en",
        status: "answered",
      },
      status: "completed",
    };
    evidence.hydrated = {
      binding: authority,
      status: "current",
      turns: [selectedTurns[1]!],
    };
    const originalRehydrate = evidence.rehydrateSelectedEvidence.bind(evidence);
    let calls = 0;
    evidence.rehydrateSelectedEvidence = (questionBinding, selectedReferences) => {
      calls += 1;
      if (calls === 1) {
        evidence.references.push(selectedReferences);
        return Promise.resolve({
          binding: authority,
          status: "current" as const,
          turns: selectedTurns,
        });
      }
      return originalRehydrate(questionBinding, selectedReferences);
    };

    await expect(processor.executeOnce()).resolves.toMatchObject({ outcome: "answered" });
    expect(evidence.references[1]).toEqual([references[1]]);
    expect(generator.requests[0]?.plan.evidence.map(({ turnId }) => turnId))
      .toEqual(["turn-correction"]);
  });

  it.each([
    ["stale status", { status: "stale" }, "stale_binding"],
    ["current authority drift", {
      binding: { ...authority, meetingRevision: authority.meetingRevision + 1 },
      status: "current",
      turns: selectedTurns,
    }, "stale_binding"],
    ["changed selected order", {
      binding: authority,
      status: "current",
      turns: selectedTurns.toReversed(),
    }, "unavailable"],
  ] satisfies readonly [
    string,
    CanonicalFinalReplyEvidenceResult,
    "stale_binding" | "unavailable",
  ][])("fails closed for %s after selection", async (_label, hydrated, outcome) => {
    let fixture: ReturnType<typeof processingFixture> | undefined;
    const selector = focusedSelector(undefined, () => {
      if (fixture !== undefined) {
        fixture.evidence.hydrated = hydrated;
      }
    });
    fixture = processingFixture(selector);

    await expect(fixture.processor.executeOnce()).resolves.toMatchObject({
      outcome,
      status: "settled",
    });
    expect(fixture.evidence.references).toEqual([references, references]);
    expect(fixture.generator.requests).toEqual([]);
    expect(fixture.generator.generationCalls).toBe(0);
  });
});
