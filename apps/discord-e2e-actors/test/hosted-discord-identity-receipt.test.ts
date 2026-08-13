import { describe, expect, it } from "vitest";

import {
  digestDiscordIdentityReceiptContentV1,
  evaluateDiscordIdentityReceiptV1,
  type DiscordIdentityReceiptV1,
  type DiscordIdentityRolesV1,
} from "../src/hosted-discord-identity-receipt.js";

const ids = {
  botikPlayback: "1534231284467896512",
  localObserver: "1533867700575670282",
  localSpeakerA: "1533227577286852649",
  localSpeakerB: "1533228054724346087",
  localSpeakerD: "1533873978417086474",
  localSut: "1533224474609057793",
  remotePlatformSut: "1533224474609057793",
} as const;

const binding = {
  campaignId: "campaign-1", containerId: "platform-1", host: "codex-workers-eu-01",
  imageDigestSha256: "a".repeat(64), planSha256: "b".repeat(64), sourceRevision: "c".repeat(40),
} as const;
const target = {
  deploymentScope: "private-test-deployment", environment: "private-test-guild",
  guildId: "1533228590643155034", mutationTarget: "test-only",
  publicationChannelId: "1533228891827736657", voiceChannelId: "1533228823045214398",
} as const;
const expectedIdentities = identities();
const expectation = {
  binding, identities: expectedIdentities, maximumAgeMs: 60_000, nowEpochMs: 110_000, target,
};

describe("hosted Discord identity receipt", () => {
  it("accepts exact executable identities and credentials bound to one deployment", () => {
    expect(evaluateDiscordIdentityReceiptV1(receipt(), expectation).identities.localObserver.applicationId)
      .toBe(ids.localObserver);
  });

  it.each([
    ["tampered digest", (value: DiscordIdentityReceiptV1) => ({ ...value, receiptSha256: "0".repeat(64) })],
    ["wrong private guild", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), target: { ...value.target, guildId: "1533228590643155035" } })],
    ["wrong deployment container", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), binding: { ...value.binding, containerId: "other" } })],
    ["wrong role mapping", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), identities: { ...value.identities, localSpeakerA: identity(ids.localSut, "speaker-a") } })],
    ["expired", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), expiresAtEpochMs: 110_000 })],
  ])("rejects %s", (_label, mutate) => {
    expect(() => evaluateDiscordIdentityReceiptV1(mutate(receipt()), expectation)).toThrow();
  });

  it("rejects signed credential replacement when revalidated immediately before spawn", () => {
    const admitted = evaluateDiscordIdentityReceiptV1(receipt(), expectation);
    const replacement = signed({
      ...withoutDigest(admitted),
      identities: {
        ...admitted.identities,
        localSpeakerB: {
          ...admitted.identities.localSpeakerB,
          tokenFile: {
            ...admitted.identities.localSpeakerB.tokenFile,
            generationId: "generation-speaker-b-rotated",
          },
        },
      },
    });
    expect(() => evaluateDiscordIdentityReceiptV1(replacement, expectation))
      .toThrow("exact role credentials");
  });

  it("rejects account, scope, path, owner, or generation drift", () => {
    const base = receipt();
    const tokenFile = base.identities.localObserver.tokenFile;
    const mutations: readonly (typeof tokenFile)[] = [
      { ...tokenFile, account: "sut" },
      { ...tokenFile, mode: 0o400, scope: "remote-deployment-secret" },
      { ...tokenFile, path: "/run/test-tokens/other" },
      { ...tokenFile, ownerUid: 10_002 },
      { ...tokenFile, generationId: "generation-other" },
    ];
    for (const replacement of mutations) {
      const candidate = signed({
        ...withoutDigest(base),
        identities: {
          ...base.identities,
          localObserver: { ...base.identities.localObserver, tokenFile: replacement },
        },
      });
      expect(() => evaluateDiscordIdentityReceiptV1(candidate, expectation)).toThrow();
    }
  });

  it("rejects a user token, mismatched authenticated user, duplicate role, or loose token file", () => {
    const base = receipt();
    const invalidIdentities: unknown[] = [
      { ...base.identities, localObserver: { ...base.identities.localObserver, bot: false } },
      { ...base.identities, localObserver: { ...base.identities.localObserver, authenticatedUserId: ids.localSpeakerA } },
      { ...base.identities, localObserver: identity(ids.localSpeakerA, "conversation-observer") },
      { ...base.identities, localObserver: { ...base.identities.localObserver, tokenFile: { ...base.identities.localObserver.tokenFile, mode: 0o644 } } },
      { ...base.identities, remotePlatformSut: { ...base.identities.remotePlatformSut,
        applicationId: ids.localSpeakerA, authenticatedUserId: ids.localSpeakerA } },
      { ...base.identities, remotePlatformSut: { ...base.identities.remotePlatformSut,
        tokenFile: { ...base.identities.remotePlatformSut.tokenFile,
          generationId: base.identities.localSut.tokenFile.generationId } } },
      { ...base.identities, remotePlatformSut: { ...base.identities.remotePlatformSut,
        tokenFile: { ...base.identities.remotePlatformSut.tokenFile, path: "/run/secrets/other" } } },
      { ...base.identities, remotePlatformSut: { ...base.identities.remotePlatformSut,
        tokenFile: { ...base.identities.remotePlatformSut.tokenFile, ownerUid: 10_002 } } },
    ];
    for (const invalidIdentitySet of invalidIdentities) {
      expect(() => evaluateDiscordIdentityReceiptV1(
        { ...withoutDigest(base), identities: invalidIdentitySet },
        expectation,
      )).toThrow();
    }
  });
});

function receipt(): DiscordIdentityReceiptV1 {
  return signed({
    binding, capability: "craig-test-identity", expiresAtEpochMs: 150_000,
    generatedAtEpochMs: 100_000, identities: identities(), kind: "hosted-discord-identity-receipt",
    schemaVersion: 1, target,
  });
}

function identities(): DiscordIdentityRolesV1 {
  return {
    botikPlayback: identity(ids.botikPlayback, "botik-playback", "remote-deployment-secret",
      "/run/secrets/discord_bot_token"),
    localObserver: identity(ids.localObserver, "conversation-observer"),
    localSpeakerA: identity(ids.localSpeakerA, "speaker-a"),
    localSpeakerB: identity(ids.localSpeakerB, "speaker-b"),
    localSpeakerD: identity(ids.localSpeakerD, "speaker-d"),
    localSut: identity(ids.localSut, "sut"),
    remotePlatformSut: identity(ids.remotePlatformSut, "sut", "remote-deployment-secret",
      "/run/secrets/discord-sut-token"),
  };
}

function identity(
  applicationId: string,
  account: DiscordIdentityRolesV1[keyof DiscordIdentityRolesV1]["tokenFile"]["account"],
  scope: DiscordIdentityRolesV1[keyof DiscordIdentityRolesV1]["tokenFile"]["scope"] =
    "local-campaign-secret",
  path = `/run/test-tokens/${account}`,
): DiscordIdentityRolesV1[keyof DiscordIdentityRolesV1] {
  const tokenFile = scope === "remote-deployment-secret"
    ? { account, generationId: `generation-remote-${account}`, mode: 0o400 as const, ownerUid: 10_001,
        path, scope }
    : { account, generationId: `generation-${account}`, mode: 0o600 as const, ownerUid: 10_001,
        path, scope };
  return {
    applicationId, authenticatedUserId: applicationId, bot: true,
    tokenFile,
    verificationSource: "discord-current-application-and-user",
  };
}

function signed(content: Omit<DiscordIdentityReceiptV1, "receiptSha256">): DiscordIdentityReceiptV1 {
  return { ...content, receiptSha256: digestDiscordIdentityReceiptContentV1(content) };
}

function withoutDigest(receiptValue: DiscordIdentityReceiptV1): Omit<DiscordIdentityReceiptV1, "receiptSha256"> {
  const { receiptSha256: _receiptSha256, ...content } = receiptValue;
  return content;
}
