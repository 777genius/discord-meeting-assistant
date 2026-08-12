import { timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { DiscordBotJsonClient } from "./hosted-discord-identity-http.js";
import {
  digestDiscordIdentityReceiptContentV1,
  discordIdentityReceiptV1Schema,
  type DiscordIdentityReceiptV1,
  type DiscordIdentityRolesV1,
} from "./hosted-discord-identity-receipt.js";
import type { FileSecretReader, PrivateFileSecret } from "./keychain.js";

type RoleName = keyof DiscordIdentityRolesV1;
type RoleIdentity = DiscordIdentityRolesV1[RoleName];

export interface DiscordIdentityProbeTarget {
  readonly guildId: string;
  readonly publicationChannelId: string;
  readonly voiceChannelId: string;
}

export interface DiscordRoleIdentityExpectation {
  readonly applicationId: string;
  readonly tokenFile: Omit<RoleIdentity["tokenFile"], "generationId" | "mode">;
}

export interface DiscordRoleIdentityProbe {
  probe(expectation: DiscordRoleIdentityExpectation, target: DiscordIdentityProbeTarget): Promise<RoleIdentity>;
}

export class DiscordRestRoleIdentityProbe implements DiscordRoleIdentityProbe {
  public constructor(
    private readonly secrets: Pick<FileSecretReader, "readPrivateFile">,
    private readonly client: DiscordBotJsonClient,
  ) {}

  public async probe(
    expectation: DiscordRoleIdentityExpectation,
    target: DiscordIdentityProbeTarget,
  ): Promise<RoleIdentity> {
    const before = await this.secrets.readPrivateFile(expectation.tokenFile.account);
    assertCredentialDescriptor(before, expectation);
    const [user, guild, voiceChannel, publicationChannel] = await Promise.all([
      this.client.get("/users/@me", before.secret),
      this.client.get(`/guilds/${target.guildId}`, before.secret),
      this.client.get(`/channels/${target.voiceChannelId}`, before.secret),
      this.client.get(`/channels/${target.publicationChannelId}`, before.secret),
    ]);
    const authenticated = userSchema.parse(user);
    if (!authenticated.bot || authenticated.id !== expectation.applicationId) {
      throw new Error("Discord credential is not the expected official bot application");
    }
    assertTargetAccess(guild, voiceChannel, publicationChannel, target);
    const after = await this.secrets.readPrivateFile(expectation.tokenFile.account);
    assertCredentialDescriptor(after, expectation);
    if (after.generationId !== before.generationId || !sameSecret(after.secret, before.secret)) {
      throw new Error("Discord credential changed during identity verification");
    }
    return Object.freeze({
      applicationId: expectation.applicationId,
      authenticatedUserId: authenticated.id,
      bot: true,
      tokenFile: {
        ...expectation.tokenFile,
        generationId: after.generationId,
        mode: 0o600 as const,
      },
      verificationSource: "discord-current-application-and-user",
    });
  }
}

export interface HostedDiscordIdentityReceiptInput {
  readonly binding: DiscordIdentityReceiptV1["binding"];
  readonly expiresAtEpochMs: number;
  readonly generatedAtEpochMs: number;
  readonly roles: Readonly<Record<RoleName, {
    readonly expectation: DiscordRoleIdentityExpectation;
    readonly probe: DiscordRoleIdentityProbe;
  }>>;
  readonly target: DiscordIdentityReceiptV1["target"];
}

export async function produceHostedDiscordIdentityReceiptV1(
  input: HostedDiscordIdentityReceiptInput,
): Promise<DiscordIdentityReceiptV1> {
  if (input.expiresAtEpochMs <= input.generatedAtEpochMs) {
    throw new Error("Discord identity receipt expiry must follow generation");
  }
  const target = {
    guildId: input.target.guildId,
    publicationChannelId: input.target.publicationChannelId,
    voiceChannelId: input.target.voiceChannelId,
  };
  const entries = await Promise.all((Object.keys(input.roles) as RoleName[]).map(async (role) => [
    role,
    await input.roles[role].probe.probe(input.roles[role].expectation, target),
  ] as const));
  const content: Omit<DiscordIdentityReceiptV1, "receiptSha256"> = {
    binding: input.binding,
    capability: "craig-test-identity",
    expiresAtEpochMs: input.expiresAtEpochMs,
    generatedAtEpochMs: input.generatedAtEpochMs,
    identities: Object.fromEntries(entries) as DiscordIdentityRolesV1,
    kind: "hosted-discord-identity-receipt",
    schemaVersion: 1,
    target: input.target,
  };
  return Object.freeze(discordIdentityReceiptV1Schema.parse({
    ...content,
    receiptSha256: digestDiscordIdentityReceiptContentV1(content),
  }));
}

const userSchema = z.looseObject({ bot: z.boolean().optional().default(false), id: z.string().regex(/^\d{17,20}$/u) });
const guildSchema = z.looseObject({ id: z.string().regex(/^\d{17,20}$/u) });
const channelSchema = z.looseObject({
  guild_id: z.string().regex(/^\d{17,20}$/u),
  id: z.string().regex(/^\d{17,20}$/u),
  type: z.number().int(),
});

function assertTargetAccess(
  guildValue: unknown,
  voiceValue: unknown,
  publicationValue: unknown,
  target: DiscordIdentityProbeTarget,
): void {
  const guild = guildSchema.parse(guildValue);
  const voice = channelSchema.parse(voiceValue);
  const publication = channelSchema.parse(publicationValue);
  if (guild.id !== target.guildId || voice.id !== target.voiceChannelId
    || publication.id !== target.publicationChannelId
    || voice.guild_id !== target.guildId || publication.guild_id !== target.guildId
    || ![2, 13].includes(voice.type) || ![0, 5].includes(publication.type)) {
    throw new Error("Discord credential lacks access to the exact private campaign target");
  }
}

function assertCredentialDescriptor(
  credential: PrivateFileSecret,
  expectation: DiscordRoleIdentityExpectation,
): void {
  const expected = expectation.tokenFile;
  const credentialMode: number = credential.mode;
  if (credential.account !== expected.account || credential.path !== expected.path
    || credential.ownerUid !== expected.ownerUid || credentialMode !== 0o600) {
    throw new Error("Discord credential file does not match its declared custody");
  }
}

function sameSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
