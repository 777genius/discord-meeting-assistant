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

  it("aborts all in-flight Discord REST requests with the caller signal", async () => {
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    const client = new BoundedDiscordBotJsonClient(async (_url, init) => {
      signals.push(init.signal);
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {reject(init.signal.reason);}, { once: true });
      });
    });
    const result = new DiscordRestRoleIdentityProbe(secretReader(), client)
      .probe(expectation(), target, controller.signal);

    await vi.waitFor(() => {expect(signals).toHaveLength(4);});
    controller.abort(new Error("campaign deadline expired"));

    await expect(result).rejects.toThrow("campaign deadline expired");
    expect(signals).toHaveLength(4);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("rejects outages, redirects, oversized bodies, malformed JSON, and off-allowlist paths", async () => {
    const outage = new BoundedDiscordBotJsonClient(async () => {throw new Error("network down");});
    await expect(outage.get("/users/@me", token)).rejects.toThrow("network down");
    await expect(clientReturning(302, {}).get("/users/@me", token)).rejects.toThrow("redirects");
    await expect(clientReturning(200, { id: applicationId }, 8).get("/users/@me", token)).rejects.toThrow("exceeds");
    await expect(clientReturning(200, "{invalid").get("/users/@me", token)).rejects.toThrow("invalid JSON");
    await expect(clientReturning(200, {}).get("/users/other", token)).rejects.toThrow("allowlist");
  });

  it("combines seven injected role probes into one digest-bound receipt", async () => {
    const roleIds = [
      "1534231284467896512", "1533867700575670282", "1533227577286852649",
      "1533228054724346087", "1533873978417086474", "1533224474609057793", "1533224474609057793",
    ] as const;
    const names = ["botikPlayback", "localObserver", "localSpeakerA", "localSpeakerB", "localSpeakerD", "localSut", "remotePlatformSut"] as const;
    const accounts = ["botik-playback", "conversation-observer", "speaker-a", "speaker-b", "speaker-d", "sut", "sut"] as const;
    const roles = Object.fromEntries(names.map((name, index) => {
      const expected = expectation(roleIds[index], accounts[index], name === "botikPlayback" || name === "remotePlatformSut",
        name === "remotePlatformSut" ? "/run/secrets/discord-sut-token" : undefined);
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
      binding, now: () => 100_000, roles, target: receiptTarget, ttlMs: 50_000,
    });
    expect(evaluateDiscordIdentityReceiptV1(receipt, {
      binding, identities: receipt.identities, maximumAgeMs: 60_000, nowEpochMs: 110_000,
      target: receiptTarget,
    })).toEqual(receipt);
  });

  it("timestamps the aggregate receipt after all identity probes complete", async () => {
    let currentTime = 100_000;
    const roleIds = [
      "1534231284467896512", "1533867700575670282", "1533227577286852649",
      "1533228054724346087", "1533873978417086474", "1533224474609057793",
    ] as const;
    const accounts = ["botik-playback", "conversation-observer", "speaker-a", "speaker-b", "speaker-d", "sut"] as const;
    const delayedRole = (
      id: string,
      account: DiscordRoleIdentityExpectation["tokenFile"]["account"],
      remote = false,
      path?: string,
    ): { expectation: DiscordRoleIdentityExpectation; probe: DiscordRoleIdentityProbe } => {
      const expected = expectation(id, account, remote, path);
      return { expectation: expected, probe: { probe: async () => {
        currentTime = 170_000;
        return identity(expected);
      } } };
    };
    const roles = {
      botikPlayback: delayedRole(roleIds[0], accounts[0], true),
      localObserver: delayedRole(roleIds[1], accounts[1]),
      localSpeakerA: delayedRole(roleIds[2], accounts[2]),
      localSpeakerB: delayedRole(roleIds[3], accounts[3]),
      localSpeakerD: delayedRole(roleIds[4], accounts[4]),
      localSut: delayedRole(roleIds[5], accounts[5]),
      remotePlatformSut: delayedRole(roleIds[5], accounts[5], true, "/run/secrets/discord-sut-token"),
    };

    const receipt = await produceHostedDiscordIdentityReceiptV1({
      binding: { campaignId: "campaign-1", containerId: "platform-1", host: "test-host",
        imageDigestSha256: "a".repeat(64), planSha256: "b".repeat(64), sourceRevision: "c".repeat(40) },
      now: () => currentTime, roles, target: {
        deploymentScope: "private-test-deployment", environment: "private-test-guild", guildId,
        mutationTarget: "test-only", publicationChannelId, voiceChannelId,
      }, ttlMs: 30_000,
    });

    expect(receipt.generatedAtEpochMs).toBe(170_000);
    expect(receipt.expiresAtEpochMs).toBe(200_000);
  });
});

function expectation(
  id = applicationId,
  account: DiscordRoleIdentityExpectation["tokenFile"]["account"] = "botik-playback",
  remote = false,
  path = `/run/test-tokens/${account}`,
): DiscordRoleIdentityExpectation {
  return { applicationId: id, tokenFile: {
    account, ownerUid: 10_001, path,
    scope: remote ? "remote-deployment-secret" : "local-campaign-secret",
  } };
}

function identity(expected: DiscordRoleIdentityExpectation) {
  const tokenFile = expected.tokenFile.scope === "remote-deployment-secret"
    ? { ...expected.tokenFile, generationId: `generation-remote-${expected.tokenFile.account}`, mode: 0o400 as const }
    : { ...expected.tokenFile, generationId: `generation-${expected.tokenFile.account}`, mode: 0o600 as const };
  return {
    applicationId: expected.applicationId, authenticatedUserId: expected.applicationId, bot: true as const,
    tokenFile,
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
