import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJsonSha256,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";
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
import {
  canonicalRequest,
  incrementalCanonicalRequest,
  isolatedCwd,
  structuredOutput,
} from "./fixture.js";

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
      reasoningEffort: "medium",
      runtimePackageVersion: "0.1.0-main.2",
    });
    expect(capturedRequest).toEqual(canonicalRequest);
    expect(inspections).toBe(2);
    expect(runs[0]?.args).toEqual(
      expect.arrayContaining([
        "--provider",
        "codex",
        "--provider-instance",
        "discord-meeting-summary-v3",
        "--model",
        "gpt-5.6-sol",
      ]),
    );
    expect(runs[0]?.cwd).toBe(isolatedCwd);
    const inputPath = runs[0]?.args[runs[0].args.indexOf("--input") + 1];
    await expect(stat(String(inputPath))).rejects.toThrow();
  });

  it("selects Luna low from the incremental purpose and preserves complete real usage", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    let processRequest: ProcessRunRequest | undefined;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async (request) => {
            processRequest = request;
            return completedProcess({
              usage: {
                cacheWriteInputTokens: 100,
                cachedInputTokens: 200,
                inputTokens: 1_000,
                outputTokens: 300,
                reasoningOutputTokens: 100,
                totalTokens: 1_300,
              },
            });
          },
        },
      }),
    );

    const result = await executor.execute(incrementalCanonicalRequest);

    expect(result).toMatchObject({
      executionAttestation: {
        model: "gpt-5.6-luna",
        purpose: "discord_meeting.summary.incremental",
        reasoningEffort: "low",
      },
      status: "completed",
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
    expect(processRequest?.args).toEqual(expect.arrayContaining([
      "--model",
      "gpt-5.6-luna",
    ]));
    expect(processRequest?.env.AGENT_RUNTIME_REASONING_EFFORT).toBe("low");
  });

  it("preserves Codex JSONL partial telemetry without fabricating cache-write input", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess({
            usage: codexJsonlTelemetry({
              cachedInputTokens: 200,
              inputTokens: 1_000,
              outputTokens: 300,
              reasoningOutputTokens: 100,
            }),
          }),
        },
      }),
    );

    const result = await executor.execute(incrementalCanonicalRequest);

    expect(result).toMatchObject({
      status: "completed",
      telemetry: {
        source: "codex_exec_jsonl",
        cacheWriteInputTokens: { availability: "unavailable" },
        cachedInputTokens: { availability: "measured", value: 200 },
        inputTokens: { availability: "measured", value: 1_000 },
        outputTokens: { availability: "measured", value: 300 },
        reasoningOutputTokens: { availability: "measured", value: 100 },
        totalTokens: {
          availability: "derived",
          derivedFrom: ["inputTokens", "outputTokens"],
          value: 1_300,
        },
      },
    });
    expect(result.status === "completed" && result.usage).toBeUndefined();
  });

  it("fails closed when a completed provider result has no usage telemetry", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: { run: async () => completedProcessWithoutTelemetry() },
      }),
    );

    await expect(executor.execute(incrementalCanonicalRequest)).resolves.toMatchObject({
      failure: { code: "telemetry_unavailable", retryable: false },
      status: "failed",
    });
  });

  it.each([
    [
      "final summary",
      canonicalRequest,
      subscriptionRuntimeSummaryMaxOutputTokens,
    ],
    [
      "incremental summary",
      incrementalCanonicalRequest,
      subscriptionRuntimeIncrementalMaxOutputTokens,
    ],
  ])("rejects a completed %s that exceeds its admitted output budget", async (
    _label,
    request,
    outputBudget,
  ) => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const outputTokens = outputBudget + 1;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess({
            usage: {
              cacheWriteInputTokens: 0,
              cachedInputTokens: 0,
              inputTokens: 100,
              outputTokens,
              reasoningOutputTokens: 0,
              totalTokens: 100 + outputTokens,
            },
          }),
        },
      }),
    );

    await expect(executor.execute(request)).resolves.toMatchObject({
      failure: { code: "provider_output_invalid", retryable: false },
      status: "failed",
      usage: { outputTokens },
    });
  });

  it("fails closed when completed telemetry leaves output tokens unmeasured", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess({
            usage: {
              source: "codex_exec_jsonl",
              cacheWriteInputTokens: { availability: "unavailable" },
              cachedInputTokens: { availability: "measured", value: 200 },
              inputTokens: { availability: "measured", value: 1_000 },
              outputTokens: { availability: "unavailable" },
              reasoningOutputTokens: { availability: "unavailable" },
              totalTokens: { availability: "unavailable" },
            },
          }),
        },
      }),
    );

    await expect(executor.execute(incrementalCanonicalRequest)).resolves
      .toMatchObject({
        failure: { code: "telemetry_unavailable", retryable: false },
        status: "failed",
        telemetry: {
          outputTokens: { availability: "unavailable" },
        },
      });
  });

  it("rejects a derived total that does not equal measured input plus output", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess({
            usage: {
              ...codexJsonlTelemetry({
                cachedInputTokens: 200,
                inputTokens: 1_000,
                outputTokens: 300,
                reasoningOutputTokens: 100,
              }),
              totalTokens: {
                availability: "derived",
                derivedFrom: ["inputTokens", "outputTokens"],
                value: 1_299,
              },
            },
          }),
        },
      }),
    );

    await expect(executor.execute(incrementalCanonicalRequest)).resolves.toMatchObject({
      failure: { code: "provider_output_invalid" },
      status: "failed",
    });
  });

  it("preserves complete usage when a runtime task fails after consuming tokens", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => failedProcess({
            usage: {
              cacheWriteInputTokens: 100,
              cachedInputTokens: 200,
              inputTokens: 1_000,
              outputTokens: 300,
              reasoningOutputTokens: 100,
              totalTokens: 1_300,
            },
          }),
        },
      }),
    );

    await expect(executor.execute(incrementalCanonicalRequest)).resolves.toMatchObject({
      failure: { code: "task_timeout", retryable: true },
      status: "failed",
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    });
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
              telemetry: {
                usage: {
                  cacheWriteInputTokens: 0,
                  cachedInputTokens: 0,
                  inputTokens: 100,
                  outputTokens: 20,
                  reasoningOutputTokens: 0,
                  totalTokens: 120,
                },
              },
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
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
        OPENAI_API_KEY: "must-not-cross",
        OTHER_API_KEY_FILE: "/secret/key",
        unrelatedSecret: "must-not-cross",
        CODEX_THREAD_ID: "must-not-cross",
      },
      "private-encryption-key",
    );

    expect(env).toEqual({
      AGENT_RUNTIME_REASONING_EFFORT: "medium",
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
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

function completedProcess(
  telemetry: Record<string, unknown> = {
    usage: {
      cacheWriteInputTokens: 0,
      cachedInputTokens: 0,
      inputTokens: 100,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      totalTokens: 120,
    },
  },
): ProcessRunResult {
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
      telemetry,
      warnings: [],
    }),
    timedOut: false,
  };
}

function completedProcessWithoutTelemetry(): ProcessRunResult {
  const completed = completedProcess();
  return {
    ...completed,
    stdout: JSON.stringify({
      protocolVersion: 1,
      status: "completed",
      outputText: JSON.stringify(structuredOutput),
      structuredOutput,
      warnings: [],
    }),
  };
}

function failedProcess(
  telemetry?: Record<string, unknown>,
): ProcessRunResult {
  return {
    exitCode: 1,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      failure: {
        code: "task_timeout",
        reconnectRequired: false,
        retryable: true,
      },
      protocolVersion: 1,
      status: "failed",
      ...(telemetry === undefined ? {} : { telemetry }),
      warnings: [],
    }),
    timedOut: false,
  };
}

function codexJsonlTelemetry(input: {
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}): Record<string, unknown> {
  return {
    source: "codex_exec_jsonl",
    cacheWriteInputTokens: { availability: "unavailable" },
    cachedInputTokens: {
      availability: "measured",
      value: input.cachedInputTokens,
    },
    inputTokens: { availability: "measured", value: input.inputTokens },
    outputTokens: { availability: "measured", value: input.outputTokens },
    reasoningOutputTokens: {
      availability: "measured",
      value: input.reasoningOutputTokens,
    },
    totalTokens: {
      availability: "derived",
      derivedFrom: ["inputTokens", "outputTokens"],
      value: input.inputTokens + input.outputTokens,
    },
  };
}
