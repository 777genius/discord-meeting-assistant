import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  admitMeetingSummaryRequest,
  attachCodexJsonlTelemetry,
  codexExecJsonlCompatibilityAgentMessage,
  codexExecJsonlUsage,
  codexJsonlTelemetry,
  isPinnedCodexTaskInvocation,
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

test("normalizes only current Codex completed agent messages", () => {
  const text = '{"summary":"keep this text exactly"}';
  const normalized = codexExecJsonlCompatibilityAgentMessage(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: "item-agent-message",
        text,
        type: "agent_message",
      },
    }),
  );

  assert.deepEqual(normalized, {
    type: "agent_message",
    role: "assistant",
    text,
  });
  assert.equal(
    codexExecJsonlCompatibilityAgentMessage(
      JSON.stringify({
        type: "item.completed",
        item: { text: "not an assistant message", type: "command_execution" },
      }),
    ),
    undefined,
  );
  assert.equal(codexExecJsonlCompatibilityAgentMessage("{malformed"), undefined);
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

test("admits only the immutable final, incremental, and conversation profiles", () => {
  const finalProfile = admitMeetingSummaryRequest(admissionInput(finalRequest(), "medium"));
  assert.deepEqual(
    {
      maxOutputTokens: finalProfile.maxOutputTokens,
      model: finalProfile.model,
      outputSchemaName: finalProfile.outputSchemaName,
      policyVersion: finalProfile.policyVersion,
      purpose: finalProfile.purpose,
      reasoningEffort: finalProfile.reasoningEffort,
    },
    {
      maxOutputTokens: 2_048,
      model: "gpt-5.6-sol",
      outputSchemaName: "discord_meeting_summary_v4",
      policyVersion: "meeting-summary.subscription-runtime.v14",
      purpose: "discord_meeting.summary.generate",
      reasoningEffort: "medium",
    },
  );

  const conversationProfile = admitMeetingSummaryRequest(
    admissionInput(conversationRequest(), "low"),
  );
  assert.deepEqual(
    {
      maxOutputTokens: conversationProfile.maxOutputTokens,
      model: conversationProfile.model,
      outputSchemaName: conversationProfile.outputSchemaName,
      policyVersion: conversationProfile.policyVersion,
      purpose: conversationProfile.purpose,
      reasoningEffort: conversationProfile.reasoningEffort,
    },
    {
      maxOutputTokens: 512,
      model: "gpt-5.6-luna",
      outputSchemaName: "discord_meeting_conversation_answer_v1",
      policyVersion: "meeting-conversation.subscription-runtime.v1",
      purpose: "discord_meeting.conversation.answer",
      reasoningEffort: "low",
    },
  );

  const incrementalProfile = admitMeetingSummaryRequest(
    admissionInput(incrementalRequest(), "low"),
  );
  assert.deepEqual(
    {
      maxOutputTokens: incrementalProfile.maxOutputTokens,
      model: incrementalProfile.model,
      outputSchemaName: incrementalProfile.outputSchemaName,
      policyVersion: incrementalProfile.policyVersion,
      purpose: incrementalProfile.purpose,
      reasoningEffort: incrementalProfile.reasoningEffort,
    },
    {
      maxOutputTokens: 2_048,
      model: "gpt-5.6-luna",
      outputSchemaName: "discord_meeting_incremental_summary_v1",
      policyVersion: "meeting-summary.incremental.subscription-runtime.v5",
      purpose: "discord_meeting.summary.incremental",
      reasoningEffort: "low",
    },
  );

  const staleIncremental = incrementalRequest();
  staleIncremental.context.metadata.policyVersion =
    "meeting-summary.incremental.subscription-runtime.v1";
  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(staleIncremental, "low")),
    /context\.metadata\.policyVersion conflicts with the admitted meeting policy/,
  );

  const oversizedIncremental = incrementalRequest();
  oversizedIncremental.task.controls.maxOutputTokens = 4_096;
  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(oversizedIncremental, "low")),
    /controls\.maxOutputTokens conflicts with the admitted meeting policy/,
  );

  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(finalRequest(), "low")),
    /runtime reasoning effort conflicts with the admitted meeting policy/,
  );

  const swappedIncrementalModel = incrementalRequest();
  swappedIncrementalModel.task.controls.model = "gpt-5.6-sol";
  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(swappedIncrementalModel, "low")),
    /controls\.model conflicts with the admitted meeting policy/,
  );

  const swappedIncrementalSchema = incrementalRequest();
  swappedIncrementalSchema.task.controls.outputSchemaName =
    "discord_meeting_summary_v4";
  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(swappedIncrementalSchema, "low")),
    /controls\.outputSchemaName conflicts with the admitted meeting policy/,
  );

  const swappedFinalSchema = finalRequest();
  swappedFinalSchema.task.outputSchemaName =
    "discord_meeting_incremental_summary_v1";
  assert.throws(
    () => admitMeetingSummaryRequest(admissionInput(swappedFinalSchema, "medium")),
    /task\.outputSchemaName conflicts with the admitted meeting policy/,
  );
});

test("admits only the two exact packaged-exec schema argv forms", () => {
  const withoutSchema = pinnedTaskArgv("gpt-5.6-sol", "medium", false);
  const withSchema = pinnedTaskArgv("gpt-5.6-sol", "medium", true);
  const schemaFlagIndex = withSchema.indexOf("--output-schema");
  const relativeSchema = [...withSchema];
  relativeSchema[schemaFlagIndex + 1] = "relative/schema.json";

  assert.equal(
    isPinnedCodexTaskInvocation(withoutSchema, "gpt-5.6-sol", "medium"),
    true,
  );
  assert.equal(
    isPinnedCodexTaskInvocation(withSchema, "gpt-5.6-sol", "medium"),
    true,
  );
  assert.equal(
    isPinnedCodexTaskInvocation(
      relativeSchema,
      "gpt-5.6-sol",
      "medium",
    ),
    false,
  );
  assert.equal(
    isPinnedCodexTaskInvocation(
      [
        ...withSchema.slice(0, -1),
        "--output-schema",
        "/tmp/subscription-runtime-codex-schema-extra/schema.json",
        "-",
      ],
      "gpt-5.6-sol",
      "medium",
    ),
    false,
  );
});

test("generated capture wrapper survives the runtime-pruned environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "subscription-runtime-launcher-test-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const requestPath = join(root, "request.json");
  const codexStubPath = join(root, "codex-stub.mjs");
  const secret = "must-not-cross-capture-boundary";
  const usagePath = () =>
    join(dirname(workerOptions.codexBinaryPath), "usage.json");
  await writeFile(requestPath, JSON.stringify(incrementalRequest()));
  await writeFile(
    codexStubPath,
    [
      "#!/usr/bin/env node",
      "process.stdout.write(`${JSON.stringify({ type: 'stub.invoked', argv: process.argv.slice(2) })}\\n`);",
      "const agentMessage = JSON.stringify({",
      "  type: 'item.completed',",
      "  item: {",
      "    id: 'item-agent-message',",
      "    text: '{\\\"summary\\\":\\\"chunked assistant message\\\"}',",
      "    type: 'agent_message',",
      "  },",
      "});",
      "process.stdout.write(agentMessage.slice(0, 17));",
      "await new Promise((resolve) => setTimeout(resolve, 5));",
      "process.stdout.write(`${agentMessage.slice(17)}\\n`);",
      "const refreshProbe = !process.argv.includes('--ignore-user-config');",
      "process.stdout.write(`${JSON.stringify({",
      "  type: 'turn.completed',",
      "  usage: {",
      "    cached_input_tokens: refreshProbe ? 2 : 200,",
      "    input_tokens: refreshProbe ? 10 : 1_000,",
      "    output_tokens: refreshProbe ? 3 : 300,",
      "    reasoning_output_tokens: refreshProbe ? 1 : 100,",
      "  },",
      "})}\\n`);",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  const cleanupFixture = await createCaptureCleanupFixture(root, t);
  const previousReasoningEffort = process.env.AGENT_RUNTIME_REASONING_EFFORT;
  process.env.AGENT_RUNTIME_REASONING_EFFORT = "low";
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
          codexBinaryPath: codexStubPath,
          cwd: root,
          encryptionKey: "test-key",
          env: {
            CI: "true",
            CODEX_HOME: join(root, "source-codex-home"),
            HOME: join(root, "source-home"),
            LOCAL_ENCRYPTION_KEY: secret,
            OPENAI_API_KEY: secret,
            PATH: process.env.PATH,
            SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY: secret,
          },
          model: "gpt-5.6-luna",
          provider: "codex",
          providerInstanceId: "test-provider",
          stateRootDir: root,
          timeoutMs: 1_000,
        });
        assert.deepEqual(
          Object.keys(workerOptions.sourceEnv).toSorted(),
          ["CI", "CODEX_HOME", "HOME", "PATH"],
        );
        assert.equal(workerOptions.executionEngine, "packaged-exec");
        assert.equal(workerOptions.reasoningEffort, "low");
        assert.equal(workerOptions.sourceEnv.LOCAL_ENCRYPTION_KEY, undefined);
        assert.equal(workerOptions.sourceEnv.OPENAI_API_KEY, undefined);
        assert.equal(
          workerOptions.sourceEnv.SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY,
          undefined,
        );

        const wrapperMode = (await stat(workerOptions.codexBinaryPath)).mode & 0o777;
        assert.equal(wrapperMode, 0o700);
        const prunedEnvironment = {
          CI: "true",
          CODEX_HOME: join(root, "codex-home"),
          HOME: root,
          PATH: process.env.PATH,
        };
        const refresh = await runExecutable(
          workerOptions.codexBinaryPath,
          [
            "exec",
            "--model",
            "gpt-5.6-luna",
            "--sandbox",
            "read-only",
            "--ignore-rules",
            "--ephemeral",
            "-C",
            join(root, "refresh-cwd"),
            "--skip-git-repo-check",
            "-",
          ],
          prunedEnvironment,
        );
        assert.equal(refresh.exitCode, 0);
        assert.equal(
          refresh.stdout
            .trim()
            .split("\n")
            .map(JSON.parse)
            .some((event) => event.type === "agent_message"),
          false,
        );
        await assert.rejects(readFile(usagePath(), "utf8"), { code: "ENOENT" });
        const captured = await runExecutable(
          workerOptions.codexBinaryPath,
          pinnedTaskArgv("gpt-5.6-luna", "low", false),
          prunedEnvironment,
        );
        assert.equal(captured.exitCode, 0);
        assert.equal(captured.stderr, "");
        assert.equal(captured.stdout.includes(secret), false);
        const events = captured.stdout.trim().split("\n").map(JSON.parse);
        assert.deepEqual(events[0], {
          type: "stub.invoked",
          argv: pinnedTaskArgv("gpt-5.6-luna", "low", false),
        });
        assert.deepEqual(events[1], {
          type: "item.completed",
          item: {
            id: "item-agent-message",
            text: '{"summary":"chunked assistant message"}',
            type: "agent_message",
          },
        });
        assert.deepEqual(events[2], {
          type: "agent_message",
          role: "assistant",
          text: '{"summary":"chunked assistant message"}',
        });
        assert.equal(events[3].type, "turn.completed");
        assert.deepEqual(
          JSON.parse(
            await readFile(
              usagePath(),
              "utf8",
            ),
          ),
          {
            cachedInputTokens: 200,
            inputTokens: 1_000,
            outputTokens: 300,
            reasoningOutputTokens: 100,
          },
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
  await assertCaptureCleanup(cleanupFixture);
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
  return summaryRequest({
    maxOutputTokens: 2_048,
    model: "gpt-5.6-luna",
    outputSchemaName: "discord_meeting_incremental_summary_v1",
    policyVersion: "meeting-summary.incremental.subscription-runtime.v5",
    purpose: "discord_meeting.summary.incremental",
    reasoningEffort: "low",
  });
}

function conversationRequest() {
  return summaryRequest({
    maxOutputTokens: 512,
    model: "gpt-5.6-luna",
    outputSchemaName: "discord_meeting_conversation_answer_v1",
    policyVersion: "meeting-conversation.subscription-runtime.v1",
    purpose: "discord_meeting.conversation.answer",
    reasoningEffort: "low",
  });
}

function finalRequest() {
  return summaryRequest({
    maxOutputTokens: 2_048,
    model: "gpt-5.6-sol",
    outputSchemaName: "discord_meeting_summary_v4",
    policyVersion: "meeting-summary.subscription-runtime.v14",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
  });
}

function summaryRequest(profile) {
  return {
    context: {
      metadata: { policyVersion: profile.policyVersion },
      purpose: profile.purpose,
    },
    task: {
      controls: {
        disableTools: true,
        interactive: false,
        maxOutputTokens: profile.maxOutputTokens,
        model: profile.model,
        outputSchema: {},
        outputSchemaName: profile.outputSchemaName,
        reasoningEffort: profile.reasoningEffort,
        responseFormat: "json",
        selectedOutputKind: "structured_output",
      },
      metadata: {
        model: profile.model,
        policyVersion: profile.policyVersion,
        reasoningEffort: profile.reasoningEffort,
        runtimeOutput: "structured_output",
      },
      outputSchemaName: profile.outputSchemaName,
    },
  };
}

function admissionInput(request, reasoningEffort) {
  return {
    model: request.task.metadata.model,
    provider: "codex",
    reasoningEffort,
    request,
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

function pinnedTaskArgv(model, reasoningEffort, includeOutputSchema = true) {
  const outputSchemaPath = join(
    "/tmp",
    "subscription-runtime-codex-schema-test",
    "schema.json",
  );
  return [
    "exec",
    "--json",
    "--model",
    model,
    "--sandbox",
    "read-only",
    "--config",
    'approval_policy="never"',
    "--config",
    'cli_auth_credentials_store="file"',
    "--config",
    `model_reasoning_effort="${reasoningEffort}"`,
    "--config",
    'model_verbosity="low"',
    "--config",
    'web_search="disabled"',
    "--config",
    "features.apps=false",
    "--config",
    "features.hooks=false",
    "--config",
    "features.memories=false",
    "--config",
    "features.multi_agent=false",
    "--config",
    "features.shell_snapshot=false",
    "--config",
    "features.skill_mcp_dependency_install=false",
    "--config",
    "sandbox_workspace_write.network_access=true",
    "--config",
    "features.network_proxy.enabled=true",
    "--config",
    'features.network_proxy.domains={ "api.openai.com" = "allow" }',
    ...(includeOutputSchema ? ["--output-schema", outputSchemaPath] : []),
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-",
  ];
}

async function createCaptureCleanupFixture(root, t) {
  const activeOwner = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 60_000)"],
    { stdio: "ignore" },
  );
  assert.equal(Number.isInteger(activeOwner.pid), true);
  t.after(() => activeOwner.kill());
  const stale = join(root, ".codex-jsonl-99999999-1-stale");
  const active = join(root, `.codex-jsonl-${activeOwner.pid}-1-active`);
  const recent = join(root, ".codex-jsonl-99999999-1-recent");
  const protectedDirectory = join(root, "protected-capture-target");
  const protectedMarker = join(protectedDirectory, "marker");
  const link = join(root, ".codex-jsonl-99999999-1-link");
  const oldFile = join(root, ".codex-jsonl-99999999-1-file");
  await Promise.all([
    mkdir(stale),
    mkdir(active),
    mkdir(recent),
    mkdir(protectedDirectory),
  ]);
  await Promise.all([
    writeFile(protectedMarker, "protected"),
    writeFile(oldFile, "not-a-directory"),
    symlink(protectedDirectory, link, "dir"),
  ]);
  const old = new Date(Date.now() - 31 * 60 * 1000);
  await Promise.all([
    utimes(stale, old, old),
    utimes(active, old, old),
    utimes(oldFile, old, old),
  ]);
  return { active, link, oldFile, protectedMarker, recent, stale };
}

async function assertCaptureCleanup(fixture) {
  await assert.rejects(stat(fixture.stale), { code: "ENOENT" });
  assert.equal((await stat(fixture.active)).isDirectory(), true);
  assert.equal((await stat(fixture.recent)).isDirectory(), true);
  assert.equal((await lstat(fixture.link)).isSymbolicLink(), true);
  assert.equal((await stat(fixture.protectedMarker)).isFile(), true);
  assert.equal((await stat(fixture.oldFile)).isFile(), true);
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

async function runExecutable(command, args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({
        exitCode,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}
