import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HostedCampaignArtifactStore } from "../src/hosted-campaign-artifact-store.js";
import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignExecutableSpec,
} from "../src/hosted-campaign-coordinator.js";
import { HostedCampaignProcessAdapter } from "../src/hosted-campaign-process-adapter.js";
import {
  hostedCampaignProcessEventPrefix,
  serializeHostedCampaignProcessEvent,
} from "../src/hosted-campaign-process-event.js";

const trustedRuntimeEnvironment = {
  HOME: "/private/tmp/hosted-campaign-home",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  SSH_AUTH_SOCK: "/private/tmp/hosted-campaign-ssh-agent.sock",
} as const;

async function adapter(source: string) {
  const root = await mkdtemp(join(tmpdir(), "hosted-process-"));
  await chmod(root, 0o700);
  await Promise.all([
    "main.js",
    "verify-campaign.js",
    "verify-retained-evidence.js",
  ].map(async (name) => writeFile(join(root, name), source, { mode: 0o600 })));
  const artifactRoot = join(root, "artifacts");
  const store = new HostedCampaignArtifactStore(artifactRoot, "campaign-1");
  await store.initialize();
  return {
    processAdapter: new HostedCampaignProcessAdapter({
      artifactStore: store,
      distRoot: root,
      terminationGraceMilliseconds: 50,
      trustedRuntimeEnvironment,
    }),
    artifactRoot,
    store,
  };
}

const bounded = () => ({
  deadlineEpochMilliseconds: Date.now() + 1_000,
  signal: new AbortController().signal,
});

const spec = (
  environment: Readonly<Record<string, string>> = {},
): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" },
  childId: "actor",
  entrypoint: "actor",
  environment: {
    DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
    DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    ...environment,
  },
  produces: [],
  requires: [],
  startBefore: { kind: "campaign" },
});

const verifierSpec = (): HostedCampaignExecutableSpec => ({
  arguments: {
    evidencePath: "/evidence.json",
    kind: "evidence-verifier",
    manifestPath: "/manifest.json",
  },
  childId: "verifier-1",
  completion: {
    action: { kind: "run-verified", ordinal: 1, runId: "run-1" },
    kind: "evidence-verifier",
  },
  entrypoint: "evidence-verifier",
  environment: {},
  produces: [],
  requires: [],
  startBefore: {
    action: { kind: "run-verified", ordinal: 1, runId: "run-1" },
    kind: "barrier",
    ordinal: 1,
    runId: "run-1",
  },
});

function completionAction(specification: HostedCampaignExecutableSpec) {
  const completion = specification.completion;
  if (completion === undefined || !("action" in completion)) {
    throw new Error("Expected an action-producing completion");
  }
  return completion.action;
}

describe("hosted campaign process adapter events", () => {
  it("ingests exact prefixed fragmented events while allowing ordinary stdout", async () => {
    const outputPath = "/tmp/capture-1.json";
    const event = serializeHostedCampaignProcessEvent({
      campaignId: "campaign-1",
      event: {
        action: { kind: "capture-retained", ordinal: 1 },
        evidence: { ordinal: 1, outputPath, retained: true },
      },
      kind: "hosted-campaign-barrier",
      runId: "run-3",
      schemaVersion: 1,
    });
    const source = `process.stdout.write("ordinary log\\n");` +
      `process.stdout.write(${JSON.stringify(event.slice(0, 17))});` +
      `setTimeout(() => process.stdout.write(${JSON.stringify(event.slice(17))}), 5);` +
      "setInterval(() => {}, 1000);";
    const { processAdapter } = await adapter(source);
    const executable = {
      ...spec({
        DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
        DISCORD_E2E_RUN_ID: "run-3",
      }),
      produces: [{
        action: { kind: "capture-retained" as const, ordinal: 1 },
        ordinal: 3,
        outputPath: "/evidence/capture-1.json",
        runId: "run-3",
      }],
    };
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitBarrier({ kind: "capture-retained", ordinal: 1 }, bounded()))
      .resolves.toEqual({ ordinal: 1, outputPath, retained: true });
    await processAdapter.stopChild(handle);
  });

  it("drains queued process events before teardown completes", async () => {
    const events = [1, 2, 3].map((ordinal) => serializeHostedCampaignProcessEvent({
      campaignId: "campaign-1",
      event: {
        action: { kind: "capture-retained", ordinal },
        evidence: { ordinal, outputPath: `/tmp/capture-${String(ordinal)}.json`, retained: true },
      },
      kind: "hosted-campaign-barrier",
      runId: "run-3",
      schemaVersion: 1,
    })).join("");
    const { processAdapter } = await adapter(
      `process.stdout.write(${JSON.stringify(events)}); setInterval(() => {}, 1000);`,
    );
    const executable = {
      ...spec({
        DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
        DISCORD_E2E_RUN_ID: "run-3",
      }),
      produces: [1, 2, 3].map((ordinal) => ({
        action: { kind: "capture-retained" as const, ordinal },
        ordinal: 3,
        outputPath: `/evidence/capture-${String(ordinal)}.json`,
        runId: "run-3",
      })),
    };
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitBarrier({ kind: "capture-retained", ordinal: 3 }, bounded()))
      .resolves.toEqual({ ordinal: 3, outputPath: "/tmp/capture-3.json", retained: true });
    await processAdapter.stopChild(handle);
    for (const ordinal of [1, 2, 3] as const) {
      await expect(processAdapter.awaitBarrier({ kind: "capture-retained", ordinal }, bounded()))
        .resolves.toEqual({
          ordinal,
          outputPath: `/tmp/capture-${String(ordinal)}.json`,
          retained: true,
        });
    }
  });

  it("fails closed on malformed, mismatched, or duplicate prefixed events", async () => {
    const valid = serializeHostedCampaignProcessEvent({
      campaignId: "campaign-1",
      event: {
        action: { kind: "observer-subscribed" },
        evidence: { authenticatedObserverBotId: HOSTED_CAMPAIGN_TARGET.observerApplicationId },
      },
      kind: "hosted-campaign-barrier",
      runId: "run-3",
      schemaVersion: 1,
    });
    const sources = [
      `${JSON.stringify(hostedCampaignProcessEventPrefix)} + "{bad-json}\\n"`,
      JSON.stringify(valid.replace('"runId":"run-3"', '"runId":"wrong"')),
      JSON.stringify(valid + valid),
    ];
    for (const expression of sources) {
      const { processAdapter } = await adapter(
        `process.stdout.write(${expression}); setInterval(() => {}, 1000);`,
      );
      await processAdapter.startChild(spec({
        DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
        DISCORD_E2E_RUN_ID: "run-3",
      }), bounded()).catch(() => {});
      await expect(processAdapter.awaitBarrier({ kind: "provenance-before" }, bounded()))
        .rejects.toThrow(/invalid prefixed event/u);
    }
  });

  it("terminates the entire detached process group before returning", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-process-tree-"));
    const markerPath = join(root, "grandchild-term.txt");
    const childSource = [
      'require("node:fs").writeFileSync(process.argv[1], "ready")',
      'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "term"); process.exit(0); })',
      "setInterval(() => {}, 1000)",
    ].join(";");
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(markerPath)}], { stdio: "ignore" });
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const { processAdapter } = await adapter(source);
    const handle = await processAdapter.startChild(spec(), bounded());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readFile(markerPath, "utf8") === "ready") {
          break;
        }
      } catch {}
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
    await processAdapter.stopChild(handle);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
  });

  it("terminates a surviving grandchild before publishing finite completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-finite-process-tree-"));
    const markerPath = join(root, "grandchild-state.txt");
    const childSource = [
      'require("node:fs").writeFileSync(process.argv[1], "ready")',
      'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "term"); process.exit(0); })',
      "setInterval(() => {}, 1000)",
    ].join(";");
    const output = JSON.stringify({ failures: [], metrics: [], passed: true });
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(markerPath)}], { stdio: "ignore" }).unref();
      const timer = setInterval(() => {
        if (!require("node:fs").existsSync(${JSON.stringify(markerPath)})) return;
        clearInterval(timer);
        process.stdout.write(${JSON.stringify(output)});
      }, 5);
    `;
    const { processAdapter, store } = await adapter(source);
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, {
      deadlineEpochMilliseconds: Date.now() + 5_000,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
    await expect(store.awaitAction(completionAction(executable), bounded()))
      .resolves.toMatchObject({ verified: true });
  });

  it.each([
    ["already cancelled", () => {
      const controller = new AbortController();
      controller.abort(new Error("test cancellation"));
      return { deadlineEpochMilliseconds: Date.now() + 5_000, signal: controller.signal };
    }],
    ["already expired", () => ({
      deadlineEpochMilliseconds: Date.now() - 1,
      signal: new AbortController().signal,
    })],
  ] as const)("reaps the full tree for an %s completion and permits safe child ID reuse", async (_case, bound) => {
    const root = await mkdtemp(join(tmpdir(), "hosted-cancelled-process-tree-"));
    const markerPath = join(root, "grandchild-state.txt");
    const childSource = [
      'require("node:fs").writeFileSync(process.argv[1], "ready")',
      'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "term"); process.exit(0); })',
      "setInterval(() => {}, 1000)",
    ].join(";");
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(markerPath)}],
        { stdio: "ignore" }).unref();
      setInterval(() => {}, 1000);
    `;
    const { artifactRoot, processAdapter } = await adapter(source);
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        if (await readFile(markerPath, "utf8") === "ready") {break;}
      } catch {}
      if (attempt === 99) {throw new Error("Grandchild did not become ready");}
      await new Promise((resolve) => {setTimeout(resolve, 10);});
    }

    await expect(processAdapter.awaitChildCompletion(handle, executable, bound())).rejects.toThrow();
    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
    await expect(readFile(join(artifactRoot, "run-verified-1-run-1.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const reused = await processAdapter.startChild(executable, bounded());
    await processAdapter.stopChild(reused);
  });

  it("does not publish a late completion after verification rejects", async () => {
    const { artifactRoot, processAdapter } = await adapter('process.stdout.write("not-json");');
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());

    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(
      /malformed completion output/u,
    );
    await new Promise((resolve) => {setTimeout(resolve, 25);});
    await expect(readFile(join(artifactRoot, "run-verified-1-run-1.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });

    const reused = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(reused, executable, bounded())).rejects.toThrow(
      /malformed completion output/u,
    );
  });

  it("cleans a grandchild after invalid startup output", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-invalid-process-tree-"));
    const markerPath = join(root, "grandchild-state.txt");
    const childSource = [
      'require("node:fs").writeFileSync(process.argv[1], "ready")',
      'process.on("SIGTERM", () => { require("node:fs").writeFileSync(process.argv[1], "term"); process.exit(0); })',
      "setInterval(() => {}, 1000)",
    ].join(";");
    const source = `
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, ${JSON.stringify(markerPath)}], { stdio: "ignore" }).unref();
      const timer = setInterval(() => {
        if (!require("node:fs").existsSync(${JSON.stringify(markerPath)})) return;
        clearInterval(timer);
        process.stdout.write(${JSON.stringify(`${hostedCampaignProcessEventPrefix}{bad-json}\n`)});
      }, 5);
      setInterval(() => {}, 1000);
    `;
    const { processAdapter } = await adapter(source);
    const executable = spec({
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_RUN_ID: "run-3",
    });
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitBarrier({ kind: "provenance-before" }, bounded()))
      .rejects.toThrow(/invalid prefixed event/u);
    await expect(processAdapter.stopChild(handle)).rejects.toThrow(/invalid prefixed event/u);
    await expect(readFile(markerPath, "utf8")).resolves.toBe("term");
  });
});
