import { createHmac } from "node:crypto";

import { z } from "zod";

const discordSnowflake = z.string().regex(/^\d{17,20}$/u);
const keyId = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/u);
const encodedKey = z.string().trim().min(1).max(128);
const actorKeyringSchema = z.object({
  activeKeyId: keyId,
  keys: z.record(keyId, encodedKey),
  schemaVersion: z.literal(1),
}).strict();

export interface DiscordInfinityActorKeyringV1 {
  readonly activeKeyId: string;
  readonly keys: Readonly<Record<string, string>>;
  readonly schemaVersion: 1;
}

const purpose = "discord-meeting:infinity-actor-key:v1";

/**
 * Discord-custody pseudonymization for the actor identity field exposed to
 * Infinity. Retained keys let filters span a controlled key rotation while
 * newly indexed projections use only the active version.
 */
export class DiscordInfinityActorKeys {
  readonly #activeKeyId: string;
  readonly #keys: ReadonlyMap<string, Buffer>;

  public constructor(keyring: DiscordInfinityActorKeyringV1) {
    const parsed = actorKeyringSchema.parse(keyring);
    const decoded = new Map(Object.entries(parsed.keys).map(([id, value]) => [
      id,
      decodeKey(value),
    ]));
    if (!decoded.has(parsed.activeKeyId)) {
      throw new RangeError("Discord Infinity actor keyring has no active key");
    }
    this.#activeKeyId = parsed.activeKeyId;
    this.#keys = decoded;
  }

  public activeActorKey(discordActorId: string): string {
    return this.actorKey(this.#activeKeyId, discordActorId);
  }

  public actorKeysForFilter(discordActorId: string): readonly string[] {
    return Object.freeze([...this.#keys.keys()].toSorted().map((id) =>
      this.actorKey(id, discordActorId)
    ));
  }

  /** Salts only derived index generations, not stable room topology. */
  public activeProfileId(): string {
    return `discord-infinity-actor-key.v1:${this.#activeKeyId}`;
  }

  private actorKey(keyIdValue: string, discordActorId: string): string {
    const actorId = discordSnowflake.parse(discordActorId);
    const key = this.#keys.get(keyIdValue);
    if (key === undefined) {
      throw new RangeError("Discord Infinity actor key version is unavailable");
    }
    const digest = createHmac("sha256", key)
      .update(purpose, "utf8")
      .update(`:${actorId.length}:`, "utf8")
      .update(actorId, "utf8")
      .digest("base64url");
    return `dactor1.${keyIdValue}.${digest}`;
  }
}

export function decodeDiscordInfinityActorKeyring(
  value: string,
): DiscordInfinityActorKeyringV1 {
  const parsed = actorKeyringSchema.parse(JSON.parse(value) as unknown);
  // Decode eagerly so malformed authority fails at configuration load rather
  // than after a historical mutation is leased.
  for (const encoded of Object.values(parsed.keys)) {
    decodeKey(encoded);
  }
  if (!(parsed.activeKeyId in parsed.keys)) {
    throw new RangeError("Discord Infinity actor keyring has no active key");
  }
  return Object.freeze({
    activeKeyId: parsed.activeKeyId,
    keys: Object.freeze({ ...parsed.keys }),
    schemaVersion: 1,
  });
}

function decodeKey(value: string): Buffer {
  const normalized = value.trim();
  const decoded = /^[0-9a-f]{64}$/u.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  if (decoded.byteLength !== 32) {
    throw new RangeError("Discord Infinity actor key must encode exactly 32 bytes");
  }
  return decoded;
}
