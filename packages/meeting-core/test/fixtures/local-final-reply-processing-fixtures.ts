import {
  SelectFocusedEvidence,
  type AnswerPublicationPort,
  type FinalReplyRendererPort,
  type GroundedAnswerGenerationRequest,
  type FocusedEvidenceSelectorPort,
  type FocusedEvidenceSelectionResultV1,
  type GroundedAnswerGenerationResult,
  type GroundedAnswerGenerator,
  type LocalFinalReplyPolicy,
  type QuestionAdmissionCommitPort,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  authorizationPolicyVersion,
  fixedReplyText,
} from "../features/meeting-knowledge/local-final-reply-application-fixtures.test.js";

export const policy: LocalFinalReplyPolicy = { admission: { guildQuestionsPerHour: 100, jobTtlSeconds: 900,
    requesterQuestionsPerHour: 10 },
  answerMessageMaximumCharacters: 2_000, authorizationPolicyVersion,
  groundingSafety: {
    maximumRequestBytes: 100_000,
    modelContextTokens: 128_000,
    outputTokensReserved: 2_048,
    reasoningTokensReserved: 4_096,
    safeInputTokens: 100_000,
    tokenDriftReserve: 8_192,
  },
  jobLeaseSeconds: 60, maximumProviderAttempts: 2,
  policyVersion: "meeting-knowledge.focused-memory-final-reply.v2",
  retrieval: { maximumCandidates: 24, neighborTurns: 2 },
  retrievalAdmission: {
    compositeProfileFingerprint: "e".repeat(64),
    cutoverEpoch: "test-cutover-r1", infinityProfileFingerprint: "e".repeat(64),
    localProfileFingerprint: "f".repeat(64),
  },
};
export const renderer: FinalReplyRendererPort = {
  renderAnswer: ({ answer, evidence, maximumCharacters }) => {
    const evidenceById = new Map(evidence.map((item) => [item.evidenceId, item]));
    const content = answer.claims.map((claim) => [
      claim.text,
      ...claim.evidenceIds.map((evidenceId) =>
        evidenceById.get(evidenceId)?.turnId ?? "missing-evidence"
      ),
    ].join("\n")).join("\n\n");
    if (content.length > maximumCharacters) {
      throw new Error("synthetic rendered answer exceeded its bound");
    }
    return content;
  },
  renderFixed: ({ outcome }) => fixedReplyText[outcome],
};
export class AdmissionFake implements QuestionAdmissionCommitPort {
  commits: Parameters<QuestionAdmissionCommitPort["commit"]>[0][] = [];
  result: Awaited<ReturnType<QuestionAdmissionCommitPort["commit"]>> = {
    jobId: "question-1",
    status: "committed",
  };
  commit(input: Parameters<QuestionAdmissionCommitPort["commit"]>[0]) {
    this.commits.push(input);
    return Promise.resolve(this.result);
  }
  withdrawProjection(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

export class GeneratorFake implements GroundedAnswerGenerator {
  requests: GroundedAnswerGenerationRequest[] = [];
  generationCalls = 0;
  measurement = {
    inputTokens: 10_000,
    requestBytes: 40_000,
    runtimeProfile: "knowledge-answer-sol-medium-focused-v1",
  };
  result: GroundedAnswerGenerationResult = {
    answer: {
      claims: [{
        evidenceIds: ["evidence-000001", "evidence-000002"],
        text: "The corrected release day is Monday, replacing Friday.",
      }],
      locale: "en",
      status: "answered",
    },
    status: "completed",
  };
  measure(request: GroundedAnswerGenerationRequest) {
    this.requests.push(request);
    return Promise.resolve(this.measurement);
  }

  generate(): Promise<GroundedAnswerGenerationResult> {
    this.generationCalls += 1;
    return Promise.resolve(this.result);
  }
}

export class PublicationFake implements AnswerPublicationPort {
  cancellations: Parameters<AnswerPublicationPort["cancelBeforeRequest"]>[0][] = [];
  reservations: Parameters<AnswerPublicationPort["reserve"]>[0][] = [];
  sends: Parameters<AnswerPublicationPort["send"]>[0][] = [];
  deliveryResult: Awaited<ReturnType<AnswerPublicationPort["send"]>> = {
    externalReceipt: "answer-message-1", status: "delivered",
  };

  reserve(input: Parameters<AnswerPublicationPort["reserve"]>[0]) {
    this.reservations.push(input);
    return Promise.resolve({ effectId: input.binding.questionId, status: "reserved" } as const);
  }

  send(input: Parameters<AnswerPublicationPort["send"]>[0]) {
    this.sends.push(input);
    return Promise.resolve(this.deliveryResult);
  }

  cancelBeforeRequest(input: Parameters<AnswerPublicationPort["cancelBeforeRequest"]>[0]) {
    this.cancellations.push(input);
    return Promise.resolve(true);
  }
}

export function focusedSelector(
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
