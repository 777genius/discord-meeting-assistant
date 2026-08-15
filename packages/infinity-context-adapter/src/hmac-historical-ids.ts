import type { HistoricalOpaqueIdPort } from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHmac } from "node:crypto";

function identityPart(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export class HmacHistoricalOpaqueIds implements HistoricalOpaqueIdPort {
  readonly #key: Buffer;

  public constructor(key: Uint8Array | string) {
    this.#key = Buffer.from(key);
    if (this.#key.byteLength < 32) {
      throw new RangeError("historical topology HMAC key must contain at least 32 bytes");
    }
  }

  public keyedId(namespace: string, parts: readonly string[]): string {
    if (namespace.trim().length === 0 || parts.some((part) => typeof part !== "string")) {
      throw new TypeError("historical opaque identity input is invalid");
    }
    return createHmac("sha256", this.#key)
      .update([identityPart(namespace), ...parts.map(identityPart)].join("|"), "utf8")
      .digest("base64url");
  }
}
