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
  recordingGateway: "1533224474609057794",
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
const expectation = { binding, identities: ids, maximumAgeMs: 60_000, nowEpochMs: 110_000, target };

describe("hosted Discord identity receipt", () => {
  it("accepts distinct authenticated test applications bound to one exact deployment", () => {
    expect(evaluateDiscordIdentityReceiptV1(receipt(), expectation).identities.localObserver.applicationId)
      .toBe(ids.localObserver);
  });

  it.each([
    ["tampered digest", (value: DiscordIdentityReceiptV1) => ({ ...value, receiptSha256: "0".repeat(64) })],
    ["wrong private guild", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), target: { ...value.target, guildId: "1533228590643155035" } })],
    ["wrong deployment container", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), binding: { ...value.binding, containerId: "other" } })],
    ["wrong role mapping", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), identities: { ...value.identities, localSpeakerA: identity(ids.recordingGateway, "a") } })],
    ["expired", (value: DiscordIdentityReceiptV1) => signed({ ...withoutDigest(value), expiresAtEpochMs: 110_000 })],
  ])("rejects %s", (_label, mutate) => {
    expect(() => evaluateDiscordIdentityReceiptV1(mutate(receipt()), expectation)).toThrow();
  });

  it("rejects a user token, mismatched authenticated user, duplicate role, or loose token file", () => {
    const base = receipt();
    const invalidIdentities: unknown[] = [
      { ...base.identities, localObserver: { ...base.identities.localObserver, bot: false } },
      { ...base.identities, localObserver: { ...base.identities.localObserver, authenticatedUserId: ids.localSpeakerA } },
      { ...base.identities, localObserver: identity(ids.localSpeakerA, "observer") },
      { ...base.identities, localObserver: { ...base.identities.localObserver, tokenFile: { ...base.identities.localObserver.tokenFile, mode: 0o644 } } },
    ];
    for (const identities of invalidIdentities) {
      expect(() => evaluateDiscordIdentityReceiptV1(
        { ...withoutDigest(base), identities },
        expectation,
      )).toThrow();
    }
  });
});

function receipt(): DiscordIdentityReceiptV1 {
  const identities: DiscordIdentityRolesV1 = {
    botikPlayback: identity(ids.botikPlayback, "botik-playback"),
    localObserver: identity(ids.localObserver, "observer"),
    localSpeakerA: identity(ids.localSpeakerA, "speaker-a"),
    localSpeakerB: identity(ids.localSpeakerB, "speaker-b"),
    localSpeakerD: identity(ids.localSpeakerD, "speaker-d"),
    localSut: identity(ids.localSut, "sut"),
    recordingGateway: identity(ids.recordingGateway, "recording-gateway"),
  };
  return signed({
    binding, capability: "craig-test-identity", expiresAtEpochMs: 150_000,
    generatedAtEpochMs: 100_000, identities, kind: "hosted-discord-identity-receipt",
    schemaVersion: 1, target,
  });
}

function identity(applicationId: string, role: string): DiscordIdentityRolesV1[keyof DiscordIdentityRolesV1] {
  return {
    applicationId, authenticatedUserId: applicationId, bot: true,
    tokenFile: { generationId: `generation-${role}`, mode: 0o600, ownerUid: 10_001, path: `/run/test-tokens/${role}` },
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
