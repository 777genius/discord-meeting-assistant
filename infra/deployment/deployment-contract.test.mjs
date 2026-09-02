import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  assertDistinctApplicationIds,
  assertExactRevision,
  deploymentIdentityFromEnvFile,
  replaceReadOnlyFile,
} from "./generate-build-provenance.mjs";

const deploymentRoot = new URL("./", import.meta.url);
const repositoryRoot = new URL("../../", import.meta.url);
const gatewayRevision = "2d9b7b29a60e2fdecc8a5ac4d89e05ec2c98b793";
const craigRevision = "37b86a958b567cb7fcff75946e94fe5e7ee38f42";

async function deploymentFile(name) {
  return await readFile(new URL(name, deploymentRoot), "utf8");
}

test("documents the exact authenticated black-box environment contract", async () => {
  const guide = await deploymentFile("voicetext-gateway.md");
  for (const name of [
    "VOICETEXT_GATEWAY_E2E_HTTP_ORIGIN",
    "VOICETEXT_GATEWAY_E2E_WS_ORIGIN",
    "VOICETEXT_GATEWAY_E2E_TOKEN",
    "VOICETEXT_GATEWAY_E2E_OGG_FIXTURE",
  ]) {
    assert.match(guide, new RegExp(`^${name}=`, "mu"));
  }
  assert.doesNotMatch(guide, /BLACK_BOX_ORIGIN/u);
  assert.match(guide, /authenticated and exercises all\s+four provider\/mode profiles/iu);
  assert.match(guide, /not providerless/iu);
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
