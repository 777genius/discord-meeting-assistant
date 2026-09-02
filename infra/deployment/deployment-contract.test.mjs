import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertRenderedDeployment, sanitizedComposeEnvironment } from "./run-verified-compose.mjs";

import {
  assertDistinctApplicationIds,
  assertExactRevision,
  deploymentIdentityFromEnvFile,
  replaceReadOnlyFile,
} from "./generate-build-provenance.mjs";

const deploymentRoot = new URL("./", import.meta.url);
const repositoryRoot = new URL("../../", import.meta.url);
const gatewayRevision = "7adb5bb4c5c063ba3973e8bc76a759ac8ea29bb4";
const craigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";

async function deploymentFile(name) {
  return await readFile(new URL(name, deploymentRoot), "utf8");
}

test("documents the separate identity-bound real-provider canary", async () => {
  const guide = await deploymentFile("voicetext-gateway.md");
  for (const name of [
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_REQUIRED",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_HTTP_ORIGIN",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_WS_ORIGIN",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_IDENTITY_FILE",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_TREE",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_EXPECTED_IMAGE_DIGEST",
    "VOICETEXT_GATEWAY_PROVIDER_CANARY_RECEIPT",
  ]) {
    assert.match(guide, new RegExp(name, "u"));
  }
  assert.doesNotMatch(guide, /VOICETEXT_GATEWAY_E2E_/u);
  assert.match(guide, /ordinary adapter package test is explicitly providerless/iu);
  assert.match(guide, /provider-derived batch[\s\S]*live text/iu);
  assert.match(guide, /Neither command is a language/iu);
});

test("replaces a 0444 provenance file without weakening exact identity", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "deployment-provenance-"));
  const destination = pathToFileURL(join(fixtureRoot, "provenance.json"));
  try {
    await replaceReadOnlyFile(destination, "first\n");
    assert.equal((await stat(destination)).mode & 0o777, 0o444);
    await replaceReadOnlyFile(destination, "second\n");
    assert.equal(await readFile(destination, "utf8"), "second\n");
    assert.equal((await stat(destination)).mode & 0o777, 0o444);
    assert.doesNotThrow(() => assertExactRevision("a".repeat(40), "a".repeat(40)));
    assert.throws(
      () => assertExactRevision("b".repeat(40), "a".repeat(40)),
      /must equal the clean checkout HEAD/u,
    );
    assert.doesNotThrow(() => assertDistinctApplicationIds(
      "111111111111111111",
      "222222222222222222",
    ));
    assert.throws(
      () => assertDistinctApplicationIds("111111111111111111", "111111111111111111"),
      /must differ/u,
    );
    const environmentPath = join(fixtureRoot, "deployment.env");
    await writeFile(environmentPath, [
      `MEETING_PLATFORM_SOURCE_REVISION=${"a".repeat(40)}`,
      "DISCORD_PUBLICATION_APPLICATION_ID=111111111111111111",
      "DISCORD_CRAIG_APPLICATION_ID=222222222222222222",
    ].join("\n"));
    assert.deepEqual(await deploymentIdentityFromEnvFile(environmentPath), {
      craigApplicationId: "222222222222222222",
      publicationApplicationId: "111111111111111111",
      revision: "a".repeat(40),
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("requires two user-owned official Discord applications and no fixed client ID", async () => {
  const [readme, topology, compose, craig] = await Promise.all([
    readFile(new URL("README.md", repositoryRoot), "utf8"),
    deploymentFile("oss-meeting-topology.md"),
    deploymentFile("compose.yaml"),
    deploymentFile("compose.craig.yaml"),
  ]);
  const documentation = `${readme}\n${topology}`;
  assert.match(documentation, /two user-owned Discord applications/iu);
  assert.match(documentation, /one test bot for each application/iu);
  assert.doesNotMatch(documentation, /client_id=\d+/u);
  assert.match(compose, /DISCORD_PUBLICATION_APPLICATION_ID:\?set the publication bot application ID/u);
  assert.match(compose, /DISCORD_CRAIG_APPLICATION_ID:\?set the separate Craig application ID/u);
  assert.match(craig, /DISCORD_CRAIG_APPLICATION_ID:\?set the user-owned Craig application ID/u);
});

test("keeps every owned Compose network project-scoped", async () => {
  const [compose, craig, recordingEdge] = await Promise.all([
    deploymentFile("compose.yaml"),
    deploymentFile("compose.craig.yaml"),
    deploymentFile("compose.recording-edge.yaml"),
  ]);
  assert.doesNotMatch(compose, /^\s+name:\s+discord-meeting-(?:internal|egress)\s*$/mu);
  assert.doesNotMatch(craig, /^\s+name:\s+discord-meeting-craig-data\s*$/mu);
  assert.match(recordingEdge, /external: true\s+name: \$\{MEETING_INTERNAL_NETWORK:\?set/gu);
  assert.doesNotMatch(recordingEdge, /MEETING_INTERNAL_NETWORK:-/u);
  assert.match(await deploymentFile("README.md"), /Compose-generated, project-scoped names/iu);
});

test("binds local and remote source revision claims to testable identities", async () => {
  const [compose, craig, gateway, topology, generator] = await Promise.all([
    deploymentFile("compose.yaml"),
    deploymentFile("compose.craig.yaml"),
    deploymentFile("compose.voicetext-gateway.yaml"),
    deploymentFile("oss-meeting-topology.md"),
    deploymentFile("generate-build-provenance.mjs"),
  ]);
  assert.match(compose, /build:[\s\S]*org\.opencontainers\.image\.revision: \$\{MEETING_PLATFORM_SOURCE_REVISION:/u);
  assert.match(compose, /image: discord-meeting\/meeting-platform:\$\{MEETING_PLATFORM_SOURCE_REVISION:/u);
  assert.match(generator, /configuredRevision !== releaseRevision/u);
  assert.match(generator, /HEAD\^\{tree\}/u);
  assert.match(topology, /label alone is not proof of source identity/iu);
  assert.match(gateway, new RegExp(`ref=${gatewayRevision}&checksum=${gatewayRevision}`, "u"));
  assert.match(gateway, new RegExp(`image: discord-meeting/voicetext-gateway:${gatewayRevision}`, "u"));
  assert.match(gateway, new RegExp(`org\\.opencontainers\\.image\\.revision: ${gatewayRevision}`, "u"));
  assert.match(craig, new RegExp(`ref=${craigRevision}&checksum=${craigRevision}`, "u"));
  assert.match(craig, new RegExp(`image: discord-meeting/craig-meeting-gateway:${craigRevision}`, "u"));
  assert.match(craig, new RegExp(`org\\.opencontainers\\.image\\.revision: ${craigRevision}`, "u"));
});

test("keeps exact-revision language and profile qualification pending", async () => {
  const [readme, deploymentReadme, gatewayGuide] = await Promise.all([
    readFile(new URL("README.md", repositoryRoot), "utf8"),
    deploymentFile("README.md"),
    deploymentFile("voicetext-gateway.md"),
  ]);
  const claims = `${readme}\n${deploymentReadme}\n${gatewayGuide}`;
  assert.match(claims, /Historical\/private EN\/RU/iu);
  assert.match(claims, /all four provider\/mode profiles remain pending/iu);
  assert.match(gatewayGuide, /No English or Russian provider flow is qualified/iu);
  assert.match(gatewayGuide, /no retained EN\/RU acoustic-quality campaign/iu);
  assert.doesNotMatch(claims, /Only (?:the )?English and Russian provider flows are qualified on this exact/iu);
});

test("uses only a Git-derived context and one generated .build artifact", async () => {
  const [dockerignore, compose, recordingEdge, gateway, workflow, generator] = await Promise.all([
    readFile(new URL(".dockerignore", repositoryRoot), "utf8"),
    deploymentFile("compose.yaml"),
    deploymentFile("compose.recording-edge.yaml"),
    deploymentFile("compose.voicetext-gateway.yaml"),
    readFile(new URL(".github/workflows/build-test-candidate.yml", repositoryRoot), "utf8"),
    readFile(new URL("tooling/generate-git-build-context.mjs", repositoryRoot), "utf8"),
  ]);
  const platformDockerfile = await readFile(new URL("apps/meeting-platform/Dockerfile", repositoryRoot), "utf8");
  for (const pattern of [".env", ".env.*", "**/.env", "**/.env.*"]) {
    assert.ok(dockerignore.split("\n").includes(pattern));
  }
  assert.match(dockerignore, /\.build\/\*\n!\.build\/meeting-platform-build-provenance\.json/u);
  for (const source of [compose, recordingEdge, gateway]) {
    assert.doesNotMatch(source, /^\s+context: (?:\.\.?\/|\.)\s*$/mu);
  }
  assert.equal((workflow.match(/^\s+context: \.build\/docker-context$/gmu) ?? []).length, 3);
  assert.match(generator, /git.*archive/su);
  assert.match(generator, /copyFile\(provenancePath,[\s\S]*meeting-platform-build-provenance\.json/u);
  assert.ok(platformDockerfile.includes("pnpm --filter=@discord-meeting/infinity-context-adapter... --if-present run build"));
});

test("sanitizes inherited identities and rejects a rendered identity mismatch", () => {
  const sourceTree = "b".repeat(40);
  const environment = sanitizedComposeEnvironment({
    PATH: "/usr/bin",
    COMPOSE_FILE: "hostile.yaml",
    COMPOSE_PROFILES: "hosted-summary",
    DISCORD_CRAIG_APPLICATION_ID: "999999999999999999",
    MEETING_PLATFORM_SOURCE_REVISION: "c".repeat(40),
    MEETING_PLATFORM_SOURCE_TREE: "d".repeat(40),
  }, sourceTree);
  assert.deepEqual(environment, { PATH: "/usr/bin", MEETING_PLATFORM_SOURCE_TREE: sourceTree });

  const identity = {
    craigApplicationId: "222222222222222222",
    publicationApplicationId: "111111111111111111",
  };
  const provenance = { releaseRevision: "a".repeat(40), sourceTree };
  const contextPath = resolvePathForTest(".build/docker-context");
  const rendered = { services: { "meeting-platform": {
    build: { context: contextPath, labels: {
      "org.opencontainers.image.revision": provenance.releaseRevision,
      "org.opencontainers.image.source-tree": sourceTree,
    } },
    environment: {
      DISCORD_APPLICATION_ID: identity.publicationApplicationId,
      DISCORD_BOTIK_APPLICATION_ID: identity.publicationApplicationId,
      DISCORD_CRAIG_APPLICATION_ID: identity.craigApplicationId,
    },
    image: `discord-meeting/meeting-platform:${provenance.releaseRevision}`,
  } } };
  const input = { rendered, identity, provenance, contextPath, pins: {} };
  assert.doesNotThrow(() => assertRenderedDeployment(input));
  rendered.services["meeting-platform"].environment.DISCORD_APPLICATION_ID = identity.craigApplicationId;
  assert.throws(() => assertRenderedDeployment(input), /publication application/u);
});

test("gates hosted summary on an authenticated serving sidecar", async () => {
  const [base, hosted, probe] = await Promise.all([
    deploymentFile("compose.yaml"),
    deploymentFile("compose.hosted-summary.yaml"),
    readFile(new URL("apps/subscription-runtime-sidecar/src/healthcheck.ts", repositoryRoot), "utf8"),
  ]);
  assert.match(base, /healthcheck:[\s\S]*subscription-runtime-sidecar\/src\/healthcheck\.ts/u);
  assert.match(hosted, /subscription-runtime-sidecar: \{ condition: service_healthy \}/u);
  assert.match(probe, /SUBSCRIPTION_RUNTIME_SERVICE_TOKEN_FILE/u);
  assert.match(probe, /transport\.checkHealth\(\)/u);
  assert.match(probe, /health\.status !== "serving"/u);
});

test("publishes immutable remote gateway constants outside environment settings", async () => {
  const [pinsText, example, topology] = await Promise.all([
    deploymentFile("source-pins.json"),
    deploymentFile(".env.example"),
    deploymentFile("oss-meeting-topology.md"),
  ]);
  const pins = JSON.parse(pinsText);
  assert.deepEqual(pins.craigMeetingGateway, {
    gitUrl: "https://github.com/777genius/craig-meeting-gateway.git",
    gitRef: craigRevision,
    revision: craigRevision,
  });
  assert.deepEqual(pins.voiceTextGateway, {
    gitUrl: "https://github.com/777genius/voicetext-gateway.git",
    gitRef: gatewayRevision,
    revision: gatewayRevision,
  });
  assert.doesNotMatch(example, /(?:CRAIG|VOICETEXT)_GATEWAY_GIT_(?:URL|REF|REVISION)=/u);
  assert.match(topology, /source-pins\.json/u);
});

function resolvePathForTest(path) {
  return fileURLToPath(new URL(path, repositoryRoot));
}

test("readiness-gates Meeting Platform on versioned object storage bootstrap", async () => {
  const [compose, bootstrap] = await Promise.all([
    deploymentFile("compose.yaml"),
    readFile(new URL("../../apps/meeting-platform/src/composition/object-storage-bootstrap.ts", import.meta.url), "utf8"),
  ]);
  assert.match(compose, /object-storage:[\s\S]*?healthcheck:[\s\S]*?cluster\/status/u);
  assert.match(compose, /object-storage-bootstrap:[\s\S]*?object-storage: \{ condition: service_healthy \}/u);
  assert.match(compose, /object-storage-bootstrap: \{ condition: service_completed_successfully \}/u);
  assert.match(bootstrap, /PutBucketVersioningCommand/u);
  assert.match(bootstrap, /object storage did not return an immutable version ID/u);
});
