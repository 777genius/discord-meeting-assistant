import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { decodeSignedLegacyHistoricalReceipt, LEGACY_HISTORICAL_SIGNING_CONTEXT,
  legacyHistoricalCanonicalJson, type LegacyHistoricalReceiptVerifierPort,
  type SignedLegacyHistoricalReceiptV1 } from "@discord-meeting/meeting-core/meeting-knowledge";

export interface LegacyHistoricalPublicTrustV1 {
  readonly policyId: string;
  readonly signerId: string;
  readonly publicKeyPem: string;
}

export class PinnedLegacyHistoricalReceiptVerifier implements LegacyHistoricalReceiptVerifierPort {
  readonly #keys = new Map<string, KeyObject>();
  public constructor(trust: readonly LegacyHistoricalPublicTrustV1[]) {
    for (const entry of trust) {
      const id = legacyHistoricalCanonicalJson([entry.policyId, entry.signerId]);
      const key = createPublicKey(entry.publicKeyPem);
      if (key.asymmetricKeyType !== "ed25519" || this.#keys.has(id) ||
        entry.policyId.trim() === "" || entry.signerId.trim() === "") {
        throw new Error("legacy public trust must pin unique Ed25519 policy/signer entries");
      }
      this.#keys.set(id, key);
    }
    Object.freeze(this);
  }
  public verify(value: unknown): SignedLegacyHistoricalReceiptV1 {
    const receipt = decodeSignedLegacyHistoricalReceipt(value);
    const key = this.#keys.get(legacyHistoricalCanonicalJson([
      receipt.payload.policyId, receipt.payload.signerId]));
    const signature = Buffer.from(receipt.signature, "base64");
    if (key === undefined || signature.toString("base64") !== receipt.signature ||
      !verify(null, Buffer.from(LEGACY_HISTORICAL_SIGNING_CONTEXT +
        legacyHistoricalCanonicalJson(receipt.payload), "utf8"), key, signature)) {
      throw new Error("legacy historical signature is not trusted");
    }
    return receipt;
  }
}
