const subscriptionRuntimeFinalCodexModel = "gpt-5.6-sol";
const subscriptionRuntimeIncrementalCodexModel = "gpt-5.6-luna";
const subscriptionRuntimeConversationCodexModel = "gpt-5.6-luna";

const profiles = Object.freeze({
  "discord_meeting.conversation.answer": Object.freeze({
    maxOutputTokens: 512,
    model: subscriptionRuntimeConversationCodexModel,
    outputKind: "structured_output",
    outputSchemaName: "discord_meeting_conversation_answer_v1",
    policyVersion: "meeting-conversation.subscription-runtime.v1",
    provider: "codex",
    purpose: "discord_meeting.conversation.answer",
    reasoningEffort: "low",
    responseFormat: "json",
  }),
  "discord_meeting.summary.generate": Object.freeze({
    maxOutputTokens: 2_048,
    model: subscriptionRuntimeFinalCodexModel,
    outputKind: "structured_output",
    outputSchemaName: "discord_meeting_summary_v4",
    policyVersion: "meeting-summary.subscription-runtime.v9",
    provider: "codex",
    purpose: "discord_meeting.summary.generate",
    reasoningEffort: "medium",
    responseFormat: "json",
  }),
  "discord_meeting.summary.incremental": Object.freeze({
    maxOutputTokens: 2_048,
    model: subscriptionRuntimeIncrementalCodexModel,
    outputKind: "structured_output",
    outputSchemaName: "discord_meeting_incremental_summary_v1",
    policyVersion: "meeting-summary.incremental.subscription-runtime.v5",
    provider: "codex",
    purpose: "discord_meeting.summary.incremental",
    reasoningEffort: "low",
    responseFormat: "json",
  }),
});

const childEnvironmentNames = Object.freeze([
  "PATH",
  "HOME",
  "CI",
  "CODEX_HOME",
]);

/**
 * Mirrors the immutable packaged-exec argv contract in
 * @vioxen/subscription-runtime 0.1.0-main.27. Its current task path omits the
 * optional schema file; callers that do forward one receive the same exact
 * fail-closed argv with one admitted generated path.
 */
export function pinnedCodexTaskArgv(model, reasoningEffort, outputSchemaPath) {
  return Object.freeze([
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
    ...(outputSchemaPath === undefined
      ? []
      : ["--output-schema", outputSchemaPath]),
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "--skip-git-repo-check",
    "-",
  ]);
}

export function admitMeetingSummaryRequest(input) {
  const profile = profileForRequest(input.request);
  admitRequest({ ...input, profile });
  return profile;
}

function admitRequest(input) {
  const requestRecord = record(input.request, "request");
  const context = record(requestRecord.context, "request.context");
  const contextMetadata = record(context.metadata, "request.context.metadata");
  const task = record(requestRecord.task, "request.task");
  const controls = record(task.controls, "request.task.controls");
  const metadata = record(task.metadata, "request.task.metadata");
  const { profile } = input;

  assertExact(context.purpose, profile.purpose, "purpose");
  assertExact(
    contextMetadata.policyVersion,
    profile.policyVersion,
    "context.metadata.policyVersion",
  );
  assertExact(input.provider, profile.provider, "provider");
  assertExact(input.model, profile.model, "CLI model");
  assertExact(input.reasoningEffort, profile.reasoningEffort, "runtime reasoning effort");
  assertExact(controls.model, profile.model, "controls.model");
  assertExact(
    controls.maxOutputTokens,
    profile.maxOutputTokens,
    "controls.maxOutputTokens",
  );
  assertExact(controls.reasoningEffort, profile.reasoningEffort, "controls.reasoningEffort");
  assertExact(controls.responseFormat, profile.responseFormat, "controls.responseFormat");
  assertExact(controls.selectedOutputKind, profile.outputKind, "controls.selectedOutputKind");
  assertExact(
    controls.outputSchemaName,
    profile.outputSchemaName,
    "controls.outputSchemaName",
  );
  assertExact(metadata.model, profile.model, "metadata.model");
  assertExact(metadata.policyVersion, profile.policyVersion, "metadata.policyVersion");
  assertExact(metadata.reasoningEffort, profile.reasoningEffort, "metadata.reasoningEffort");
  assertExact(metadata.runtimeOutput, profile.outputKind, "metadata.runtimeOutput");
  assertExact(task.outputSchemaName, profile.outputSchemaName, "task.outputSchemaName");
  if (controls.disableTools !== true || controls.interactive !== false) {
    throw new Error("Interactive or tool-enabled execution is not admitted");
  }
  record(controls.outputSchema, "request.task.controls.outputSchema");
}

function profileForRequest(requestValue) {
  const requestRecord = record(requestValue, "request");
  const context = record(requestRecord.context, "request.context");
  const purpose = typeof context.purpose === "string" ? context.purpose.trim() : "";
  const selected = profiles[purpose];
  if (selected === undefined) {
    throw new Error("Purpose conflicts with the admitted meeting policy");
  }
  return selected;
}

export function isAdmittedCodexExecution(model, reasoningEffort) {
  return Object.values(profiles).some(
    (profile) =>
      profile.model === model && profile.reasoningEffort === reasoningEffort,
  );
}

export function subscriptionRuntimeChildEnvironment(environment) {
  return Object.fromEntries(
    childEnvironmentNames.flatMap((name) => {
      const value = environment?.[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

export function withExactModel(args, model) {
  return optionalArgument(args, "--model") === undefined
    ? [...args, "--model", model]
    : args;
}

export function requiredArgument(args, name) {
  const value = optionalArgument(args, name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function optionalArgument(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      values.push(value);
      index += 1;
    }
  }
  if (new Set(values).size > 1) {
    throw new Error(`${name} contains conflicting values`);
  }
  return values[0];
}

function assertExact(value, expected, label) {
  const matches = typeof expected === "string"
    ? typeof value === "string" && value.trim() === expected
    : value === expected;
  if (!matches) {
    throw new Error(`${label} conflicts with the admitted meeting policy`);
  }
}

function record(value, label) {
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isTokenCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
