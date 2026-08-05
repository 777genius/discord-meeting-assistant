import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const foundationCli = join(
  repositoryRoot,
  "node_modules/@agent-teams/engineering-foundation/dist/cli.js",
);

test("governs the production launcher as an explicit dynamic-runtime boundary", async () => {
  const [sourceDependencies, suppressionGovernance] = await Promise.all([
    readFile(
      join(repositoryRoot, "architecture/foundation/source-dependencies.yaml"),
      "utf8",
    ),
    readFile(
      join(repositoryRoot, "architecture/foundation/suppression-governance.yaml"),
      "utf8",
    ),
  ]);

  assert.match(sourceDependencies, /id: infra\.subscription-runtime/u);
  assert.match(sourceDependencies, /audited-xhigh-launcher\.mjs/u);
  assert.match(sourceDependencies, /runtimeReferences:\n\s+- dynamic/u);
  const productionBoundary = sourceDependencies
    .split("- id: infra.subscription-runtime\n", 2)[1]
    ?.split("- id: infra.subscription-runtime-tests\n", 1)[0];
  assert.ok(productionBoundary);
  assert.doesNotMatch(productionBoundary, /node:(?:assert|os|test)/u);
  assert.match(sourceDependencies, /id: infra\.subscription-runtime-tests/u);
  assert.match(suppressionGovernance, /infra\/subscription-runtime/u);
});

test("Foundation rejects a forbidden launcher import", async () => {
  await withFixture(async (fixture) => {
    await writeSourceFixture(fixture, 'import "node:fs";\n');

    const result = await runFoundation(
      fixture,
      "architecture.source-dependencies",
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.output,
      /architecture\.source-dependencies\.forbidden-builtin-dependency/u,
    );
  });
});

test("Foundation rejects an unclassified production source file", async () => {
  await withFixture(async (fixture) => {
    await writeSourceFixture(fixture, "export const admitted = true;\n");
    await writeFile(
      join(fixture, "packages/runtime/src/unclassified.mjs"),
      "export const bypass = true;\n",
    );

    const result = await runFoundation(
      fixture,
      "architecture.source-dependencies",
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.output,
      /architecture\.source-dependencies\.unclassified-source-file/u,
    );
  });
});

test("Foundation rejects an unregistered launcher suppression", async () => {
  await withFixture(async (fixture) => {
    await mkdir(join(fixture, "src"), { recursive: true });
    await Promise.all([
      writeFile(
        join(fixture, "foundation.config.yaml"),
        suppressionFoundationConfig,
      ),
      writeFile(
        join(fixture, "suppression-governance.yaml"),
        suppressionGovernanceConfig,
      ),
      writeFile(
        join(fixture, "src/index.mjs"),
        "// oxlint-disable-next-line no-console\nconsole.log('fixture');\n",
      ),
    ]);

    const result = await runFoundation(
      fixture,
      "quality.suppression-governance",
    );

    assert.notEqual(result.exitCode, 0);
    assert.match(
      result.output,
      /quality\.suppression-governance\.unregistered-suppression/u,
    );
  });
});

async function writeSourceFixture(fixture, source) {
  await mkdir(join(fixture, "packages/runtime/src/composition"), {
    recursive: true,
  });
  await Promise.all([
    writeFile(join(fixture, "foundation.config.yaml"), sourceFoundationConfig),
    writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "@fixture/repository",
        packageManager: "pnpm@11.18.0",
        private: true,
        version: "1.0.0",
      }),
    ),
    writeFile(join(fixture, "source-dependencies.yaml"), sourceDependencyConfig),
    writeFile(
      join(fixture, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    ),
    writeFile(
      join(fixture, "packages/runtime/package.json"),
      JSON.stringify({
        name: "@fixture/runtime",
        private: true,
        type: "module",
        version: "1.0.0",
      }),
    ),
    writeFile(
      join(fixture, "packages/runtime/src/composition/index.mjs"),
      source,
    ),
  ]);
}

async function withFixture(run) {
  const fixture = await mkdtemp(join(tmpdir(), "foundation-governance-"));
  try {
    await run(fixture);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
}

function runFoundation(cwd, capability) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [foundationCli, "check", capability],
      { cwd, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({
          exitCode:
            typeof error?.code === "number"
              ? error.code
              : error === null
                ? 0
                : 1,
          output: `${stdout}${stderr}`,
        });
      },
    );
  });
}

const sourceFoundationConfig = `schemaVersion: 1
project:
  id: foundation-fixture
capabilities:
  architecture.source-dependencies:
    configPath: source-dependencies.yaml
`;

const sourceDependencyConfig = `schemaVersion: 2
workspace:
  kind: pnpm
  manifest: pnpm-workspace.yaml
governedRoots:
  - packages/runtime/src
boundaries:
  - id: fixture.composition
    roots:
      - packages/runtime/src/composition
    entrypoints:
      - packages/runtime/src/composition/index.mjs
    allow:
      boundaries: []
      packages: []
      builtins: []
      runtimeReferences: []
`;

const suppressionFoundationConfig = `schemaVersion: 1
project:
  id: suppression-fixture
capabilities:
  quality.suppression-governance:
    configPath: suppression-governance.yaml
`;

const suppressionGovernanceConfig = `schemaVersion: 1
governedRoots:
  - src
nonWaivableRulePrefixes:
  - architecture.
waivers: []
`;
