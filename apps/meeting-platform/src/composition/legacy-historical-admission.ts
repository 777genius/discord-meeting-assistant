import { acceptLegacyHistoricalAdmission, PinnedLegacyHistoricalReceiptVerifier,
  type LegacyHistoricalPublicTrustV1 } from "@discord-meeting/postgres-adapter";
import type { Pool } from "pg";

/** Narrow operator command. Receipts and public trust arrive from separate custody. */
export function runLegacyHistoricalAdmissionCommand(input: {
  readonly pool: Pool;
  readonly receipt: unknown;
  readonly savedSourceJson: string;
  readonly pinnedPublicTrust: readonly LegacyHistoricalPublicTrustV1[];
}): Promise<"accepted" | "replayed"> {
  return acceptLegacyHistoricalAdmission({ pool: input.pool, receipt: input.receipt,
    savedSourceJson: input.savedSourceJson,
    verifier: new PinnedLegacyHistoricalReceiptVerifier(input.pinnedPublicTrust) });
}
