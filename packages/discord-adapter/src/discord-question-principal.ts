import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

import { z } from "zod";

const principalPayloadV1Schema = z.object({
  actorId: z.string().regex(/^\d{17,20}$/u),
  containerId: z.string().regex(/^\d{17,20}$/u),
  expiresAtMilliseconds: z.number().int().positive(),
  scopeId: z.string().regex(/^\d{17,20}$/u),
  version: z.literal(1),
}).strict();

const principalPayloadV2Schema = z.object({
  actorId: z.string().regex(/^\d{17,20}$/u),
  authorizationContainerId: z.string().regex(/^\d{17,20}$/u),
  containerId: z.string().regex(/^\d{17,20}$/u),
  expiresAtMilliseconds: z.number().int().positive(),
  scopeId: z.string().regex(/^\d{17,20}$/u),
  version: z.literal(2),
}).strict();

const principalPayloadSchema = z.discriminatedUnion("version", [
  principalPayloadV1Schema,
  principalPayloadV2Schema,
]);

export interface DiscordQuestionPrincipal {
  readonly actorId: string;
  readonly authorizationContainerId: string;
  readonly containerId: string;
  readonly expiresAtMilliseconds: number;
  readonly scopeId: string;
  readonly version: 1 | 2;
}

const principalPrefix = "mkp1";
const principalAad = Buffer.from("discord-meeting:knowledge-principal:v1", "utf8");

export class DiscordQuestionPrincipalCodec {
  private readonly key: Buffer;

  public constructor(key: Uint8Array) {
    if (key.byteLength !== 32) {
      throw new RangeError("Discord question principal key must contain exactly 32 bytes");
    }
    this.key = Buffer.from(key);
  }

  public issue(input: Omit<DiscordQuestionPrincipal, "version">): string {
    const payload = principalPayloadV2Schema.parse({ ...input, version: 2 });
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(principalAad);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return [
      principalPrefix,
      nonce.toString("base64url"),
      ciphertext.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
    ].join(".");
  }

  public resolve(reference: string): DiscordQuestionPrincipal | null {
    const [prefix, nonceText, ciphertextText, tagText, extra] = reference.split(".");
    if (
      prefix !== principalPrefix ||
      nonceText === undefined ||
      ciphertextText === undefined ||
      tagText === undefined ||
      extra !== undefined
    ) {
      return null;
    }
    try {
      const nonce = Buffer.from(nonceText, "base64url");
      const ciphertext = Buffer.from(ciphertextText, "base64url");
      const tag = Buffer.from(tagText, "base64url");
      if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength > 1_024) {
        return null;
      }
      const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
      decipher.setAAD(principalAad);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString("utf8");
      const payload = principalPayloadSchema.parse(JSON.parse(plaintext) as unknown);
      return payload.version === 1
        ? { ...payload, authorizationContainerId: payload.containerId }
        : payload;
    } catch {
      return null;
    }
  }

  public keyedSubject(actorId: string, scopeId: string): string {
    return this.digest("requester-subject", actorId, scopeId);
  }

  public questionHash(question: string): string {
    return this.digest("question", question);
  }

  public observationDigest(...parts: readonly string[]): string {
    return this.digest("authorization-observation", ...parts);
  }

  private digest(kind: string, ...parts: readonly string[]): string {
    const hmac = createHmac("sha256", this.key).update(kind, "utf8");
    for (const part of parts) {
      hmac.update(`:${part.length}:`, "utf8").update(part, "utf8");
    }
    return hmac.digest("hex");
  }
}

export function decodeDiscordQuestionPrincipalKey(value: string): Uint8Array {
  const normalized = value.trim();
  const key = /^[0-9a-f]{64}$/u.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  if (key.byteLength !== 32) {
    throw new RangeError("Discord question principal secret must encode exactly 32 bytes");
  }
  return key;
}
