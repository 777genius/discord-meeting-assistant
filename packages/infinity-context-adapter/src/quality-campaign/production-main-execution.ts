import type { CampaignQuestion } from "./campaign-admission-policy.js";
import type { QualityCampaignAuthorityPolicy, QualityCampaignRelease } from "./release.js";
import type { VerifiedSpendReservation } from "./execution.js";
import type { QualificationExecutionPacket, QualificationQuestionExecutorFactoryPort } from
  "./execute-admitted-qualification-question.js";
import type { CampaignClockPort } from "./production-ports.js";
import { executeCanonicalMainCampaignSchedule } from "./production-canonical-scheduler.js";

export async function executeProductionMain(input: { readonly campaignRootSha256: string;
  readonly clock: CampaignClockPort; readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly executionPackets: readonly QualificationExecutionPacket[];
  readonly executorFactory: QualificationQuestionExecutorFactoryPort;
  readonly journalRoot: string; readonly policy: QualityCampaignAuthorityPolicy;
  readonly questions: readonly CampaignQuestion[]; readonly release: QualityCampaignRelease;
  readonly releaseRootSha256: string;
  readonly reservations: readonly VerifiedSpendReservation[] }) {
  return await executeCanonicalMainCampaignSchedule({ campaignRootSha256:
    input.campaignRootSha256,
  clock: input.clock, concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  executionPackets: input.executionPackets, executorFactory: input.executorFactory,
  journalRoot: input.journalRoot, policy: input.policy, questions: input.questions,
  release: input.release, releaseRootSha256: input.releaseRootSha256,
  reservations: input.reservations,
  spendReservationSha256ByRepetition: {
    1: input.reservations[0]!.spendReservationSha256,
    2: input.reservations[1]!.spendReservationSha256,
    3: input.reservations[2]!.spendReservationSha256 } });
}
