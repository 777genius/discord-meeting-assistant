import { realpathSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  isAdmittedCodexExecution,
  isRecord,
  pinnedCodexTaskArgv,
} from "./audited-xhigh-policy.mjs";
import { isCodexUsage } from "./audited-codex-jsonl-events.mjs";

const captureDirectoryPrefix = ".codex-jsonl-";
const staleCaptureAgeMs = 30 * 60 * 1000;
const processStartedAtMs = Math.max(
  0,
  Math.floor(Date.now() - process.uptime() * 1000),
);

export function captureConfiguration(value) {
  if (!isRecord(value)) {
    throw new Error("Codex capture configuration must be an object");
  }
  const { model, reasoningEffort, target, usagePath } = value;
  if (
    !isAdmittedCodexExecution(model, reasoningEffort) ||
    typeof target !== "string" ||
    !isAbsolute(target) ||
    typeof usagePath !== "string" ||
    !isAbsolute(usagePath)
  ) {
    throw new Error("Codex capture configuration paths must be absolute");
  }
  return { model, reasoningEffort, target, usagePath };
}

export function isPinnedCodexTaskInvocation(argv, model, reasoningEffort) {
  const expected = pinnedCodexTaskArgv(model, reasoningEffort);
  return (
    Array.isArray(argv) &&
    argv.length === expected.length &&
    argv.every((value, index) => value === expected[index])
  );
}

export async function persistCapturedUsage(captureUsage, lastUsage, usagePath) {
  if (!captureUsage || lastUsage === undefined) {
    return;
  }
  try {
    await writeFile(usagePath, JSON.stringify(lastUsage), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Missing telemetry remains unavailable; it never invalidates provider output.
  }
}

export async function createCodexJsonlCapture(stateRoot, captureModuleUrl = import.meta.url) {
  await removeStaleCodexJsonlCaptures(stateRoot);
  const root = await mkdtemp(
    join(stateRoot, `${captureDirectoryPrefix}${process.pid}-${processStartedAtMs}-`),
  );
  const usagePath = join(root, "usage.json");
  const wrapperPath = join(root, "codex-jsonl-capture.mjs");
  let configuredModel;
  let configuredTarget;
  let configuredReasoningEffort;
  return {
    configure: (target, profile) => {
      const verifiedTarget = realpathSync(target);
      const { model, reasoningEffort } = profile;
      if (configuredTarget !== undefined) {
        if (
          configuredTarget !== verifiedTarget ||
          configuredModel !== model ||
          configuredReasoningEffort !== reasoningEffort
        ) {
          throw new Error("Codex capture configuration changed after admission");
        }
        return;
      }
      writeFileSync(
        wrapperPath,
        [
          "#!/usr/bin/env node",
          `import { runCodexJsonlCapture } from ${JSON.stringify(captureModuleUrl)};`,
          `const configuration = Object.freeze(${JSON.stringify({
            model,
            reasoningEffort,
            target: verifiedTarget,
            usagePath,
          })});`,
          "process.exitCode = await runCodexJsonlCapture(process.argv.slice(2), configuration);",
          "",
        ].join("\n"),
        { encoding: "utf8", flag: "wx", mode: 0o700 },
      );
      configuredModel = model;
      configuredTarget = verifiedTarget;
      configuredReasoningEffort = reasoningEffort;
    },
    dispose: async () => rm(root, { force: true, recursive: true }),
    usagePath,
    wrapperPath,
  };
}

export async function readCapturedCodexUsage(usagePath) {
  try {
    const value = JSON.parse(await readFile(usagePath, "utf8"));
    if (isCodexUsage(value)) {
      return value;
    }
    return;
  } catch {
    return;
  }
}

async function removeStaleCodexJsonlCaptures(stateRoot, nowMs = Date.now()) {
  let entries;
  try {
    entries = await readdir(stateRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      !entry.name.startsWith(captureDirectoryPrefix) ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    ) {
      continue;
    }
    const candidate = join(stateRoot, entry.name);
    try {
      const metadata = await lstat(candidate);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        nowMs - metadata.mtimeMs <= staleCaptureAgeMs ||
        captureOwnerIsAlive(entry.name)
      ) {
        continue;
      }
      await rm(candidate, { force: true, recursive: true });
    } catch {
      // Cleanup is best-effort and must not make a healthy runtime unavailable.
    }
  }
}

function captureOwnerIsAlive(name) {
  const match = /^\.codex-jsonl-(\d+)-(\d+)-/.exec(name);
  if (match === null) {
    return false;
  }
  const pid = Number(match[1]);
  const startedAtMs = Number(match[2]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(startedAtMs) ||
    startedAtMs < 0
  ) {
    return false;
  }
  if (pid === process.pid) {
    return startedAtMs === processStartedAtMs;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}
