import type { HistoricalOpaqueIdPort } from "@discord-meeting/meeting-core/meeting-knowledge";
import { createHmac } from "node:crypto";

function identityPart(value: string): string {
  return `${Buffer.byteLength(value, "utf8")}:${value}`;
}

const constructedHmacHistoricalOpaqueIds = new WeakSet<object>();

export function assertConstructedHmacHistoricalOpaqueIds(value: unknown): asserts value is HmacHistoricalOpaqueIds {
  if (typeof value !== "object" || value === null ||
    !constructedHmacHistoricalOpaqueIds.has(value)) {
    throw new Error("historical HMAC authority was not constructed by its adapter module");
  }
}

export class HmacHistoricalOpaqueIds implements HistoricalOpaqueIdPort {
  readonly #key: Buffer;
  readonly #actorKeyProfileId: string | undefined;

  public constructor(key: Uint8Array | string, actorKeyProfileId?: string) {
    this.#actorKeyProfileId = actorKeyProfileId;
    this.#key = Buffer.from(key);
    if (this.#key.byteLength < 32) {
      throw new RangeError("historical topology HMAC key must contain at least 32 bytes");
    }
    constructedHmacHistoricalOpaqueIds.add(this);
  }

  public keyedId(namespace: string, parts: readonly string[]): string {
    if (namespace.trim().length === 0 || parts.some((part) => typeof part !== "string")) {
      throw new TypeError("historical opaque identity input is invalid");
    }
    const boundParts = namespace === "historical-index-generation" &&
      this.#actorKeyProfileId !== undefined
      ? [...parts, this.#actorKeyProfileId]
      : parts;
    return createHmac("sha256", this.#key)
      .update([identityPart(namespace), ...boundParts.map(identityPart)].join("|"), "utf8")
      .digest("base64url");
  }
}
