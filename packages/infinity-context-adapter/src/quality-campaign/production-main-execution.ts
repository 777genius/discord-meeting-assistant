import type { CampaignQuestion } from "./admission.js";
import type { PinnedReleaseDocument } from "./release.js";
import type { VerifiedSpendReservation } from "./spend.js";
import type { CampaignClockPort, CampaignProviderPorts } from "./production-ports.js";
import { executeMainCampaignSchedule } from "./production-scheduler.js";

export async function executeProductionMain(input: { readonly campaignRootSha256: string;
  readonly clock: CampaignClockPort; readonly concurrency: number; readonly deadlineEpochMs: number;
  readonly journalRoot: string; readonly ports: CampaignProviderPorts;
  readonly questions: readonly CampaignQuestion[]; readonly release: PinnedReleaseDocument;
  readonly spendAuthority: { readonly keyId: string; readonly publicKeyPem: string };
  readonly spendDocuments: readonly unknown[];
  readonly reservations: readonly VerifiedSpendReservation[] }) {
  return await executeMainCampaignSchedule({ binding: { campaignRootSha256:
    input.campaignRootSha256, release: input.release,
    releaseRootSha256: input.release.releaseRootSha256, spendAuthority: input.spendAuthority },
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
