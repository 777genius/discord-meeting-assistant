import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  incrementalMeetingSummaryOutputSchemaName,
  incrementalMeetingSummaryPolicyVersion,
  meetingSummaryOutputSchemaName,
  meetingSummaryPolicyVersion,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimePurpose,
} from "@discord-meeting/subscription-runtime-adapter";
import { afterEach, describe, expect, it } from "vitest";

import { resolveSidecarSettings } from "../src/settings.js";

const sourcePolicyPath = fileURLToPath(
  new URL("../../../infra/subscription-runtime/sidecar-policy.json", import.meta.url),
);
let root: string | undefined;

interface MutablePurposeProfile {
  isolatedCwd: string;
  outputSchemaName?: string;
  policyVersion?: string;
  readonly [key: string]: unknown;
}

interface MutableDeploymentPolicy {
  custody: {
    authJsonPath: string;
    localEncryptionKeyFile: string;
    stateRoot: string;
  };
  purposeProfiles: Record<string, MutablePurposeProfile>;
  transport: {
    bind: string;
    serviceTokenFile: string;
  };
}

const invalidPolicyVersionCases: readonly [
  string,
  (policy: MutableDeploymentPolicy) => void,
][] = [
  ["a missing final version", (policy) => {
    delete policy.purposeProfiles[subscriptionRuntimePurpose]?.policyVersion;
  }],
  ["a stale incremental version", (policy) => {
    const incremental = policy.purposeProfiles[subscriptionRuntimeIncrementalPurpose];
    if (incremental !== undefined) {
      incremental.policyVersion = "meeting-summary.incremental.subscription-runtime.v1";
    }
  }],
  ["swapped final and incremental versions", (policy) => {
    const final = policy.purposeProfiles[subscriptionRuntimePurpose];
    const incremental = policy.purposeProfiles[subscriptionRuntimeIncrementalPurpose];
    if (final !== undefined) {
      final.policyVersion = incrementalMeetingSummaryPolicyVersion;
    }
    if (incremental !== undefined) {
      incremental.policyVersion = meetingSummaryPolicyVersion;
    }
  }],
  ["swapped final and incremental output schemas", (policy) => {
    const final = policy.purposeProfiles[subscriptionRuntimePurpose];
    const incremental = policy.purposeProfiles[subscriptionRuntimeIncrementalPurpose];
    if (final !== undefined) {
      final.outputSchemaName = incrementalMeetingSummaryOutputSchemaName;
    }
    if (incremental !== undefined) {
      incremental.outputSchemaName = meetingSummaryOutputSchemaName;
    }
  }],
];

describe("sidecar deployment policy", () => {
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("admits only the exact final and incremental policy profiles", async () => {
    await expect(resolveSidecarSettings(await environmentForPolicy(() => {}))).resolves
      .toMatchObject({ bindAddress: "127.0.0.1:50052" });
  });

  it.each(invalidPolicyVersionCases)(
    "fails closed for %s",
    async (_label, mutate) => {
      await expect(resolveSidecarSettings(await environmentForPolicy(mutate))).rejects
        .toThrow("Deployment policy conflicts with executable sidecar policy");
    },
  );
});

async function environmentForPolicy(
  mutate: (policy: MutableDeploymentPolicy) => void,
): Promise<NodeJS.ProcessEnv> {
  root = await mkdtemp(join(tmpdir(), "sidecar-settings-test-"));
  const authJsonPath = join(root, "auth.json");
  const localEncryptionKeyFile = join(root, "local-encryption-key");
  const serviceTokenFile = join(root, "service-token");
  const stateRoot = join(root, "state");
  const policyPath = join(root, "sidecar-policy.json");
  const isolatedCwd = join(root, "workspace");
  const policy = JSON.parse(
    await readFile(sourcePolicyPath, "utf8"),
  ) as MutableDeploymentPolicy;

  policy.transport.bind = "127.0.0.1:50052";
  policy.transport.serviceTokenFile = serviceTokenFile;
  policy.custody.authJsonPath = authJsonPath;
  policy.custody.localEncryptionKeyFile = localEncryptionKeyFile;
  policy.custody.stateRoot = stateRoot;
  const final = policy.purposeProfiles[subscriptionRuntimePurpose];
  const incremental = policy.purposeProfiles[subscriptionRuntimeIncrementalPurpose];
  if (final === undefined || incremental === undefined) {
    throw new Error("Test deployment policy is missing an admitted profile");
  }
  final.isolatedCwd = isolatedCwd;
  incremental.isolatedCwd = isolatedCwd;
  mutate(policy);

  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(serviceTokenFile, "sidecar-settings-test-token");
  await chmod(serviceTokenFile, 0o600);

  return {
    SUBSCRIPTION_RUNTIME_AUTH_JSON_PATH: authJsonPath,
    SUBSCRIPTION_RUNTIME_EXPECTED_LAUNCHER_SHA256: "a".repeat(64),
    SUBSCRIPTION_RUNTIME_GRPC_BIND: policy.transport.bind,
    SUBSCRIPTION_RUNTIME_ISOLATED_CWD: isolatedCwd,
    SUBSCRIPTION_RUNTIME_LAUNCHER_PATH: join(root, "launcher.mjs"),
    SUBSCRIPTION_RUNTIME_LOCAL_ENCRYPTION_KEY_FILE: localEncryptionKeyFile,
    SUBSCRIPTION_RUNTIME_PACKAGE_MANIFEST_PATH: join(root, "package.json"),
    SUBSCRIPTION_RUNTIME_PURPOSE_POLICY_FILE: policyPath,
    SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE: serviceTokenFile,
    SUBSCRIPTION_RUNTIME_STATE_ROOT: stateRoot,
  };
}
