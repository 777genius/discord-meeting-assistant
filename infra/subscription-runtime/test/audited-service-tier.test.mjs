import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  admitMeetingSummaryRequest,
  isPinnedCodexTaskInvocation,
  main,
  pinnedCodexTaskArgv,
} from "../audited-xhigh-launcher.mjs";

test("requires the default service tier throughout qualified admission", () => {
  const request = knowledgeAnswerRequest();
  const admitted = admitMeetingSummaryRequest(admissionInput(request));
  assert.equal(admitted.serviceTier, "default");

  for (const serviceTier of [undefined, "fast"]) {
    const changed = structuredClone(request);
    if (serviceTier === undefined) {
      delete changed.task.controls.serviceTier;
      delete changed.task.metadata.serviceTier;
    } else {
      changed.task.controls.serviceTier = serviceTier;
      changed.task.metadata.serviceTier = serviceTier;
    }
    assert.throws(
      () => admitMeetingSummaryRequest({
        ...admissionInput(changed),
        ...(serviceTier === undefined ? {} : { serviceTier }),
      }),
      /service tier|serviceTier/,
    );
  }

  const unrelated = finalRequest();
  unrelated.task.controls.serviceTier = "default";
  unrelated.task.metadata.serviceTier = "default";
  assert.throws(
    () => admitMeetingSummaryRequest({
      ...admissionInput(unrelated),
      serviceTier: "default",
    }),
    /service tier|serviceTier/,
  );
});

test("admits only the exact default-tier packaged-exec argv", () => {
  const argv = pinnedCodexTaskArgv(
    "gpt-5.6-sol",
    "medium",
    "/tmp/subscription-runtime-codex-schema-test/schema.json",
    "default",
  );
  assert.equal(
    isPinnedCodexTaskInvocation(argv, "gpt-5.6-sol", "medium", "default"),
    true,
  );
  assert.equal(isPinnedCodexTaskInvocation(argv, "gpt-5.6-sol", "medium"), false);
  const substituted = [...argv];
  substituted[substituted.indexOf('service_tier="default"')] =
    'service_tier="fast"';
  assert.equal(
    isPinnedCodexTaskInvocation(
      substituted,
      "gpt-5.6-sol",
      "medium",
      "default",
    ),
    false,
  );
});

test("passes the admitted default tier to the qualified CLI worker", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "qualified-tier-launcher-test-"));
  t.after(async () => rm(root, { force: true, recursive: true }));
  const requestPath = join(root, "request.json");
  await writeFile(requestPath, JSON.stringify(knowledgeAnswerRequest()));
  const previousReasoningEffort = process.env.AGENT_RUNTIME_REASONING_EFFORT;
  process.env.AGENT_RUNTIME_REASONING_EFFORT = "medium";
  t.after(() => restoreEnvironment(
    "AGENT_RUNTIME_REASONING_EFFORT",
    previousReasoningEffort,
  ));

  let workerOptions;
  let runtimeArgv;
  function FakeWorker(options) {
    workerOptions = options;
  }
  const { value } = await captureStdout(() => main(
    [
      "--provider", "codex",
      "--input", requestPath,
      "--state-root", root,
      "--model", "gpt-5.6-sol",
      "--service-tier", "default",
    ],
    {
      createCodexJsonlCapture: async () => ({
        configure: () => {},
        dispose: async () => {},
        usagePath: join(root, "missing-usage.json"),
        wrapperPath: join(root, "capture-wrapper"),
      }),
      FileBackendCodexWorker: FakeWorker,
      runSubscriptionAgentTaskCli: async (argv, _options, createWorker) => {
        runtimeArgv = argv;
        createWorker({
          codexBinaryPath: process.execPath,
          cwd: root,
          encryptionKey: "test-key",
          env: { PATH: process.env.PATH },
          model: "gpt-5.6-sol",
          provider: "codex",
          providerInstanceId: "test-provider",
          stateRootDir: root,
        });
        process.stdout.write(`${JSON.stringify(completedBridgeResult())}\n`);
        return 0;
      },
    },
  ));

  assert.equal(value, 0);
  assert.equal(workerOptions.model, "gpt-5.6-sol");
  assert.equal(workerOptions.reasoningEffort, "medium");
  assert.equal(workerOptions.serviceTier, "default");
  assert.equal(runtimeArgv.includes("--service-tier"), false);
});

for (const [label, serviceTierArguments] of [
  ["a missing value", ["--service-tier"]],
  ["a duplicate value", ["--service-tier", "default", "--service-tier", "default"]],
  ["conflicting values", ["--service-tier", "default", "--service-tier", "fast"]],
]) {
  test(`rejects ${label} before invoking the qualified CLI worker`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "qualified-tier-launcher-test-"));
    t.after(async () => rm(root, { force: true, recursive: true }));
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, JSON.stringify(knowledgeAnswerRequest()));
    const previousReasoningEffort = process.env.AGENT_RUNTIME_REASONING_EFFORT;
    process.env.AGENT_RUNTIME_REASONING_EFFORT = "medium";
    t.after(() => restoreEnvironment(
      "AGENT_RUNTIME_REASONING_EFFORT",
      previousReasoningEffort,
    ));
    let workerInvocations = 0;

    await assert.rejects(
      main(
        [
          "--provider", "codex",
          "--input", requestPath,
          "--state-root", root,
          "--model", "gpt-5.6-sol",
          ...serviceTierArguments,
        ],
        {
          FileBackendCodexWorker: function FakeWorker() {
            workerInvocations += 1;
          },
          runSubscriptionAgentTaskCli: async () => {
            workerInvocations += 1;
            return 0;
          },
        },
      ),
      /--service-tier/u,
    );
    assert.equal(workerInvocations, 0);
  });
}

function knowledgeAnswerRequest() {
  return requestFor({
    maxOutputTokens: 2_048,
    model: "gpt-5.6-sol",
    outputSchemaName: "discord_meeting_knowledge_answer_v1",
    policyVersion: "meeting-knowledge.answer.subscription-runtime.v3",
    purpose: "discord_meeting.knowledge.answer.v1",
    reasoningEffort: "medium",
    serviceTier: "default",
  });
}

function finalRequest() {
  return requestFor({
    maxOutputTokens: 8_192,
    model: "gpt-5.6-sol",
    outputSchemaName: "discord_meeting_summary_v4",
    policyVersion: "meeting-summary.subscription-runtime.v16",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
  });
}

function requestFor(profile) {
  const serviceTier = profile.serviceTier === undefined
    ? {}
    : { serviceTier: profile.serviceTier };
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
        ...serviceTier,
      },
      metadata: {
        model: profile.model,
        policyVersion: profile.policyVersion,
        reasoningEffort: profile.reasoningEffort,
        runtimeOutput: "structured_output",
        ...serviceTier,
      },
      outputSchemaName: profile.outputSchemaName,
    },
  };
}

function admissionInput(request) {
  return {
    model: request.task.metadata.model,
    provider: "codex",
    reasoningEffort: request.task.metadata.reasoningEffort,
    ...(request.task.metadata.serviceTier === undefined
      ? {}
      : { serviceTier: request.task.metadata.serviceTier }),
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

function restoreEnvironment(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function captureStdout(action) {
  let output = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk) => {
    output += String(chunk);
    return true;
  });
  try {
    return { output, value: await action() };
  } finally {
    process.stdout.write = originalWrite;
  }
}
