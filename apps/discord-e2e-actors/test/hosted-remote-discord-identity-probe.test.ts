import { describe, expect, it, vi } from "vitest";

import {
  HostedRemoteDiscordIdentityProbe,
  type BoundedRemoteContainerProcessPort,
  type BoundedRemoteContainerProcessResult,
} from "../src/hosted-remote-discord-identity-probe.js";

const applicationId = "1533877611258708230";
const guildId = "1533228590643155034";
const voiceChannelId = "1533228823045214398";
const publicationChannelId = "1533228891827736657";
const binding = {
  containerId: "platform-container-1", host: "discord-test-host",
  imageDigestSha256: "a".repeat(64), sourceRevision: "b".repeat(40),
} as const;
const expectation = {
  applicationId,
  tokenFile: {
    account: "botik-playback", ownerUid: 10_001, path: "/run/secrets/discord-botik-token",
    scope: "remote-deployment-secret",
  },
} as const;
const target = { guildId, publicationChannelId, voiceChannelId } as const;

describe("hosted remote Discord identity probe", () => {
  it("runs the pinned container-internal contract without reading or passing a token", async () => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>(async () => success());
    const identity = await new HostedRemoteDiscordIdentityProbe({ execute }, binding, 7_500)
      .probe(expectation, target);

    expect(identity).toEqual({
      applicationId, authenticatedUserId: applicationId, bot: true,
      tokenFile: { ...expectation.tokenFile, generationId: "generation-botik-7", mode: 0o400 },
      verificationSource: "discord-current-application-and-user",
    });
    const request = execute.mock.calls[0]?.[0];
    expect(request).toEqual({
      args: [
        "/app/apps/meeting-platform/node_modules/.bin/tsx",
        "/app/apps/meeting-platform/src/run-hosted-discord-identity-probe.ts",
        "--application-id", applicationId,
        "--token-file", expectation.tokenFile.path,
        "--token-owner-uid", "10001",
        "--guild-id", guildId,
        "--voice-channel-id", voiceChannelId,
        "--publication-channel-id", publicationChannelId,
        "--container-id", binding.containerId,
        "--image-digest-sha256", binding.imageDigestSha256,
        "--source-revision", binding.sourceRevision,
        "--json",
      ],
      binding, maximumOutputBytes: 16_384,
      target: { composeProject: "discord-meeting-assistant", composeService: "meeting-platform",
        workingDirectory: "/app/apps/meeting-platform" },
      timeoutMs: 7_500,
    });
    expect(JSON.stringify(request)).not.toMatch(/token\.[A-Za-z\d]/u);
  });

  it("forwards the caller cancellation signal to the remote container process", async () => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>(async () => success());
    const controller = new AbortController();

    await new HostedRemoteDiscordIdentityProbe({ execute }, binding)
      .probe(expectation, target, controller.signal);

    expect(execute.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });

  it.each([
    ["timeout", { timedOut: true }],
    ["signal", { signal: "SIGTERM" }],
    ["non-zero exit", { exitCode: 2 }],
    ["stderr", { stderr: "warning" }],
    ["multiple lines", { stdout: `${jsonOutput()}\n${jsonOutput()}\n` }],
    ["invalid JSON", { stdout: "not-json" }],
  ] as const)("fails closed on %s", async (_label, override) => {
    const process = fakeProcess({ ...success(), ...override });
    await expect(new HostedRemoteDiscordIdentityProbe(process, binding).probe(expectation, target)).rejects.toThrow();
  });

  it.each([
    ["wrong application", { authenticatedUserId: "1534231284467896513" }],
    ["wrong container", { binding: { ...output().binding, containerId: "other-container" } }],
    ["wrong image", { binding: { ...output().binding, imageDigestSha256: "c".repeat(64) } }],
    ["wrong revision", { binding: { ...output().binding, sourceRevision: "d".repeat(40) } }],
    ["wrong guild", { target: { ...target, guildId: "1533228590643155035" } }],
    ["wrong token path", { tokenCustody: { ...output().tokenCustody, path: "/run/secrets/other" } }],
    ["wrong owner", { tokenCustody: { ...output().tokenCustody, ownerUid: 10_002 } }],
  ])("rejects %s in the internal attestation", async (_label, override) => {
    const stdout = `${JSON.stringify({ ...output(), ...override })}\n`;
    await expect(new HostedRemoteDiscordIdentityProbe(fakeProcess({ ...success(), stdout }), binding)
      .probe(expectation, target)).rejects.toThrow("does not match");
  });

  it("rejects local custody before invoking the remote process", async () => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>();
    await expect(new HostedRemoteDiscordIdentityProbe({ execute }, binding).probe({
      ...expectation, tokenFile: { ...expectation.tokenFile, scope: "local-campaign-secret" },
    }, target)).rejects.toThrow("remote token custody");
    expect(execute).not.toHaveBeenCalled();
  });
});

function output() {
  return {
    authenticatedUserId: applicationId,
    binding: {
      containerId: binding.containerId,
      imageDigestSha256: binding.imageDigestSha256,
      sourceRevision: binding.sourceRevision,
    },
    bot: true,
    kind: "hosted-remote-discord-identity-probe-result",
    schemaVersion: 1,
    target,
    tokenCustody: {
      generationId: "generation-botik-7", mode: 0o400,
      ownerUid: expectation.tokenFile.ownerUid, path: expectation.tokenFile.path,
    },
  } as const;
}

function jsonOutput(): string {return JSON.stringify(output());}

function success(): BoundedRemoteContainerProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout: `${jsonOutput()}\n`, timedOut: false };
}

function fakeProcess(result: BoundedRemoteContainerProcessResult): BoundedRemoteContainerProcessPort {
  return { execute: async () => result };
}
