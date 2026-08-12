import { describe, expect, it, vi } from "vitest";

import {
  BoundedDiscordBotJsonClient,
  type DiscordFetch,
} from "../src/hosted-discord-identity-http.js";
import {
  DiscordRestRoleIdentityProbe,
  produceHostedDiscordIdentityReceiptV1,
  type DiscordRoleIdentityExpectation,
  type DiscordRoleIdentityProbe,
} from "../src/hosted-discord-identity-producer.js";
import { evaluateDiscordIdentityReceiptV1 } from "../src/hosted-discord-identity-receipt.js";
import type { PrivateFileSecret } from "../src/keychain.js";

const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";
const publicationChannelId = "1533228891827736657";
const applicationId = "1534231284467896512";
const token = `token.${"x".repeat(60)}`;
const target = { guildId, publicationChannelId, voiceChannelId } as const;

describe("hosted Discord identity producer", () => {
  it("authenticates an official bot and exact private guild channels without retaining its token", async () => {
    const fetchResponse = vi.fn(discordFetch());
    const client = new BoundedDiscordBotJsonClient(fetchResponse, 1_000, 1_024);
    const probe = new DiscordRestRoleIdentityProbe(secretReader(), client);
    const result = await probe.probe(expectation(), target);

    expect(result).toMatchObject({ applicationId, authenticatedUserId: applicationId, bot: true });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(fetchResponse).toHaveBeenCalledTimes(4);
    for (const call of fetchResponse.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: "manual", headers: { authorization: `Bot ${token}` } });
    }
  });

  it.each([
    ["wrong authenticated ID", { userId: "1534231284467896513" }],
    ["user token", { bot: false }],
    ["wrong guild", { guildId: "1533228590643155035" }],
    ["wrong voice channel", { voiceChannelId: "1533228823045214399" }],
    ["wrong publication channel", { publicationChannelId: "1533228891827736658" }],
  ])("fails closed for %s", async (_label, options) => {
    const probe = new DiscordRestRoleIdentityProbe(
      secretReader(),
      new BoundedDiscordBotJsonClient(discordFetch(options)),
    );
    await expect(probe.probe(expectation(), target)).rejects.toThrow();
  });

  it("rejects credential replacement during the REST snapshot", async () => {
    let readCount = 0;
    const probe = new DiscordRestRoleIdentityProbe({
      readPrivateFile: async () => credential(readCount++ === 0 ? "generation-1" : "generation-2"),
    }, new BoundedDiscordBotJsonClient(discordFetch()));
    await expect(probe.probe(expectation(), target)).rejects.toThrow("changed during");
  });

  it("rejects outages, redirects, oversized bodies, malformed JSON, and off-allowlist paths", async () => {
    const outage = new BoundedDiscordBotJsonClient(async () => {throw new Error("network down");});
    await expect(outage.get("/users/@me", token)).rejects.toThrow("network down");
    await expect(clientReturning(302, {}).get("/users/@me", token)).rejects.toThrow("redirects");
    await expect(clientReturning(200, { id: applicationId }, 8).get("/users/@me", token)).rejects.toThrow("exceeds");
    await expect(clientReturning(200, "{invalid").get("/users/@me", token)).rejects.toThrow("invalid JSON");
    await expect(clientReturning(200, {}).get("/users/other", token)).rejects.toThrow("allowlist");
  });

  it("combines six injected role probes into one digest-bound receipt", async () => {
    const roleIds = [
      "1534231284467896512", "1533867700575670282", "1533227577286852649",
      "1533228054724346087", "1533873978417086474", "1533224474609057793",
    ] as const;
    const names = ["botikPlayback", "localObserver", "localSpeakerA", "localSpeakerB", "localSpeakerD", "localSut"] as const;
    const accounts = ["botik-playback", "conversation-observer", "speaker-a", "speaker-b", "speaker-d", "sut"] as const;
    const roles = Object.fromEntries(names.map((name, index) => {
      const expected = expectation(roleIds[index], accounts[index], name === "botikPlayback");
      const injected: DiscordRoleIdentityProbe = { probe: async () => identity(expected) };
      return [name, { expectation: expected, probe: injected }];
    })) as Parameters<typeof produceHostedDiscordIdentityReceiptV1>[0]["roles"];
    const binding = {
      campaignId: "campaign-1", containerId: "platform-1", host: "test-host",
      imageDigestSha256: "a".repeat(64), planSha256: "b".repeat(64), sourceRevision: "c".repeat(40),
    } as const;
    const receiptTarget = {
      deploymentScope: "private-test-deployment", environment: "private-test-guild", guildId,
      mutationTarget: "test-only", publicationChannelId, voiceChannelId,
    } as const;
    const receipt = await produceHostedDiscordIdentityReceiptV1({
      binding, expiresAtEpochMs: 150_000, generatedAtEpochMs: 100_000, roles, target: receiptTarget,
    });
    expect(evaluateDiscordIdentityReceiptV1(receipt, {
      binding, identities: receipt.identities, maximumAgeMs: 60_000, nowEpochMs: 110_000,
      target: receiptTarget,
    })).toEqual(receipt);
  });
});

function expectation(
  id = applicationId,
  account: DiscordRoleIdentityExpectation["tokenFile"]["account"] = "botik-playback",
  remote = false,
): DiscordRoleIdentityExpectation {
  return { applicationId: id, tokenFile: {
    account, ownerUid: 10_001, path: `/run/test-tokens/${account}`,
    scope: remote ? "remote-deployment-secret" : "local-campaign-secret",
  } };
}

function identity(expected: DiscordRoleIdentityExpectation) {
  return {
    applicationId: expected.applicationId, authenticatedUserId: expected.applicationId, bot: true as const,
    tokenFile: { ...expected.tokenFile, generationId: `generation-${expected.tokenFile.account}`, mode: 0o600 as const },
    verificationSource: "discord-current-application-and-user" as const,
  };
}

function credential(generationId = "generation-1"): PrivateFileSecret {
  return { account: "botik-playback", generationId, mode: 0o600, ownerUid: 10_001,
    path: "/run/test-tokens/botik-playback", secret: token };
}

function secretReader() {
  return { readPrivateFile: async () => credential() };
}

function discordFetch(options: {
  readonly bot?: boolean; readonly guildId?: string; readonly publicationChannelId?: string;
  readonly userId?: string; readonly voiceChannelId?: string;
} = {}): DiscordFetch {
  return async (url) => {
    const path = new URL(url).pathname.replace("/api/v10", "");
    const body = path === "/users/@me" ? { bot: options.bot ?? true, id: options.userId ?? applicationId }
      : path.startsWith("/guilds/") ? { id: options.guildId ?? guildId }
        : path === `/channels/${voiceChannelId}`
          ? { guild_id: guildId, id: options.voiceChannelId ?? voiceChannelId, type: 2 }
          : { guild_id: guildId, id: options.publicationChannelId ?? publicationChannelId, type: 0 };
    return response(200, body);
  };
}

function clientReturning(status: number, body: unknown, maximumBodyBytes = 1_024) {
  return new BoundedDiscordBotJsonClient(async () => response(status, body), 1_000, maximumBodyBytes);
}

function response(status: number, body: unknown) {
  const bytes = new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  return { body: new Blob([bytes]).stream(), headers: new Headers({ "content-type": "application/json" }), status };
}
