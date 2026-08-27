import { exactRecord } from "./canonical.js";
import { verifySpendReservation } from "./execution.js";
import { assertObservedRelease, type QualityCampaignAuthorityPolicy,
  verifyReleaseRoot } from "./release.js";
import { readProductionArray, readProductionJson,
  type ProductionOperatorConfiguration } from "./production-inputs.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";

const AUTHORITY_CALL_DEADLINE_MS = 120_000;

export async function withProductionCallContext<T>(sharedDeadlineEpochMs: number,
  task: (context: import("./production-ports.js").CampaignCallContext) => Promise<T>): Promise<T> {
  const deadlineEpochMs = Math.min(sharedDeadlineEpochMs, Date.now() + AUTHORITY_CALL_DEADLINE_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => {controller.abort(
    new Error("production authority deadline exceeded"));},
  Math.max(0, deadlineEpochMs - Date.now()));
  try {return await task({ deadlineEpochMs, signal: controller.signal });}
  finally {clearTimeout(timeout);}
}

export async function loadPinnedProductionRelease(policy: QualityCampaignAuthorityPolicy,
  config: ProductionOperatorConfiguration,
  ports: QualityCampaignProductionPorts) {
  const document = await readProductionJson(config.releaseRootPath, "release root");
  const record = exactRecord(document, ["payload", "signatureBase64", "signerKeyId"],
    "release root");
  const verified = verifyReleaseRoot(policy, { authorityKeyId: String(record.signerKeyId),
    document });
  const pinned = { authorityKeyId: verified.authorityKeyId, document,
    releaseRootSha256: verified.releaseRootSha256 };
  const deadlineEpochMs = ports.clock.nowEpochMs() + AUTHORITY_CALL_DEADLINE_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => {controller.abort(new Error("release observation deadline exceeded"));},
    AUTHORITY_CALL_DEADLINE_MS);
  try {assertObservedRelease(verified.release, await ports.release.observe({ deadlineEpochMs,
    signal: controller.signal }));} finally {clearTimeout(timeout);}
  return Object.freeze({ pinned, verified });
}

export async function loadVerifiedProductionSpend(policy: QualityCampaignAuthorityPolicy,
  input: { readonly campaignRootSha256: string;
  readonly config: ProductionOperatorConfiguration; readonly nowEpochMs: number;
  readonly releaseRootSha256: string }) {
  const documents = await readProductionArray(input.config.spendReservationsPath,
    "spend reservations");
  if (documents.length !== 3) {
    throw new Error("production campaign requires three signed spend reservations");
  }
  const reservations = ([1, 2, 3] as const).map((expectedRepetition, index) =>
    verifySpendReservation(policy, { campaignRootSha256: input.campaignRootSha256,
      expectedRepetition, nowEpochMs: input.nowEpochMs,
      releaseRootSha256: input.releaseRootSha256, reservation: documents[index] }));
  if (new Set(reservations.map(({ spendReservationSha256 }) =>
    spendReservationSha256)).size !== 3) {
    throw new Error("production spend reservations are not independently bound");
  }
  return Object.freeze({ documents, reservations });
}
