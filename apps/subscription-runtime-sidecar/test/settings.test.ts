import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
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
  subscriptionRuntimeConversationPurpose,
  subscriptionRuntimeIncrementalPurpose,
  subscriptionRuntimeKnowledgeAnswerPurpose,
  subscriptionRuntimeKnowledgeCoveragePurpose,
  subscriptionRuntimePurpose,
  subscriptionRuntimeKnowledgeEvidenceSelectorPurpose,
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

const invalidPolicyCases: readonly [
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
  ["a missing conversation profile", (policy) => {
    delete policy.purposeProfiles[subscriptionRuntimeConversationPurpose];
  }],
  ["a stale conversation version", (policy) => {
    const conversation = policy.purposeProfiles[subscriptionRuntimeConversationPurpose];
    if (conversation !== undefined) {
      conversation.policyVersion = "meeting-conversation.subscription-runtime.v0";
    }
  }],
  ["a swapped conversation output schema", (policy) => {
    const conversation = policy.purposeProfiles[subscriptionRuntimeConversationPurpose];
    if (conversation !== undefined) {
      conversation.outputSchemaName = meetingSummaryOutputSchemaName;
    }
  }],
  ["a missing knowledge answer profile", (policy) => {
    delete policy.purposeProfiles[subscriptionRuntimeKnowledgeAnswerPurpose];
  }],
  ["a stale knowledge coverage version", (policy) => {
    const coverage = policy.purposeProfiles[subscriptionRuntimeKnowledgeCoveragePurpose];
    if (coverage !== undefined) {
      coverage.policyVersion = "meeting-knowledge.coverage.subscription-runtime.v0";
    }
  }],
  ["an unadmitted sixth profile", (policy) => {
    const conversation = policy.purposeProfiles[subscriptionRuntimeConversationPurpose];
    if (conversation !== undefined) {
      policy.purposeProfiles.discord_meeting_other = { ...conversation };
    }
  }],
];

const unsafeAuthCases: readonly [
  string,
  (authPath: string, fixtureRoot: string) => Promise<void>,
][] = [
  ["a directory", async (authPath) => {
    await rm(authPath);
    await mkdir(authPath);
  }],
  ["a symlink", async (authPath, fixtureRoot) => {
    const target = join(fixtureRoot, "linked-auth.json");
    await writeFile(target, "{}", { mode: 0o400 });
    await rm(authPath);
    await symlink(target, authPath);
  }],
  ["a permissive file", async (authPath) => {
    await chmod(authPath, 0o600);
  }],
];

describe("sidecar deployment policy", () => {
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("admits exactly the summary, conversation, and knowledge policy profiles", async () => {
    await expect(resolveSidecarSettings(await environmentForPolicy(() => {}, 2))).resolves
      .toMatchObject({
        accounts: [
          { id: "slot-1", providerInstanceId: "discord-meeting-summary-v3" },
          {
            id: "slot-2",
            providerInstanceId: "discord-meeting-summary-v3-slot-2",
          },
        ],
        bindAddress: "127.0.0.1:50052",
      });
  });

  it.each(invalidPolicyCases)(
    "fails closed for %s",
    async (_label, mutate) => {
      await expect(resolveSidecarSettings(await environmentForPolicy(mutate))).rejects
        .toThrow("Deployment policy conflicts with executable sidecar policy");
    },
  );

  it.each(unsafeAuthCases)("rejects %s as an auth slot", async (_label, mutate) => {
    const environment = await environmentForPolicy(() => {});
    const fixtureRoot = requiredFixtureRoot();
    const authPath = join(
      fixtureRoot,
      "auth-pool",
      "generations",
      "a".repeat(32),
      "slot-1",
      "auth.json",
    );
    await mutate(authPath, fixtureRoot);

    await expect(resolveSidecarSettings(environment)).rejects
      .toThrow("Subscription account pool auth file is unsafe");
  });
});

async function environmentForPolicy(
  mutate: (policy: MutableDeploymentPolicy) => void,
  accountCount = 1,
): Promise<NodeJS.ProcessEnv> {
  root = await realpath(await mkdtemp(join(tmpdir(), "sidecar-settings-test-")));
  const authPoolRoot = join(root, "auth-pool");
  const generation = "a".repeat(32);
  const authSlotRoots = Array.from({ length: accountCount }, (_, index) => join(
    authPoolRoot,
    "generations",
    generation,
    `slot-${index + 1}`,
  ));
  const authPoolManifestPath = join(authPoolRoot, "pool.json");
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
  policy.custody.authPoolManifestPath = authPoolManifestPath;
  policy.custody.localEncryptionKeyFile = localEncryptionKeyFile;
  policy.custody.stateRoot = stateRoot;
  const final = policy.purposeProfiles[subscriptionRuntimePurpose];
  const incremental = policy.purposeProfiles[subscriptionRuntimeIncrementalPurpose];
  const conversation = policy.purposeProfiles[subscriptionRuntimeConversationPurpose];
  const knowledgeAnswer = policy.purposeProfiles[subscriptionRuntimeKnowledgeAnswerPurpose];
  const knowledgeCoverage = policy.purposeProfiles[subscriptionRuntimeKnowledgeCoveragePurpose];
  const knowledgeSelector =
    policy.purposeProfiles[subscriptionRuntimeKnowledgeEvidenceSelectorPurpose];
  if (
    final === undefined ||
    incremental === undefined ||
    conversation === undefined ||
    knowledgeAnswer === undefined ||
    knowledgeCoverage === undefined ||
    knowledgeSelector === undefined
  ) {
    throw new Error("Test deployment policy is missing an admitted profile");
  }
  final.isolatedCwd = isolatedCwd;
  incremental.isolatedCwd = isolatedCwd;
  conversation.isolatedCwd = isolatedCwd;
  knowledgeAnswer.isolatedCwd = isolatedCwd;
  knowledgeCoverage.isolatedCwd = isolatedCwd;
  knowledgeSelector.isolatedCwd = isolatedCwd;
  mutate(policy);

  await Promise.all(authSlotRoots.map(async (slotRoot) => {
    await mkdir(slotRoot, { recursive: true });
    await writeFile(join(slotRoot, "auth.json"), "{}", { mode: 0o400 });
  }));
  await writeFile(authPoolManifestPath, JSON.stringify({
    generation,
    schemaVersion: 1,
    slots: authSlotRoots.map((_slotRoot, index) => ({
      authJsonPath:
        `generations/${generation}/slot-${index + 1}/auth.json`,
      id: `slot-${index + 1}`,
    })),
  }), { mode: 0o600 });
  await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(serviceTokenFile, "sidecar-settings-test-token");
  await chmod(serviceTokenFile, 0o600);

  return {
    SUBSCRIPTION_RUNTIME_AUTH_POOL_MANIFEST_PATH: authPoolManifestPath,
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

function requiredFixtureRoot(): string {
  if (root === undefined) {
    throw new Error("Test fixture root is unavailable");
  }
  return root;
}
