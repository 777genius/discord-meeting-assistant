import { describe, expect, it, vi } from "vitest";

import { HostedRemoteCraigIdentityProbe } from "../src/hosted-remote-craig-identity-probe.js";
import type {
  BoundedRemoteContainerProcessPort,
  BoundedRemoteContainerProcessResult,
} from "../src/hosted-remote-discord-identity-probe.js";

const applicationId = "1533877611258708230";
const target = {
  guildId: "1533228590643155034",
  publicationChannelId: "1533228891827736657",
  voiceChannelId: "1533228823045214398",
} as const;
const binding = {
  containerId: "1".repeat(64), host: "codex-workers-eu-01",
  imageDigestSha256: "2".repeat(64), sourceRevision: "3".repeat(40),
} as const;
const expectation = {
  applicationId,
  tokenFile: { account: "botik-playback", ownerUid: 10_001,
    path: "/run/secrets/discord_bot_token", scope: "remote-deployment-secret" },
} as const;

describe("hosted remote Craig identity probe", () => {
  it("executes a bounded proof in the pinned Craig container without discovering or passing a token", async () => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>(async () => success());
    const identity = await new HostedRemoteCraigIdentityProbe({ execute }, binding, 7_500)
      .probe(expectation, target);
    expect(identity).toMatchObject({ applicationId, authenticatedUserId: applicationId, bot: true,
      tokenFile: { path: expectation.tokenFile.path, mode: 0o400 } });
    const request = execute.mock.calls[0]?.[0];
    expect(request).toEqual({
      args: [
        "/usr/bin/env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin",
        "CRAIG_E2E_TEST_ONLY=true", `DISCORD_APPLICATION_ID=${applicationId}`,
        `CRAIG_E2E_DISCORD_GUILD_ID=${target.guildId}`,
        `CRAIG_E2E_DISCORD_CHANNEL_IDS=${target.voiceChannelId},${target.publicationChannelId}`,
        "DISCORD_BOT_TOKEN_FILE=/run/secrets/discord_bot_token",
        "/usr/local/bin/node", "--input-type=module", "--eval", expect.stringContaining(
          'const tokenPath = required("DISCORD_BOT_TOKEN_FILE")',
        ),
      ],
      binding, maximumOutputBytes: 16_384,
      target: { composeProject: "craig-meeting-e2e", composeService: "bot", workingDirectory: "/app/apps/bot" },
      timeoutMs: 7_500,
    });
    expect(JSON.stringify(request)).not.toContain("token.");
  });

  it("forwards AbortSignal and rejects mismatched or non-canonical proof", async () => {
    const controller = new AbortController();
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>(async () => success());
    await new HostedRemoteCraigIdentityProbe({ execute }, binding).probe(expectation, target, controller.signal);
    expect(execute.mock.calls[0]?.[0].signal).toBe(controller.signal);
    await expect(new HostedRemoteCraigIdentityProbe(fake({ ...success(), stdout: `${json()}\n${json()}\n` }), binding)
      .probe(expectation, target)).rejects.toThrow("non-canonical");
    await expect(new HostedRemoteCraigIdentityProbe(fake({ ...success(), stdout: `${json({ bot: { bot: true, id: "1534231284467896513" } })}\n` }), binding)
      .probe(expectation, target)).rejects.toThrow("pinned application");
  });

  it("rejects any unpinned custody before process execution", async () => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>();
    await expect(new HostedRemoteCraigIdentityProbe({ execute }, binding).probe({
      ...expectation, tokenFile: { ...expectation.tokenFile, path: "/run/secrets/other" },
    }, target)).rejects.toThrow("pinned Craig token custody");
    expect(execute).not.toHaveBeenCalled();
  });
});

function json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    bot: { bot: true, id: applicationId }, ok: true, schemaVersion: 1,
    secret: { gid: 10_001, mode: "0400", path: "/run/secrets/discord_bot_token", stable: true, uid: 10_001 },
    target: { channelIds: [target.voiceChannelId, target.publicationChannelId], guildId: target.guildId, testOnly: true },
    ...overrides,
  });
}

function success(): BoundedRemoteContainerProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout: `${json()}\n`, timedOut: false };
}

function fake(result: BoundedRemoteContainerProcessResult): BoundedRemoteContainerProcessPort {
  return { execute: async () => result };
}
