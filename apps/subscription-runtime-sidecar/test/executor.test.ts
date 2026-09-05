import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJsonSha256,
  subscriptionRuntimeConversationMaxOutputTokens,
  subscriptionRuntimeIncrementalMaxOutputTokens,
  subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
  subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
  subscriptionRuntimeSummaryMaxOutputTokens,
} from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import {
  SubscriptionRuntimeExecutor,
  buildChildEnvironment,
} from "../src/subscription-runtime-executor.js";
import type { ProcessRunRequest } from "../src/types.js";
import {
  canonicalRequest,
  conversationCanonicalRequest,
  conversationStructuredOutput,
  incrementalCanonicalRequest,
  isolatedCwd,
  knowledgeAnswerCanonicalRequest,
  knowledgeAnswerStructuredOutput,
  knowledgeCoverageCanonicalRequest,
  knowledgeCoverageStructuredOutput,
  structuredOutput,
} from "./fixture.js";
import {
  codexJsonlTelemetry,
  completedProcess,
  completedProcessWithoutTelemetry,
  executorOptions as options,
  failedProcess,
  installation,
} from "./executor-test-support.js";

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { force: true, recursive: true });
  }
  root = undefined;
});

describe("SubscriptionRuntimeExecutor execution profiles and output", () => {
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
      runtimeEngine: "subscription-runtime-app-server",
      runtimePackageVersion: "0.1.0-main.27",
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

  it("selects Luna low and the 512-token answer profile for conversation", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    let processRequest: ProcessRunRequest | undefined;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async (request) => {
            processRequest = request;
            return completedProcess(
              {
                usage: {
                  cacheWriteInputTokens: 0,
                  cachedInputTokens: 0,
                  inputTokens: 100,
                  outputTokens: 128,
                  reasoningOutputTokens: 0,
                  totalTokens: 228,
                },
              },
              conversationStructuredOutput,
            );
          },
        },
      }),
    );

    await expect(executor.execute(conversationCanonicalRequest)).resolves
      .toMatchObject({
        executionAttestation: {
          model: "gpt-5.6-luna",
          purpose: "discord_meeting.conversation.answer",
          reasoningEffort: "low",
        },
        status: "completed",
        structuredOutput: conversationStructuredOutput,
      });
    expect(processRequest?.args).toEqual(expect.arrayContaining([
      "--model",
      "gpt-5.6-luna",
    ]));
    expect(processRequest?.env.AGENT_RUNTIME_REASONING_EFFORT).toBe("low");
  });

  it.each([
    [knowledgeAnswerCanonicalRequest, knowledgeAnswerStructuredOutput, "default"],
    [knowledgeCoverageCanonicalRequest, knowledgeCoverageStructuredOutput, undefined],
  ] as const)(
    "executes and attests the dedicated knowledge purpose %#",
    executesDedicatedKnowledgePurpose,
  );

  it.each([undefined, "fast"])(
    "rejects completed qualified execution with service-tier proof %s",
    rejectsChangedQualifiedServiceTierProof,
  );

  it("applies the compact schema only to the incremental purpose", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const expandedFinalOutput = {
      ...structuredOutput,
      decisions: Array.from({ length: 4 }, () => ({
        evidenceTurnIds: ["turn-1"],
        text: "Подтверждено решение",
      })),
    };
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess(
            {
              usage: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 0,
                inputTokens: 100,
                outputTokens: 100,
                reasoningOutputTokens: 0,
                totalTokens: 200,
              },
            },
            expandedFinalOutput,
          ),
        },
      }),
    );

    await expect(executor.execute(canonicalRequest)).resolves.toMatchObject({
      status: "completed",
      structuredOutput: expandedFinalOutput,
    });
    await expect(executor.execute(incrementalCanonicalRequest)).resolves
      .toMatchObject({
        failure: { code: "provider_output_invalid", retryable: false },
        status: "failed",
    });
  });

});

async function executesDedicatedKnowledgePurpose(
  request:
    | typeof knowledgeAnswerCanonicalRequest
    | typeof knowledgeCoverageCanonicalRequest,
  output:
    | typeof knowledgeAnswerStructuredOutput
    | typeof knowledgeCoverageStructuredOutput,
  serviceTier: "default" | undefined,
): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
  const keyFile = join(root, "local-encryption-key");
  await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
  const processRequests: ProcessRunRequest[] = [];
  const executor = new SubscriptionRuntimeExecutor(options(keyFile, {
    processRunner: {
      run: async (processRequest) => {
        processRequests.push(processRequest);
        return {
          ...completedProcess({
            usage: {
              cacheWriteInputTokens: 0,
              cachedInputTokens: 0,
              inputTokens: 200,
              outputTokens: 40,
              reasoningOutputTokens: 10,
              totalTokens: 240,
            },
          }, output),
          ...(serviceTier === undefined ? {} : { serviceTier }),
        };
      },
    },
  }));

  await expect(executor.execute(request)).resolves.toMatchObject({
    executionAttestation: {
      model: "gpt-5.6-sol",
      purpose: request.context.purpose,
      reasoningEffort: "medium",
      ...(serviceTier === undefined ? {} : { serviceTier }),
    },
    status: "completed",
    structuredOutput: output,
  });
  expect(processRequests).toHaveLength(1);
  if (serviceTier === undefined) {
    expect(processRequests[0]?.args).not.toContain("--service-tier");
  } else {
    expect(processRequests[0]?.args).toEqual(
      expect.arrayContaining(["--service-tier", serviceTier]),
    );
  }
}

async function rejectsChangedQualifiedServiceTierProof(
  serviceTier: string | undefined,
): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
  const keyFile = join(root, "local-encryption-key");
  await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
  const executor = new SubscriptionRuntimeExecutor(options(keyFile, {
    processRunner: {
      run: async () => ({
        ...completedProcess(undefined, knowledgeAnswerStructuredOutput),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      }),
    },
  }));

  await expect(executor.execute(knowledgeAnswerCanonicalRequest)).resolves
    .toMatchObject({
      failure: { code: "task_mode_unsupported", retryable: false },
      status: "failed",
    });
}

describe("SubscriptionRuntimeExecutor telemetry", () => {
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

  it("accepts an attested conversation answer without inventing app-server usage", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "local-encryption-key");
    await writeFile(keyFile, "private-test-key\n", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcessWithoutTelemetry(
            conversationStructuredOutput,
          ),
        },
      }),
    );

    const result = await executor.execute(conversationCanonicalRequest);

    expect(result).toMatchObject({
      executionAttestation: {
        purpose: "discord_meeting.conversation.answer",
      },
      status: "completed",
      structuredOutput: conversationStructuredOutput,
    });
    expect(result.status === "completed" && result.usage).toBeUndefined();
    expect(result.status === "completed" && result.telemetry).toBeUndefined();
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
    [
      "conversation answer",
      conversationCanonicalRequest,
      subscriptionRuntimeConversationMaxOutputTokens,
    ],
    [
      "knowledge answer",
      knowledgeAnswerCanonicalRequest,
      subscriptionRuntimeKnowledgeAnswerMaxOutputTokens,
    ],
    [
      "knowledge coverage",
      knowledgeCoverageCanonicalRequest,
      subscriptionRuntimeKnowledgeCoverageMaxOutputTokens,
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
          run: async () => ({
            ...completedProcess({
              usage: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 0,
                inputTokens: 100,
                outputTokens,
                reasoningOutputTokens: 0,
                totalTokens: 100 + outputTokens,
              },
            }),
            ...(request.context.purpose === "discord_meeting.knowledge.answer.v1"
              ? { serviceTier: "default" }
              : {}),
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

});

describe("SubscriptionRuntimeExecutor safety and failures", () => {
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

  it.each([
    ["is blank", { answer: " " }],
    ["exceeds 2,000 characters", { answer: "x".repeat(2_001) }],
    ["has an unknown field", { ...conversationStructuredOutput, extra: true }],
  ] as const)("rejects a conversation answer that %s", async (_label, output) => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async () => completedProcess(
            {
              usage: {
                cacheWriteInputTokens: 0,
                cachedInputTokens: 0,
                inputTokens: 100,
                outputTokens: 20,
                reasoningOutputTokens: 0,
                totalTokens: 120,
              },
            },
            output,
          ),
        },
      }),
    );

    await expect(executor.execute(conversationCanonicalRequest)).resolves
      .toMatchObject({
        failure: { code: "provider_output_invalid", retryable: false },
        status: "failed",
      });
  });

  it("propagates cancellation to the process runner and returns task_cancelled", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-executor-test-"));
    const keyFile = join(root, "key");
    await writeFile(keyFile, "key", { mode: 0o600 });
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const executor = new SubscriptionRuntimeExecutor(
      options(keyFile, {
        processRunner: {
          run: async (request) => {
            receivedSignal = request.signal;
            controller.abort();
            return {
              ...completedProcess(undefined, conversationStructuredOutput),
              cancelled: true,
            };
          },
        },
      }),
    );

    await expect(executor.execute(conversationCanonicalRequest, controller.signal))
      .resolves.toMatchObject({
        failure: { code: "task_cancelled" },
        status: "failed",
      });
    expect(receivedSignal).toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);
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
