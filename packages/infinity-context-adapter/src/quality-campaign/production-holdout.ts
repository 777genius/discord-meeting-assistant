import type { CampaignQuestion } from "./admission.js";
import { admitIsolatedHoldout, createHoldoutReport, type FrozenMainInputProof,
  type HoldoutAuthorization } from "./holdout.js";
import { sha256 } from "./canonical.js";
import type { QualityCampaignRelease } from "./release.js";
import { executeHoldoutSchedule } from "./production-scheduler.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";

export async function executeIsolatedProductionHoldout(input: {
  readonly authorization: HoldoutAuthorization; readonly clock: CampaignClockPort;
  readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly holdoutLocatorDigests: readonly string[]; readonly journalRoot: string;
  readonly main: FrozenMainInputProof; readonly ports: CampaignProviderPorts;
  readonly questions: readonly CampaignQuestion[]; readonly release: QualityCampaignRelease;
}): Promise<Readonly<Record<string, unknown>>> {
  const admitted = admitIsolatedHoldout({ authorization: input.authorization,
    holdoutLocatorDigests: input.holdoutLocatorDigests, main: input.main,
    questions: input.questions });
  const scheduled = await executeHoldoutSchedule({ binding: { campaignRootSha256:
    input.authorization.holdoutRootSha256, release: input.release,
    releaseRootSha256: input.authorization.mainReleaseRootSha256,
    spendReservationSha256: input.authorization.authorizationSha256 }, clock: input.clock,
  concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  journalRoot: input.journalRoot, ports: input.ports, questions: admitted.questions });
  if (scheduled.outcomeUnknown || scheduled.completedOutcomes !== 30) {
    throw new Error("holdout execution is incomplete or outcome-unknown");
  }
  return createHoldoutReport({ cleanupReceiptSha256: sha256({ pending:
    "separate_holdout_cleanup_required" }), holdoutRootSha256:
    input.authorization.holdoutRootSha256, outcomeCount: scheduled.completedOutcomes,
  reportMetricsSha256: sha256({ terminalAttemptIds: scheduled.terminalAttemptIds }) });
}
