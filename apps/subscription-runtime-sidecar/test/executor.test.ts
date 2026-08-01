import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJsonSha256 } from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import {
  SubscriptionRuntimeExecutor,
  buildChildEnvironment,
  type SubscriptionRuntimeExecutorOptions,
} from "../src/subscription-runtime-executor.js";
import type {
  InstallationIdentity,
  ProcessRunRequest,
  ProcessRunResult,
} from "../src/types.js";
import { canonicalRequest, isolatedCwd, structuredOutput } from "./fixture.js";

describe("SubscriptionRuntimeExecutor", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("executes the exact JSON bridge request and attests request/output hashes", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const runs: ProcessRunRequest[] = [];
    let capturedRequest: unknown;
    let inspections = 0;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        installationInspector: {
          inspect: async () => {
            inspections += 1;
            return installation();
          },
        },
        processRunner: {
          run: async (request) => {
            runs.push(request);
            const inputIndex = request.args.indexOf("--input");
            const inputPath = request.args[inputIndex + 1];
            if (inputPath === undefined) {
              throw new Error("missing input");
            }
            capturedRequest = JSON.parse(await readFile(inputPath, "utf8"));
            return completedProcess();
          },
        },
      }),
    );

    const result = await executor.execute(canonicalRequest);

    expect(result.status).toBe("completed");
    if (result.status !== "completed") {
      return;
    }
    expect(result.structuredOutput).toEqual(structuredOutput);
    expect(result.executionAttestation).toMatchObject({
      canonicalRequestSha256: canonicalJsonSha256(canonicalRequest),
      selectedOutputSha256: canonicalJsonSha256(structuredOutput),
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      runtimePackageVersion: "0.1.0-main.2",
    });
    expect(capturedRequest).toEqual(canonicalRequest);
    expect(inspections).toBe(2);
    expect(runs[0]?.args).toEqual(
      expect.arrayContaining([
        "--provider",
        "codex",
        "--provider-instance",
        "discord-meeting-summary-v1",
        "--model",
        "gpt-5.6-sol",
      ]),
    );
    expect(runs[0]?.cwd).toBe(isolatedCwd);
    const inputPath = runs[0]?.args[runs[0].args.indexOf("--input") + 1];
    await expect(stat(String(inputPath))).rejects.toThrow();
  });

  it("rejects policy conflicts before inspecting or spawning", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    let inspections = 0;
    let runs = 0;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        installationInspector: {
          inspect: async () => {
            inspections += 1;
            return installation();
          },
        },
        processRunner: {
          run: async () => {
            runs += 1;
            return completedProcess();
          },
        },
      }),
    );

    const result = await executor.execute({
      ...canonicalRequest,
      cwd: "/tmp/not-isolated",
    });

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "task_mode_unsupported", retryable: false },
    });
    expect(inspections).toBe(0);
    expect(runs).toBe(0);
  });

  it("fails safely on timeout and still removes the private input", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    let inputPath = "";
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async (request) => {
            inputPath = request.args[request.args.indexOf("--input") + 1] ?? "";
            return {
              exitCode: null,
              outputLimitExceeded: false,
              signal: "SIGTERM",
              stderr: "provider-secret-payload",
              stdout: "provider-secret-payload",
              timedOut: true,
            };
          },
        },
      }),
    );

    const result = await executor.execute(canonicalRequest);

    expect(result).toMatchObject({
      status: "failed",
      failure: { code: "task_timeout", retryable: true },
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret-payload");
    await expect(stat(inputPath)).rejects.toThrow();
  });

  it("fails closed if the installation changes after execution", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    let inspections = 0;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        installationInspector: {
          inspect: async () => ({
            ...installation(),
            launcherSha256: (++inspections === 1 ? "a" : "b").repeat(64),
          }),
        },
      }),
    );

    await expect(executor.execute(canonicalRequest)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "provider_output_invalid" },
    });
  });

  it("rejects structured output that does not satisfy the admitted schema", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => ({
            ...completedProcess(),
            stdout: JSON.stringify({
              protocolVersion: 1,
              status: "completed",
              outputText: "{}",
              structuredOutput: { invented: true },
              warnings: [],
            }),
          }),
        },
      }),
    );

    await expect(executor.execute(canonicalRequest)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "provider_output_invalid", retryable: false },
    });
  });
});

describe("subscription runtime child environment", () => {
  it("uses an allowlist and strips every API key/file and unrelated variable", () => {
    const env = buildChildEnvironment(
      {
        PATH: "/usr/bin",
        LANG: "C.UTF-8",
        OPENAI_API_KEY: "must-not-cross",
        OTHER_API_KEY_FILE: "/secret/key",
        unrelatedSecret: "must-not-cross",
        CODEX_THREAD_ID: "must-not-cross",
      },
      "private-encryption-key",
    );

    expect(env).toEqual({
      AGENT_RUNTIME_REASONING_EFFORT: "xhigh",
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
      SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY: "private-encryption-key",
    });
    expect(Object.keys(env)).not.toEqual(
      expect.arrayContaining(["OPENAI_API_KEY", "OTHER_API_KEY_FILE"]),
    );
  });
});

function options(
  keyFile: string,
  override: Partial<SubscriptionRuntimeExecutorOptions> = {},
): SubscriptionRuntimeExecutorOptions {
  return {
    authJsonPath: "/private/auth.json",
    childSourceEnvironment: {},
    installationInspector: { inspect: async () => installation() },
    isolatedCwd,
    killGraceMs: 50,
    localEncryptionKeyFile: keyFile,
    maxPromptBytes: 2 * 1_024 * 1_024,
    maxStderrBytes: 1_024,
    maxStdoutBytes: 2 * 1_024 * 1_024,
    maxTaskTimeoutMs: 600_000,
    processRunner: { run: async () => completedProcess() },
    readinessInspector: { inspect: async () => {} },
    stateRoot: "/private/state",
    ...override,
  };
}

function installation(): InstallationIdentity {
  return {
    executableRealpath: "/audited/runtime-launcher",
    launcherSha256: "a".repeat(64),
    packageManifestRealpath: "/audited/package/package.json",
    packageRootRealpath: "/audited/package",
    runtimePackageVersion: "0.1.0-main.2",
  };
}

function completedProcess(): ProcessRunResult {
  return {
    exitCode: 0,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      protocolVersion: 1,
      status: "completed",
      outputText: JSON.stringify(structuredOutput),
      structuredOutput,
      warnings: [],
    }),
    timedOut: false,
  };
}
