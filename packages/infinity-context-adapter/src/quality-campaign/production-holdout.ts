import { admitIsolatedHoldout } from "./holdout.js";
import { sha256 } from "./canonical.js";
import { type PinnedReleaseDocument, QualityCampaignAuthorityPolicy } from "./release.js";
import { executeHoldoutSchedule } from "./production-scheduler.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";

export async function executeIsolatedProductionHoldout(input: {
  readonly admission: Parameters<typeof admitIsolatedHoldout>[1]; readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly journalRoot: string; readonly ports: CampaignProviderPorts;
  readonly provider: string; readonly release: PinnedReleaseDocument;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly spendReservationSha256ByRepetition: Readonly<Record<1 | 2 | 3, string>>;
  readonly spendReservations: readonly [unknown, unknown, unknown];
}): Promise<Readonly<Record<string, unknown>>> {
  const admitted = admitIsolatedHoldout(input.policy, input.admission);
  const scheduled = await executeHoldoutSchedule({ binding: { campaignRootSha256:
    admitted.authorization.holdoutRootSha256, release: input.release,
    policy: input.policy, releaseRootSha256: admitted.authorization.mainReleaseRootSha256 },
  clock: input.clock,
  concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  journalRoot: input.journalRoot, ports: input.ports, questions: admitted.questions,
  spendByRepetition: { 1: { provider: input.provider, reservation: input.spendReservations[0],
    reservationSha256: input.spendReservationSha256ByRepetition[1] },
  2: { provider: input.provider, reservation: input.spendReservations[1],
    reservationSha256: input.spendReservationSha256ByRepetition[2] },
  3: { provider: input.provider, reservation: input.spendReservations[2],
    reservationSha256: input.spendReservationSha256ByRepetition[3] } } });
  if (scheduled.outcomeUnknown) {return Object.freeze({ outcomeUnknown: true });}
  if (scheduled.completedOutcomes !== 90) {throw new Error("holdout execution is incomplete");}
  return Object.freeze({ affectsMainQualification: false,
    holdoutQuestionSetSha256: admitted.holdoutQuestionSetSha256,
    holdoutRootSha256: admitted.authorization.holdoutRootSha256,
    outcomeCount: scheduled.completedOutcomes,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_execution.v1",
    terminalAttemptSetSha256: sha256(scheduled.terminalAttemptIds) });
}
