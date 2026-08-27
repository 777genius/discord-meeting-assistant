import type { CampaignQuestion } from "./admission.js";
import { sha256 } from "./canonical.js";
import { attemptIdentity } from "./execution.js";
import { bindExactExecutionEvidence } from "./production-evidence.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";
import { loadScheduledExactOutcomes } from "./production-scheduler.js";
import type { QualityCampaignAuthorityPolicy } from "./release.js";

interface ExecutionEvidenceInput {
  readonly campaignRootSha256: string; readonly deadlineEpochMs: number;
  readonly journalRoot: string; readonly policy: QualityCampaignAuthorityPolicy;
  readonly ports: QualityCampaignProductionPorts; readonly questions: readonly CampaignQuestion[];
  readonly releaseRootSha256: string;
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
}

export async function loadMainExecutionEvidence(input: ExecutionEvidenceInput) {
  return await loadExecutionEvidence(input, "main");
}

export async function loadHoldoutExecutionEvidence(input: ExecutionEvidenceInput) {
  return await loadExecutionEvidence(input, "holdout");
}

async function loadExecutionEvidence(input: ExecutionEvidenceInput, kind: "holdout" | "main") {
  const attemptIds = answerAttemptIds(input);
  const executions = await loadScheduledExactOutcomes({ campaignRootSha256:
    input.campaignRootSha256, journalRoot: input.journalRoot, policy: input.policy,
    questions: input.questions, releaseRootSha256: input.releaseRootSha256,
    ...(kind === "holdout" ? { resultAuthorityRole: "holdout_provider_result" as const } : {}),
    spendReservationSha256ByRepetition: input.spendReservationSha256ByRepetition });
  return await withEvidenceContext(input.deadlineEpochMs, async (context) => {
    const delivery = await input.ports.evidence[kind]({ attemptIds, campaignRootSha256:
      input.campaignRootSha256, context, executionChainSha256: sha256(executions) });
    const evidence = await input.ports.evidenceCustody.open({ attemptIds, campaignRootSha256:
      input.campaignRootSha256, delivery, kind, releaseRootSha256: input.releaseRootSha256 });
    return bindExactExecutionEvidence(evidence, executions);
  });
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
  const timeout = setTimeout(() => controller.abort(new Error("evidence call deadline exceeded")),
    Math.max(0, deadlineEpochMs - Date.now()));
  try {return await task({ deadlineEpochMs, signal: controller.signal });}
  finally {clearTimeout(timeout);}
}
