import { admitIsolatedHoldout } from "./holdout.js";
import { sha256 } from "./canonical.js";
import type { PinnedReleaseDocument } from "./release.js";
import { executeHoldoutSchedule } from "./production-scheduler.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";

export async function executeIsolatedProductionHoldout(input: {
  readonly admission: Parameters<typeof admitIsolatedHoldout>[0]; readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly journalRoot: string; readonly ports: CampaignProviderPorts;
  readonly provider: string; readonly release: PinnedReleaseDocument;
  readonly spendAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly spendReservation: unknown; readonly spendReservationSha256: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const admitted = admitIsolatedHoldout(input.admission);
  const scheduled = await executeHoldoutSchedule({ binding: { campaignRootSha256:
    admitted.authorization.holdoutRootSha256, provider: input.provider, release: input.release,
    releaseRootSha256: admitted.authorization.mainReleaseRootSha256,
    spendAuthority: input.spendAuthority, spendReservation: input.spendReservation,
    spendReservationSha256: input.spendReservationSha256 }, clock: input.clock,
  concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  journalRoot: input.journalRoot, ports: input.ports, questions: admitted.questions });
  if (scheduled.outcomeUnknown) {return Object.freeze({ outcomeUnknown: true });}
  if (scheduled.completedOutcomes !== 30) {throw new Error("holdout execution is incomplete");}
  return Object.freeze({ affectsMainQualification: false,
    holdoutQuestionSetSha256: admitted.holdoutQuestionSetSha256,
    holdoutRootSha256: admitted.authorization.holdoutRootSha256,
    outcomeCount: scheduled.completedOutcomes,
    schemaVersion: "meeting_knowledge.semantic_quality_holdout_execution.v1",
    terminalAttemptSetSha256: sha256(scheduled.terminalAttemptIds) });
}
