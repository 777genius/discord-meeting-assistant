import type { CampaignQuestion } from "./admission.js";
import { canonicalJson, sha256 } from "./canonical.js";
import { attemptIdentity } from "./execution.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";

interface ExecutionEvidenceInput {
  readonly campaignRootSha256: string; readonly deadlineEpochMs: number;
  readonly ports: Pick<QualityCampaignProductionPorts, "evidence" | "evidenceCustody" |
    "mainCanonicalEvidence">; readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}

export async function loadMainExecutionEvidence(input: ExecutionEvidenceInput) {
  const externalEvidence = await loadExecutionEvidence(input, "main");
  const attempts = externalEvidence.outcomes.map((outcome) => {
    const capability = terminal(outcome, "capability");
    const retrieval = terminal(outcome, "retrieval");
    return Object.freeze({ answerAbstained: outcome.answerAbstained,
      attemptId: outcome.attemptId, campaignRootSha256: outcome.campaignRootSha256,
      capabilityRequestSha256: capability.requestDigestSha256,
      capabilityResponseSha256: capability.resultEnvelopeDigestSha256,
      citationLocatorIds: outcome.citationLocatorDigests,
      evidenceLocatorIds: outcome.evidenceLocatorDigests,
      evidenceTurnIds: outcome.evidenceTurnIds,
      rankedLocatorIds: outcome.rankedLocatorDigests,
      retrievalLatencyUs: outcome.retrievalLatencyUs,
      retrievalRequestSha256: retrieval.requestDigestSha256,
      retrievalResponseSha256: retrieval.resultEnvelopeDigestSha256 });
  });
  const localEvidence = await input.ports.mainCanonicalEvidence.verify({ attempts,
    campaignRootSha256: input.campaignRootSha256 });
  return Object.freeze({ externalEvidence, localEvidence });
}

export async function loadHoldoutExecutionEvidence(input: ExecutionEvidenceInput) {
  return await loadExecutionEvidence(input, "holdout");
}

function terminal(outcome: Awaited<ReturnType<typeof loadExecutionEvidence>>["outcomes"][number],
  kind: "capability" | "retrieval") {
  const matches = outcome.terminalChain.filter((item) => item.callKind === kind);
  if (matches.length !== 1) {throw new Error(`external ${kind} terminal evidence is incomplete`);}
  return matches[0]!;
}

async function loadExecutionEvidence(input: ExecutionEvidenceInput, kind: "holdout" | "main") {
  const attemptIds = answerAttemptIds(input);
  return await withEvidenceContext(input.deadlineEpochMs, async (context) => {
    const delivery = await input.ports.evidence[kind]({ attemptIds, campaignRootSha256:
      input.campaignRootSha256, context, executionChainSha256: sha256({ attemptIds,
        campaignRootSha256: input.campaignRootSha256,
        schemaVersion: "meeting_knowledge.canonical_quality_execution_set.v1" }) });
    const evidence = await input.ports.evidenceCustody.open({ attemptIds, campaignRootSha256:
      input.campaignRootSha256, delivery, kind, releaseRootSha256: input.releaseRootSha256 });
    assertExternalExecutionEvidence(input, attemptIds, evidence);
    return evidence;
  });
}

function assertExternalExecutionEvidence(input: ExecutionEvidenceInput,
  attemptIds: readonly string[], evidence: Awaited<ReturnType<
    QualityCampaignProductionPorts["evidenceCustody"]["open"]>>): void {
  const expected = new Map(([1, 2, 3] as const).flatMap((repetition) =>
    input.questions.map((question) => {
      const identity = attemptIdentity({ callKind: "answer", callOrdinal: 0,
        campaignRootSha256: input.campaignRootSha256,
        questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
        releaseRootSha256: input.releaseRootSha256, repetition,
        spendReservationSha256: input.spendReservationSha256ByRepetition[repetition] });
      return [identity.attemptId, identity] as const;
    })));
  if (expected.size !== attemptIds.length || evidence.outcomes.length !== attemptIds.length ||
    new Set(evidence.outcomes.map(({ attemptId }) => attemptId)).size !== evidence.outcomes.length ||
    evidence.outcomes.some((outcome) => {
      const identity = expected.get(outcome.attemptId);
      return identity === undefined || canonicalJson(identity) !== canonicalJson(outcome.identity) ||
        outcome.campaignRootSha256 !== input.campaignRootSha256;
    })) {
    throw new Error("externally authenticated evidence differs from the canonical execution set");
  }
}

function answerAttemptIds(input: ExecutionEvidenceInput): readonly string[] {
  return ([1, 2, 3] as const).flatMap((repetition) => input.questions.map((question) =>
    attemptIdentity({ callKind: "answer", callOrdinal: 0,
      campaignRootSha256: input.campaignRootSha256,
      questionDigestSha256: question.questionDigestSha256, questionId: question.questionId,
      releaseRootSha256: input.releaseRootSha256, repetition,
      spendReservationSha256: input.spendReservationSha256ByRepetition[repetition] }).attemptId));
}

async function withEvidenceContext<T>(deadlineEpochMs: number,
  task: (context: { readonly deadlineEpochMs: number; readonly signal: AbortSignal }) => Promise<T>):
Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {controller.abort(new Error("evidence call deadline exceeded"));},
    Math.max(0, deadlineEpochMs - Date.now()));
  try {return await task({ deadlineEpochMs, signal: controller.signal });}
  finally {clearTimeout(timeout);}
}
