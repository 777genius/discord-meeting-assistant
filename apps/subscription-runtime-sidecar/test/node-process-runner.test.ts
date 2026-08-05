import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeProcessRunner } from "../src/node-process-runner.js";

describe("NodeProcessRunner", () => {
  let root: string | undefined;

  it("identifies the packaged CLI execution engine", () => {
    expect(new NodeProcessRunner().runtimeEngine).toBe("subscription-runtime-cli");
  });

  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { force: true, recursive: true });
    }
    root = undefined;
  });

  it("kills a disposable child promptly when its AbortSignal is cancelled", async () => {
    root = await mkdtemp(join(tmpdir(), "sidecar-process-runner-test-"));
    const marker = join(root, "child-started");
    const controller = new AbortController();
    const result = new NodeProcessRunner().run({
      args: [
        "--input-type=module",
        "--eval",
        [
          'import { writeFileSync } from "node:fs";',
          'writeFileSync(process.env.TEST_MARKER_PATH, "started");',
          "setInterval(() => {}, 1_000);",
        ].join(" "),
      ],
      command: process.execPath,
      cwd: root,
      env: { TEST_MARKER_PATH: marker },
      killGraceMs: 100,
      maxStderrBytes: 1_024,
      maxStdoutBytes: 1_024,
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    await waitForFile(marker);
    const cancellationStartedAt = performance.now();
    controller.abort();

    await expect(result).resolves.toMatchObject({
      cancelled: true,
      outputLimitExceeded: false,
      timedOut: false,
    });
    expect(performance.now() - cancellationStartedAt).toBeLessThan(1_000);
  });
});

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 1_000;
  while (performance.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  throw new Error("Disposable child did not start promptly");
}
