import type { CampaignQuestion } from "./campaign-admission-policy.js";
import type { PinnedReleaseDocument, QualityCampaignAuthorityPolicy } from "./release.js";
import type { VerifiedSpendReservation } from "./execution.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";
import { executeMainCampaignSchedule } from "./production-scheduler.js";

export async function executeProductionMain(input: { readonly campaignRootSha256: string;
  readonly clock: CampaignClockPort; readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly journalRoot: string; readonly ports: CampaignProviderPorts;
  readonly policy: QualityCampaignAuthorityPolicy;
  readonly questions: readonly CampaignQuestion[]; readonly release: PinnedReleaseDocument;
  readonly spendDocuments: readonly unknown[];
  readonly reservations: readonly VerifiedSpendReservation[] }) {
  return await executeMainCampaignSchedule({ binding: { campaignRootSha256:
    input.campaignRootSha256, release: input.release,
    policy: input.policy, releaseRootSha256: input.release.releaseRootSha256 },
  clock: input.clock, concurrency: input.concurrency, deadlineEpochMs: input.deadlineEpochMs,
  journalRoot: input.journalRoot, ports: input.ports, questions: input.questions,
  spendByRepetition: {
    1: { provider: input.reservations[0]!.payload.provider, reservation: input.spendDocuments[0],
      reservationSha256: input.reservations[0]!.spendReservationSha256 },
    2: { provider: input.reservations[1]!.payload.provider, reservation: input.spendDocuments[1],
      reservationSha256: input.reservations[1]!.spendReservationSha256 },
    3: { provider: input.reservations[2]!.payload.provider, reservation: input.spendDocuments[2],
      reservationSha256: input.reservations[2]!.spendReservationSha256 } } });
}
