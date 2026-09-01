import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { verifyMeetingCoreImportBoundaries } from "./verify-meeting-core-import-boundaries.js";

const fixtureRoot = resolve(
  import.meta.dirname,
  "../test-fixtures/meeting-core-import-boundaries",
);
const workspaceRoot = resolve(import.meta.dirname, "../../..");

const features = [
  "conversation",
  "live-meeting",
  "meeting-intelligence",
  "meeting-lifecycle",
  "post-call-workflow",
  "publishing",
  "recording",
  "transcription",
] as const;

async function createFixtureRepository(): Promise<string> {
  const repositoryRoot = await mkdtemp(
    resolve(tmpdir(), "meeting-core-import-boundaries-"),
  );
  await mkdir(resolve(repositoryRoot, "architecture"), { recursive: true });
  await mkdir(resolve(repositoryRoot, "packages/meeting-core"), { recursive: true });
  await mkdir(resolve(repositoryRoot, "packages/discord-adapter/src"), {
    recursive: true,
  });
  await mkdir(resolve(repositoryRoot, "apps/meeting-platform/src/live-runtime"), {
    recursive: true,
  });

  const exports = Object.fromEntries(
    features.map((feature) => [
      `./${feature}`,
      `./src/features/${feature}/index.ts`,
    ]),
  );
  await writeFile(
    resolve(repositoryRoot, "packages/meeting-core/package.json"),
    `${JSON.stringify({ name: "@discord-meeting/meeting-core", exports }, null, 2)}\n`,
  );
  await writeFile(
    resolve(repositoryRoot, "architecture/meeting-core-consumer-subpaths.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packageName: "@discord-meeting/meeting-core",
        packageManifest: "packages/meeting-core/package.json",
        productionSearchRoots: ["apps", "packages"],
        featureSubpaths: features,
        consumers: [
          {
            boundary: "adapters.discord",
            roots: ["packages/discord-adapter/src"],
            allowFeatureSubpaths: ["live-meeting", "publishing"],
          },
          {
            boundary: "apps.meeting-platform.live-runtime",
            roots: ["apps/meeting-platform/src/live-runtime"],
            allowFeatureSubpaths: ["conversation"],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return repositoryRoot;
}

void test("accepts allowed Meeting Core feature subpaths in supported import syntaxes", async () => {
  const repositoryRoot = await createFixtureRepository();
  const fixture = await readFile(resolve(fixtureRoot, "allowed-syntaxes.txt"), "utf8");
  await writeFile(
    resolve(repositoryRoot, "packages/discord-adapter/src/allowed.ts"),
    fixture,
  );

  const diagnostics = await verifyMeetingCoreImportBoundaries({ repositoryRoot });

  assert.deepEqual(diagnostics, []);
});

void test("accepts exact installable Meeting Core feature exports and rejects condition drift",
  async () => {
    const repositoryRoot = await createFixtureRepository();
    const manifestPath = resolve(repositoryRoot, "packages/meeting-core/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      exports: Record<string, unknown>;
    };
    manifest.exports = Object.fromEntries(features.map((feature) => [`./${feature}`, {
      import: `./dist/features/${feature}/index.js`,
      types: `./dist/features/${feature}/index.d.ts`,
    }]));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.deepEqual(await verifyMeetingCoreImportBoundaries({ repositoryRoot }), []);

    manifest.exports["./conversation"] = { default: "./dist/features/conversation/index.js",
      import: "./dist/features/conversation/index.js",
      types: "./dist/features/conversation/index.d.ts" };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    assert.ok((await verifyMeetingCoreImportBoundaries({ repositoryRoot }))
      .some((diagnostic) => diagnostic.includes("exact source or built feature entrypoint")));
  });

void test("rejects forbidden, root, deep, and unclassified Meeting Core imports", async () => {
  const repositoryRoot = await createFixtureRepository();
  const fixture = await readFile(
    resolve(fixtureRoot, "forbidden-syntaxes.txt"),
    "utf8",
  );
  await writeFile(
    resolve(repositoryRoot, "packages/discord-adapter/src/forbidden.ts"),
    fixture,
  );
  await writeFile(
    resolve(repositoryRoot, "apps/meeting-platform/src/live-runtime/forbidden.ts"),
    fixture,
  );
  await mkdir(resolve(repositoryRoot, "packages/unclassified/src"), {
    recursive: true,
  });
  await writeFile(
    resolve(repositoryRoot, "packages/unclassified/src/import.ts"),
    'import "@discord-meeting/meeting-core/recording";\n',
  );
  await mkdir(resolve(repositoryRoot, "packages/discord-adapter/src/test"), {
    recursive: true,
  });
  await writeFile(
    resolve(repositoryRoot, "packages/discord-adapter/src/test/bridge.ts"),
    'import "@discord-meeting/meeting-core/conversation";\n',
  );
  await mkdir(resolve(repositoryRoot, "packages/discord-adapter/src/dist"), {
    recursive: true,
  });
  await writeFile(
    resolve(repositoryRoot, "packages/discord-adapter/src/dist/bridge.ts"),
    'import "@discord-meeting/meeting-core/conversation";\n',
  );

  const diagnostics = await verifyMeetingCoreImportBoundaries({ repositoryRoot });

  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes(
        "adapters.discord may not import Meeting Core feature conversation",
      ),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes(
        "apps.meeting-platform.live-runtime may not import Meeting Core feature meeting-lifecycle",
      ),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes("must not import the @discord-meeting/meeting-core package root"),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes("is an unknown or deep Meeting Core subpath"),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes("is used by an unclassified production consumer"),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes("packages/discord-adapter/src/test/bridge.ts"),
    ),
  );
  assert.ok(
    diagnostics.some((diagnostic) =>
      diagnostic.includes("packages/discord-adapter/src/dist/bridge.ts"),
    ),
  );
  assert.equal(
    diagnostics.filter((diagnostic) =>
      diagnostic.includes(
        "adapters.discord may not import Meeting Core feature conversation",
      ),
    ).length,
    18,
  );
});

void test("fails closed when the package export surface drifts from policy", async () => {
  const repositoryRoot = await createFixtureRepository();
  const manifestPath = resolve(repositoryRoot, "packages/meeting-core/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    exports: Record<string, string>;
  };
  manifest.exports["."] = "./src/index.ts";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const diagnostics = await verifyMeetingCoreImportBoundaries({ repositoryRoot });

  assert.ok(
    diagnostics.some((diagnostic) => diagnostic.includes("do not match policy")),
  );
});

void test("owns the exact Meeting Knowledge test path fail closed", async () => {
  const configuration = await readFile(
    resolve(workspaceRoot, "architecture/foundation/source-dependencies.yaml"),
    "utf8",
  );
  assert.doesNotMatch(
    configuration,
    /packages\/meeting-core\/test\/features\/meeting-knowledge/u,
    "Foundation 0.6.0 must not misclassify development-only tests as runtime source",
  );

  const testRoot = resolve(
    workspaceRoot,
    "packages/meeting-core/test/features/meeting-knowledge",
  );
  const entries = await readdir(testRoot, { recursive: true, withFileTypes: true });
  const sourceFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assert.ok(sourceFiles.length > 0, "Meeting Knowledge test ownership path is empty");
  assert.deepEqual(
    sourceFiles.filter((file) => !file.endsWith(".test.ts")),
    [],
    "Meeting Knowledge test ownership path contains unclassified source",
  );
});
