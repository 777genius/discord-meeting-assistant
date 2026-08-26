import { createHash, createPublicKey, verify } from "node:crypto";

import { canonicalJson, exactRecord } from "./canonical.js";
import type { CampaignAuthenticationPort, SignedValue } from "./execution.js";

/** Node cryptography adapter. Deterministic application reconstruction receives only this port. */
export const nodeCampaignAuthentication: CampaignAuthenticationPort = Object.freeze({
  publicKeyFingerprint(publicKeyPem: string): string {
    try {const der = createPublicKey(publicKeyPem).export({ format: "der", type: "spki" });
      return createHash("sha256").update(der).digest("hex");}
    catch {throw new Error("authority public key is invalid");}
  },
  verify<T>(value: unknown, keyId: string, publicKeyPem: string, label: string): SignedValue<T> {
    const record = exactRecord(value, ["payload", "signatureBase64", "signerKeyId"], label);
    if (record.signerKeyId !== keyId || typeof record.signatureBase64 !== "string") {
      throw new Error(`${label} signer is invalid`);
    }
    let valid = false;
    try {valid = verify(null, Buffer.from(canonicalJson(record.payload)), createPublicKey(publicKeyPem),
      Buffer.from(record.signatureBase64, "base64"));} catch {valid = false;}
    if (!valid) {throw new Error(`${label} signature is invalid`);}
    return Object.freeze(record as unknown as SignedValue<T>);
  },
});
