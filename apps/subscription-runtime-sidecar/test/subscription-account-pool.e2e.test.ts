import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { subscriptionRuntimeEngine } from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, expect, it } from "vitest";

import { FileRuntimeReadinessInspector } from "../src/runtime-readiness.js";
import { resolveSidecarSettings } from "../src/settings.js";
import { SubscriptionAccountPool } from "../src/subscription-account-pool.js";
import { SubscriptionRuntimeExecutor } from "../src/subscription-runtime-executor.js";
import type { ProcessRunResult } from "../src/types.js";
import { completedProcess, installation } from "./executor-test-support.js";
import { canonicalRequest } from "./fixture.js";

const sourcePolicyPath = fileURLToPath(
  new URL("../../../infra/subscription-runtime/sidecar-policy.json", import.meta.url),
);
const materializerPath = fileURLToPath(
  new URL(
    "../../../infra/subscription-runtime/materialize-account-pool.mjs",
    import.meta.url,
  ),
);
const execFileAsync = promisify(execFile);
let root: string | undefined;

interface MutablePurposeProfile {
  isolatedCwd: string;
  readonly [key: string]: unknown;
}

interface MutableDeploymentPolicy {
  custody: {
    authPoolManifestPath: string;
    localEncryptionKeyFile: string;
    stateRoot: string;
  };
  purposeProfiles: Record<string, MutablePurposeProfile>;
  transport: {
    bind: string;
    serviceTokenFile: string;
  };
}

afterEach(async () => {
  if (root !== undefined) {
    await rm(root, { force: true, recursive: true });
  }
  root = undefined;
});

it("materialized host slots fail over end-to-end without exposing account names", async () => {
  const fixture = await createPoolFixture();
  const settings = await resolveSidecarSettings(fixture.environment);
  const readiness = new FileRuntimeReadinessInspector({
    authJsonPaths: settings.accounts.map((account) => account.authJsonPath),
    isolatedCwd: settings.isolatedCwd,
    localEncryptionKeyFile: settings.localEncryptionKeyFile,
    stateRoot: settings.stateRoot,
  });
  const runs: string[][] = [];
  const executor = new SubscriptionRuntimeExecutor({
    accountPool: new SubscriptionAccountPool(settings.accounts),
    childSourceEnvironment: {},
    installationInspector: { inspect: async () => installation() },
    isolatedCwd: settings.isolatedCwd,
    killGraceMs: settings.killGraceMs,
    localEncryptionKeyFile: settings.localEncryptionKeyFile,
    maxPromptBytes: settings.maxPromptBytes,
    maxStderrBytes: settings.maxStderrBytes,
    maxStdoutBytes: settings.maxStdoutBytes,
    maxTaskTimeoutMs: settings.maxTaskTimeoutMs,
    processRunner: {
      runtimeEngine: subscriptionRuntimeEngine,
      run: async (request) => {
        runs.push([...request.args]);
        return runs.length === 1
          ? quotaLimitedProcess()
          : completedProcess();
      },
    },
    readinessInspector: readiness,
    stateRoot: settings.stateRoot,
  });

  await expect(executor.checkHealth()).resolves.toMatchObject({
    status: "serving",
  });
  await expect(executor.execute({
    ...canonicalRequest,
    cwd: settings.isolatedCwd,
  })).resolves.toMatchObject({
    status: "completed",
  });
  expect(runs.map((args) => argumentValue(args, "--provider-instance")))
    .toEqual([
      "discord-meeting-summary-v3",
      "discord-meeting-summary-v3-slot-2",
    ]);
  expect(JSON.stringify(runs)).not.toMatch(/host-account-[ab]/u);
});

async function createPoolFixture(): Promise<{
  readonly environment: NodeJS.ProcessEnv;
}> {
  root = await realpath(await mkdtemp(join(tmpdir(), "account-pool-e2e-")));
  const authSourceRoot = join(root, "host-accounts");
  const authPoolParent = join(root, "materialized");
  const authPoolRoot = join(authPoolParent, "auth-pool");
  const stateRoot = join(root, "state");
  const workspace = join(root, "workspace");
  const secretsRoot = join(root, "secrets");
  const serviceTokenFile = join(secretsRoot, "service-token");
  const encryptionKeyFile = join(secretsRoot, "local-encryption-key");
  const policyPath = join(root, "sidecar-policy.json");
  const poolManifestPath = join(authPoolRoot, "pool.json");
  const reservationManifestPath = join(root, "reservation.json");
  const hostAccountNames = ["host-account-a", "host-account-b"];
  await Promise.all([
    mkdir(authPoolParent),
    mkdir(stateRoot),
    mkdir(workspace),
    mkdir(secretsRoot),
    ...hostAccountNames.map((name) =>
      mkdir(join(authSourceRoot, name), { recursive: true })),
  ]);
  await Promise.all([
    ...hostAccountNames.map((name) => writeFile(
      join(authSourceRoot, name, "auth.json"),
      JSON.stringify({ syntheticHostAccount: name }),
      { mode: 0o600 },
    )),
    writeFile(reservationManifestPath, JSON.stringify({
      accounts: hostAccountNames,
      owner: "discord-meeting-assistant",
      schemaVersion: 1,
    }), { mode: 0o600 }),
    writeFile(serviceTokenFile, "synthetic-service-token", { mode: 0o600 }),
    writeFile(encryptionKeyFile, "synthetic-encryption-key", { mode: 0o600 }),
  ]);
  await Promise.all([
    ...hostAccountNames.map((name) =>
      chmod(join(authSourceRoot, name, "auth.json"), 0o600)),
    chmod(reservationManifestPath, 0o600),
    chmod(serviceTokenFile, 0o600),
    chmod(encryptionKeyFile, 0o600),
  ]);
  const targetUid = process.geteuid?.();
  const targetGid = process.getegid?.();
  if (targetUid === undefined || targetGid === undefined) {
    throw new Error("Account-pool E2E requires POSIX ownership APIs");
  }
  await execFileAsync(process.execPath, [
    materializerPath,
    "--auth-root",
    authSourceRoot,
    "--reservation-manifest",
    reservationManifestPath,
    "--target-root",
    authPoolRoot,
    "--target-uid",
    String(targetUid),
    "--target-gid",
    String(targetGid),
  ]);
  const policy = JSON.parse(
    await readFile(sourcePolicyPath, "utf8"),
  ) as MutableDeploymentPolicy;
  policy.transport.bind = "127.0.0.1:50052";
  policy.transport.serviceTokenFile = serviceTokenFile;
  policy.custody.authPoolManifestPath = poolManifestPath;
  policy.custody.localEncryptionKeyFile = encryptionKeyFile;
  policy.custody.stateRoot = stateRoot;
  for (const profile of Object.values(policy.purposeProfiles)) {
    profile.isolatedCwd = workspace;
  }
  await writeFile(policyPath, JSON.stringify(policy), { mode: 0o600 });
  return {
    environment: {
      SUBSCRIPTION_RUNTIME_AUTH_POOL_MANIFEST_PATH: poolManifestPath,
      SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256: "a".repeat(64),
      SUBSCRIPTION_RUNTIME_GRPC_BIND: policy.transport.bind,
      SUBSCRIPTION_RUNTIME_ISOLATED_CWD: workspace,
      SUBSCRIPTION_RUNTIME_LAUNCHER_PATH: join(root, "launcher.mjs"),
      SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY_FILE: encryptionKeyFile,
      SUBSCRIPTION_RUNTIME_PACKAGE_MANIFEST_PATH: join(root, "package.json"),
      SUBSCRIPTION_RUNTIME_PURPOSE_POLICY_FILE: policyPath,
      SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE: serviceTokenFile,
      SUBSCRIPTION_RUNTIME_STATE_ROOT: stateRoot,
    },
  };
}

function quotaLimitedProcess(): ProcessRunResult {
  return {
    exitCode: 1,
    outputLimitExceeded: false,
    signal: null,
    stderr: "",
    stdout: JSON.stringify({
      failure: {
        code: "quota_limited",
        reconnectRequired: false,
        retryable: true,
      },
      protocolVersion: 1,
      status: "failed",
      warnings: [],
    }),
    timedOut: false,
  };
}

function argumentValue(args: readonly string[], name: string): string {
  const value = args[args.indexOf(name) + 1];
  if (value === undefined) {
    throw new Error(`missing ${name}`);
  }
  return value;
}
