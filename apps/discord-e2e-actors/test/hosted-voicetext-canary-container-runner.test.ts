import { describe, expect, it, vi } from "vitest";

import {
  HostedVoicetextCanaryContainerRunnerV1,
  type BoundedContainerProcessPort,
} from "../src/hosted-voicetext-canary-container-runner.js";

const input = {
  binding: {
    campaignId: "campaign-1", containerId: "container-1", fixtureSha256: "a".repeat(64), host: "host-1",
    imageDigestSha256: "b".repeat(64), planSha256: "c".repeat(64), sourceRevision: "d".repeat(40),
    transcriptExpectationSha256: "e".repeat(64),
  },
  endpoint: {
    batch: { origin: "https://batch.test", path: "/v2/listen" },
    live: { origin: "wss://live.test", path: "/v1/listen" },
  },
  fixturePath: "/fixtures/canary.ogg", timeoutMs: 20_000,
  profiles: { batch: "elevenlabs-scribe-v2", live: "elevenlabs-scribe-v2-realtime" },
} as const;

describe("hosted Voicetext canary container runner", () => {
  it("invokes only the pinned internal CLI and passes no token value", async () => {
    const signal = new AbortController().signal;
    const execute = vi.fn<BoundedContainerProcessPort["execute"]>(async () => ({
      exitCode: 0, signal: null, stderr: "", stdout: "{\"schemaVersion\":1}\n", timedOut: false,
    }));
    const result = await new HostedVoicetextCanaryContainerRunnerV1({ execute }).run({ ...input, signal });
    expect(result).toEqual({ schemaVersion: 1 });
    const request = execute.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request).toMatchObject({
      executable: "docker", maximumOutputBytes: 1_048_576, signal, timeoutMs: 20_000,
    });
    expect(request?.args).toContain("/app/apps/meeting-platform/node_modules/.bin/tsx");
    expect(request?.args).toContain("/app/apps/meeting-platform/src/run-voicetext-semantic-canary.ts");
    const fixtureDigestFlag = request?.args.indexOf("--fixture-sha256") ?? -1;
    expect(fixtureDigestFlag).toBeGreaterThan(-1);
    expect(request?.args[fixtureDigestFlag + 1]).toBe(input.binding.fixtureSha256);
    const deadlineFlag = request?.args.indexOf("--deadline-ms") ?? -1;
    expect(deadlineFlag).toBeGreaterThan(-1);
    expect(request?.args[deadlineFlag + 1]).toBe("19000");
    expect(flagValue(request?.args, "--batch-profile")).toBe(input.profiles.batch);
    expect(flagValue(request?.args, "--live-profile")).toBe(input.profiles.live);
    expect(request?.args).not.toContain("dist/run-voicetext-semantic-canary.js");
    expect(JSON.stringify(request)).not.toMatch(/token|secret/iu);
  });

  it.each([
    ["timeout", { exitCode: null, signal: null, stderr: "", stdout: "", timedOut: true }],
    ["non-zero exit", { exitCode: 2, signal: null, stderr: "", stdout: "", timedOut: false }],
    ["stderr", { exitCode: 0, signal: null, stderr: "warning", stdout: "{}", timedOut: false }],
    ["multiple JSON lines", { exitCode: 0, signal: null, stderr: "", stdout: "{}\n{}\n", timedOut: false }],
    ["invalid JSON", { exitCode: 0, signal: null, stderr: "", stdout: "nope", timedOut: false }],
  ])("fails closed on %s", async (_label, processResult) => {
    const process: BoundedContainerProcessPort = { execute: async () => processResult };
    await expect(new HostedVoicetextCanaryContainerRunnerV1(process).run(input)).rejects.toThrow();
  });

  it("rejects an outer timeout that cannot reserve internal teardown time", async () => {
    const execute = vi.fn<BoundedContainerProcessPort["execute"]>();
    await expect(new HostedVoicetextCanaryContainerRunnerV1({ execute }).run({
      ...input, timeoutMs: 1,
    })).rejects.toThrow("reserve bounded teardown");
    expect(execute).not.toHaveBeenCalled();
  });
});

function flagValue(args: readonly string[] | undefined, flag: string): string | undefined {
  if (args === undefined) {return undefined;}
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}
