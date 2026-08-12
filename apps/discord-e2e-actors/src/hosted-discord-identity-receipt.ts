import { createHash } from "node:crypto";

import { z } from "zod";

const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u);
const discordIdSchema = z.string().regex(/^\d{17,20}$/u);
const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);
const sourceRevisionSchema = z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u);
const privateTokenFileSchema = z.object({
  generationId: identifierSchema,
  mode: z.literal(0o600),
  ownerUid: z.number().int().nonnegative(),
  path: z.string().startsWith("/"),
}).strict();

const authenticatedApplicationSchema = z.object({
  applicationId: discordIdSchema,
  authenticatedUserId: discordIdSchema,
  bot: z.literal(true),
  tokenFile: privateTokenFileSchema,
  verificationSource: z.literal("discord-current-application-and-user"),
}).strict().superRefine((identity, context) => {
  if (identity.applicationId !== identity.authenticatedUserId) {
    context.addIssue({ code: "custom", message: "authenticated Discord application and bot user IDs differ" });
  }
});

export const discordIdentityRolesV1Schema = z.object({
  botikPlayback: authenticatedApplicationSchema,
  localObserver: authenticatedApplicationSchema,
  localSpeakerA: authenticatedApplicationSchema,
  localSpeakerB: authenticatedApplicationSchema,
  localSpeakerD: authenticatedApplicationSchema,
  localSut: authenticatedApplicationSchema,
  recordingGateway: authenticatedApplicationSchema,
}).strict().superRefine((roles, context) => {
  const ids = Object.values(roles).map(({ applicationId }) => applicationId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "Discord campaign roles must use distinct applications" });
  }
});

export const discordIdentityReceiptV1Schema = z.object({
  binding: z.object({
    campaignId: identifierSchema,
    containerId: identifierSchema,
    host: identifierSchema,
    imageDigestSha256: sha256Schema,
    planSha256: sha256Schema,
    sourceRevision: sourceRevisionSchema,
  }).strict(),
  capability: z.literal("craig-test-identity"),
  expiresAtEpochMs: z.number().int().nonnegative(),
  generatedAtEpochMs: z.number().int().nonnegative(),
  identities: discordIdentityRolesV1Schema,
  kind: z.literal("hosted-discord-identity-receipt"),
  receiptSha256: sha256Schema,
  schemaVersion: z.literal(1),
  target: z.object({
    deploymentScope: z.literal("private-test-deployment"),
    environment: z.literal("private-test-guild"),
    guildId: discordIdSchema,
    mutationTarget: z.literal("test-only"),
    publicationChannelId: discordIdSchema,
    voiceChannelId: discordIdSchema,
  }).strict(),
}).strict();

export type DiscordIdentityRolesV1 = z.infer<typeof discordIdentityRolesV1Schema>;
export type DiscordIdentityReceiptV1 = z.infer<typeof discordIdentityReceiptV1Schema>;

export interface DiscordIdentityReceiptExpectationV1 {
  readonly binding: DiscordIdentityReceiptV1["binding"];
  readonly identities: Readonly<Record<keyof DiscordIdentityRolesV1, string>>;
  readonly maximumAgeMs: number;
  readonly nowEpochMs: number;
  readonly target: DiscordIdentityReceiptV1["target"];
}

export function digestDiscordIdentityReceiptContentV1(
  content: Omit<DiscordIdentityReceiptV1, "receiptSha256">,
): string {
  return digestCanonical(content);
}

export function evaluateDiscordIdentityReceiptV1(
  value: unknown,
  expected: DiscordIdentityReceiptExpectationV1,
): DiscordIdentityReceiptV1 {
  const receipt = discordIdentityReceiptV1Schema.parse(value);
  const { receiptSha256, ...content } = receipt;
  if (digestDiscordIdentityReceiptContentV1(content) !== receiptSha256) {
    throw new Error("Discord identity receipt digest is invalid");
  }
  assertValidLifetime(receipt, expected);
  if (JSON.stringify(receipt.binding) !== JSON.stringify(expected.binding)
    || JSON.stringify(receipt.target) !== JSON.stringify(expected.target)) {
    throw new Error("Discord identity receipt does not match the campaign binding");
  }
  for (const role of discordIdentityRoleNames) {
    const applicationId = expected.identities[role];
    if (receipt.identities[role].applicationId !== applicationId) {
      throw new Error(`Discord identity receipt has the wrong ${role} application`);
    }
  }
  return Object.freeze(receipt);
}

const discordIdentityRoleNames = [
  "botikPlayback", "localObserver", "localSpeakerA", "localSpeakerB",
  "localSpeakerD", "localSut", "recordingGateway",
] as const satisfies readonly (keyof DiscordIdentityRolesV1)[];

function assertValidLifetime(
  receipt: DiscordIdentityReceiptV1,
  expected: DiscordIdentityReceiptExpectationV1,
): void {
  if (!Number.isSafeInteger(expected.maximumAgeMs) || expected.maximumAgeMs < 1
    || !Number.isSafeInteger(expected.nowEpochMs)
    || receipt.expiresAtEpochMs <= receipt.generatedAtEpochMs
    || receipt.generatedAtEpochMs > expected.nowEpochMs
    || expected.nowEpochMs >= receipt.expiresAtEpochMs
    || expected.nowEpochMs - receipt.generatedAtEpochMs > expected.maximumAgeMs) {
    throw new Error("Discord identity receipt is stale, expired, or from the future");
  }
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {return value.map(canonicalize);}
  if (typeof value !== "object" || value === null) {return value;}
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
