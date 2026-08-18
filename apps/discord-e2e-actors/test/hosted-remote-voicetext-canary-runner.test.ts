import { describe, expect, it, vi } from "vitest";

import type {
  BoundedRemoteContainerProcessPort,
  BoundedRemoteContainerProcessResult,
} from "../src/hosted-remote-discord-identity-probe.js";
import { HostedRemoteVoicetextCanaryRunnerV1 } from "../src/hosted-remote-voicetext-canary-runner.js";

const input = {
  binding: {
    campaignId: "campaign-1", containerId: "1".repeat(64), fixtureSha256: "a".repeat(64), host: "test-host",
    imageDigestSha256: "b".repeat(64), planSha256: "c".repeat(64), sourceRevision: "d".repeat(40),
    transcriptExpectationSha256: "e".repeat(64),
  },
  endpoint: {
    batch: { origin: "https://batch.test", path: "/v2/listen" },
    live: { origin: "wss://live.test", path: "/v1/listen" },
  },
  fixturePath: "/app/fixtures/canary.ogg", requiredTerms: ["Meeting Platform", "Craig recording"], timeoutMs: 20_000,
  profiles: { batch: "elevenlabs-scribe-v2", live: "elevenlabs-scribe-v2-realtime" },
} as const;

describe("hosted remote Voicetext canary runner", () => {
  it("executes only the pinned internal argv against the immutable remote binding", async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>(async () => ok("{\"schemaVersion\":1}\n"));

    await expect(new HostedRemoteVoicetextCanaryRunnerV1({ execute }).run({ ...input, signal }))
      .resolves.toEqual({ schemaVersion: 1 });

    const request = execute.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      binding: {
        containerId: input.binding.containerId,
        host: input.binding.host,
        imageDigestSha256: input.binding.imageDigestSha256,
        sourceRevision: input.binding.sourceRevision,
      },
      maximumOutputBytes: 1_048_576,
      signal,
      target: { composeProject: "discord-meeting-assistant", composeService: "meeting-platform",
        workingDirectory: "/app/apps/meeting-platform" },
      timeoutMs: 20_000,
    });
    expect(request?.args.slice(0, 2)).toEqual([
      "/app/apps/meeting-platform/node_modules/.bin/tsx",
      "/app/apps/meeting-platform/src/run-voicetext-semantic-canary.ts",
    ]);
    expect(flagValue(request?.args, "--deadline-ms")).toBe("19000");
    expect(flagValue(request?.args, "--fixture-sha256")).toBe(input.binding.fixtureSha256);
    expect(flagValue(request?.args, "--batch-profile")).toBe(input.profiles.batch);
    expect(flagValue(request?.args, "--keyterms-json")).toBe(JSON.stringify(input.requiredTerms));
    expect(flagValue(request?.args, "--live-profile")).toBe(input.profiles.live);
    expect(request?.args).not.toContain("docker");
    expect(request?.args).not.toContain("sh");
    expect(request?.args).not.toContain("-c");
    expect(JSON.stringify(request)).not.toMatch(/token|secret/iu);
  });

  it("forwards cancellation and rejects pre-aborted runs before process execution", async () => {
    const controller = new AbortController();
    controller.abort(new Error("campaign stopped"));
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>();
    await expect(new HostedRemoteVoicetextCanaryRunnerV1({ execute }).run({ ...input, signal: controller.signal }))
      .rejects.toThrow("campaign stopped");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["timeout", { ...ok(""), timedOut: true }],
    ["signal", { ...ok(""), signal: "SIGTERM" as const }],
    ["non-zero exit", { ...ok(""), exitCode: 2 }],
    ["stderr", { ...ok("{}"), stderr: "warning" }],
    ["multiple lines", ok("{}\n{}\n")],
    ["invalid JSON", ok("nope")],
  ])("fails closed on %s", async (_label, result) => {
    await expect(new HostedRemoteVoicetextCanaryRunnerV1(fakeProcess(result)).run(input)).rejects.toThrow();
  });

  it.each([
    ["short container ID", { binding: { ...input.binding, containerId: "container-1" } }],
    ["non-TLS batch", { endpoint: { ...input.endpoint, batch: { ...input.endpoint.batch, origin: "http://batch.test" } } }],
    ["relative fixture", { fixturePath: "fixtures/canary.ogg" }],
    ["too-short timeout", { timeoutMs: 1 }],
    ["unknown profile", { profiles: { ...input.profiles, batch: "other" } }],
    ["untrimmed keyterm", { requiredTerms: [" Meeting Platform"] }],
  ])("rejects invalid input: %s", async (_label, override) => {
    const execute = vi.fn<BoundedRemoteContainerProcessPort["execute"]>();
    await expect(new HostedRemoteVoicetextCanaryRunnerV1({ execute }).run({
      ...input,
      ...override,
    } as never))
      .rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
});

function ok(stdout: string): BoundedRemoteContainerProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout, timedOut: false };
}

function fakeProcess(result: BoundedRemoteContainerProcessResult): BoundedRemoteContainerProcessPort {
  return { execute: async () => result };
}

function flagValue(args: readonly string[] | undefined, flag: string): string | undefined {
  if (args === undefined) {return undefined;}
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
