import type { SignedLegacyHistoricalReceiptV1 } from "../../domain/legacy-historical-admission.js";

/** Trust is independently configured; a receipt never carries its public key. */
export interface LegacyHistoricalReceiptVerifierPort {
  verify(receipt: unknown): SignedLegacyHistoricalReceiptV1;
}
export interface LegacyHistoricalAdmissionStorePort {
  accept(input: {
    readonly receipt: unknown;
    readonly savedSourceJson: string;
  }): Promise<"accepted" | "replayed">;
}
