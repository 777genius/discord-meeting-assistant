import { exactRecord } from "./canonical.js";
import { verifySpendReservations } from "./execution.js";
import { assertObservedRelease, verifyReleaseRoot } from "./release.js";
import { loadProductionAuthority, readProductionArray, readProductionJson, readProductionText,
  type ProductionOperatorConfiguration } from "./production-inputs.js";
import type { QualityCampaignProductionPorts } from "./production-ports.js";

const AUTHORITY_CALL_DEADLINE_MS = 120_000;

export async function loadPinnedProductionRelease(config: ProductionOperatorConfiguration,
  ports: QualityCampaignProductionPorts) {
  const authorityPublicKeyPem = await readProductionText(config.releaseAuthorityPublicKeyPath,
    "release authority public key");
  const document = await readProductionJson(config.releaseRootPath, "release root");
  const record = exactRecord(document, ["payload", "signatureBase64", "signerKeyId"],
    "release root");
  const verified = verifyReleaseRoot({ authorityKeyId: String(record.signerKeyId),
    authorityPublicKeyPem, document });
  const pinned = { authorityKeyId: verified.authorityKeyId, authorityPublicKeyPem, document,
    releaseRootSha256: verified.releaseRootSha256 };
  const deadlineEpochMs = ports.clock.nowEpochMs() + AUTHORITY_CALL_DEADLINE_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("release observation deadline exceeded")),
    AUTHORITY_CALL_DEADLINE_MS);
  try {assertObservedRelease(verified.release, await ports.release.observe({ deadlineEpochMs,
    signal: controller.signal }));} finally {clearTimeout(timeout);}
  return Object.freeze({ pinned, verified });
}

export async function loadVerifiedProductionSpend(input: { readonly campaignRootSha256: string;
  readonly config: ProductionOperatorConfiguration; readonly nowEpochMs: number;
  readonly releaseRootSha256: string }) {
  const authority = await loadProductionAuthority(input.config.spendAuthorityPath);
  const documents = await readProductionArray(input.config.spendReservationsPath,
    "spend reservations");
  const reservations = verifySpendReservations({ authorityKeyId: authority.keyId,
    authorityPublicKeyPem: authority.publicKeyPem, campaignRootSha256: input.campaignRootSha256,
    nowEpochMs: input.nowEpochMs, releaseRootSha256: input.releaseRootSha256,
    reservations: documents });
  return Object.freeze({ authority, documents, reservations });
}
