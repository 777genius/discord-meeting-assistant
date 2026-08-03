import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  attachCodexJsonlTelemetry,
  codexExecJsonlUsage,
  codexJsonlTelemetry,
  main,
  parseBridgeResultJson,
} from "../audited-xhigh-launcher.mjs";

test("extracts the documented Codex turn.completed JSONL usage", () => {
  const ignored = codexExecJsonlUsage(
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  );
  const usage = codexExecJsonlUsage(
    JSON.stringify({
      type: "turn.completed",
      usage: {
        cached_input_tokens: 24_448,
        input_tokens: 24_763,
        output_tokens: 122,
        reasoning_output_tokens: 0,
      },
    }),
  );

  assert.equal(ignored, undefined);
  assert.deepEqual(usage, {
    cachedInputTokens: 24_448,
    inputTokens: 24_763,
    outputTokens: 122,
    reasoningOutputTokens: 0,
  });
});

test("marks missing cache-write input unavailable and derives only total tokens", () => {
  const telemetry = codexJsonlTelemetry({
    cachedInputTokens: 200,
    inputTokens: 1_000,
    outputTokens: 300,
    reasoningOutputTokens: 100,
  });

  assert.deepEqual(telemetry, {
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
  });
});

test("enriches bridge metadata but does not overwrite fully measured bridge usage", () => {
  const captured = {
    cachedInputTokens: 200,
    inputTokens: 1_000,
    outputTokens: 300,
    reasoningOutputTokens: 100,
  };
  const enriched = attachCodexJsonlTelemetry(
    {
      status: "completed",
      telemetry: { durationMs: 23_600, finishReason: "stop" },
    },
    captured,
  );
  const complete = {
    status: "completed",
    telemetry: {
      usage: {
        cacheWriteInputTokens: 100,
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
        totalTokens: 1_300,
      },
    },
  };

  assert.equal(enriched.telemetry.durationMs, 23_600);
  assert.deepEqual(enriched.telemetry.usage, codexJsonlTelemetry(captured));
  assert.equal(attachCodexJsonlTelemetry(complete, captured), complete);
});

test("main enriches one captured bridge result with Codex JSONL telemetry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-launcher-test-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const requestPath = join(root, "request.json");
  await writeFile(requestPath, JSON.stringify(incrementalRequest()));
  const previousReasoningEffort = process.env.AGENT_RUNTIME_REASONING_EFFORT;
  process.env.AGENT_RUNTIME_REASONING_EFFORT = "medium";
  t.after(() => {
    if (previousReasoningEffort === undefined) {
      delete process.env.AGENT_RUNTIME_REASONING_EFFORT;
    } else {
      process.env.AGENT_RUNTIME_REASONING_EFFORT = previousReasoningEffort;
    }
  });

  let workerOptions;
  function FakeWorker(options) {
    workerOptions = options;
  }
  const { output, value } = await captureStdout(() => main(
    [
      "--provider",
      "codex",
      "--input",
      requestPath,
      "--state-root",
      root,
      "--model",
      "gpt-5.6-luna",
    ],
    {
      FileBackendCodexWorker: FakeWorker,
      runSubscriptionAgentTaskCli: async (_argv, _unused, createWorker) => {
        createWorker({
          codexBinaryPath: process.execPath,
          cwd: root,
          encryptionKey: "test-key",
          env: { PATH: resolve(root, "hostile-path") },
          model: "gpt-5.6-luna",
          provider: "codex",
          providerInstanceId: "test-provider",
          stateRootDir: root,
          timeoutMs: 1_000,
        });
        await writeFile(
          workerOptions.sourceEnv.SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_PATH,
          JSON.stringify({
            cachedInputTokens: 200,
            inputTokens: 1_000,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          }),
        );
        process.stdout.write(JSON.stringify({
          outputText: "{}",
          protocolVersion: 1,
          status: "completed",
          structuredOutput: {},
          telemetry: { durationMs: 23_600, finishReason: "stop" },
          warnings: [],
        }));
        return 0;
      },
    },
  ));

  assert.equal(value, 0);
  assert.equal(
    workerOptions.sourceEnv.SUBSCRIPTION_RUNTIME_CODEX_CAPTURE_TARGET,
    await realpath(process.execPath),
  );
  assert.deepEqual(JSON.parse(output), {
    outputText: "{}",
    protocolVersion: 1,
    status: "completed",
    structuredOutput: {},
    telemetry: {
      durationMs: 23_600,
      finishReason: "stop",
      usage: codexJsonlTelemetry({
        cachedInputTokens: 200,
        inputTokens: 1_000,
        outputTokens: 300,
        reasoningOutputTokens: 100,
      }),
    },
    warnings: [],
  });
  assert.equal(output.endsWith("\n"), true);
});

test("rejects malformed or multiple bridge result JSON payloads", () => {
  assert.equal(parseBridgeResultJson("not-json"), undefined);
  assert.equal(
    parseBridgeResultJson(
      `${JSON.stringify(completedBridgeResult())}\n${JSON.stringify(completedBridgeResult())}`,
    ),
    undefined,
  );
});

function incrementalRequest() {
  return {
    context: { purpose: "discord_meeting.summary.incremental" },
    task: {
      controls: {
        disableTools: true,
        interactive: false,
        model: "gpt-5.6-luna",
        outputSchema: {},
        reasoningEffort: "medium",
        responseFormat: "json",
        selectedOutputKind: "structured_output",
      },
      metadata: {
        model: "gpt-5.6-luna",
        reasoningEffort: "medium",
        runtimeOutput: "structured_output",
      },
    },
  };
}

function completedBridgeResult() {
  return {
    outputText: "{}",
    protocolVersion: 1,
    status: "completed",
    structuredOutput: {},
    warnings: [],
  };
}

async function captureStdout(run) {
  const chunks = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
    const completion = typeof encoding === "function" ? encoding : callback;
    if (typeof completion === "function") {
      queueMicrotask(completion);
    }
    return true;
  };
  try {
    const value = await run();
    return { output: Buffer.concat(chunks).toString("utf8"), value };
  } finally {
    process.stdout.write = originalWrite;
  }
}
