import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL(
  "../../../.github/workflows/quality.yml",
  import.meta.url,
);

function job(workflow: string, id: string): string {
  const marker = `  ${id}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Quality workflow is missing the ${id} job`);
  const remainder = workflow.slice(start + marker.length);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:\s*$/mu);
  return workflow.slice(
    start,
    next === -1 ? workflow.length : start + marker.length + next,
  );
}

void test("Infinity validation shards every test exactly once behind a fail-closed gate", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const checks = job(workflow, "infinity-integration-checks");
  const aggregate = job(workflow, "infinity-integration");

  assert.match(checks, /fail-fast: false/u);
  assert.deepEqual(
    [...checks.matchAll(/^\s+- target: (\S+)$/gmu)].map((match) => match[1]),
    [
      "typecheck",
      "tests-runner-structural",
      "tests-production",
      "tests-remainder",
    ],
  );
  assert.match(
    checks,
    /tsc --project tsconfig\.json --noEmit --pretty false/u,
  );
  assert.match(
    checks,
    /vitest run test\/quality-campaign-production-runner-structural\.test\.ts[\s\S]*--no-file-parallelism/u,
  );
  assert.match(
    checks,
    /vitest run test\/quality-campaign-production\.test\.ts[\s\S]*--no-file-parallelism/u,
  );
  assert.match(
    checks,
    /vitest run --no-file-parallelism[\s\S]*--exclude=\*\*\/quality-campaign-production-runner-structural\.test\.ts[\s\S]*--exclude=\*\*\/quality-campaign-production\.test\.ts/u,
  );

  assert.match(aggregate, /if: always\(\) && github\.event_name == 'pull_request'/u);
  assert.match(aggregate, /- infinity-changes/u);
  assert.match(aggregate, /- infinity-integration-checks/u);
  assert.match(aggregate, /CHANGES_RESULT.*needs\.infinity-changes\.result/u);
  assert.match(aggregate, /CHECKS_RESULT.*needs\.infinity-integration-checks\.result/u);
  assert.match(aggregate, /CHECKS_REQUIRED.*needs\.infinity-changes\.outputs\.required/u);
  assert.match(aggregate, /CHECKS_REQUIRED.*== "true".*CHECKS_RESULT.*!= "success"/su);
});
