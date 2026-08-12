import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { HostedCampaignArtifactStore } from "../src/hosted-campaign-artifact-store.js";
import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignEntrypoint,
  type HostedCampaignExecutableSpec,
} from "../src/hosted-campaign-coordinator.js";
import { HostedCampaignProcessAdapter } from "../src/hosted-campaign-process-adapter.js";
import { waitForSupplementalPlaybackGate } from "../src/supplemental-playback-gate.js";
import { serviceLevelsProof } from "./e2e-service-level-fixtures.js";
import { serializeHostedCampaignProcessEvent } from "../src/hosted-campaign-process-event.js";

const trustedRuntimeEnvironment = {
  HOME: "/private/tmp/hosted-campaign-home",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
  PATH: "/usr/bin:/bin",
  SSH_AUTH_SOCK: "/private/tmp/hosted-campaign-ssh-agent.sock",
} as const;

async function adapter(source: string, outputLimitBytes?: number) {
  const root = await mkdtemp(join(tmpdir(), "hosted-process-"));
  await chmod(root, 0o700);
  await Promise.all(["main.js", "verify-campaign.js", "collect-retained-evidence.js",
    "observe-conversation-voice.js", "verify-retained-evidence.js", "observe-live-discord.js",
    "observe-live-discord-playback-link.js", "collect-hosted-campaign-provenance.js",
    "collect-recording-ready-receipt.js", "collect-hosted-service-level-sources.js",
    "collect-hosted-service-levels.js", "publish-replay-attestation.js", "play-supplemental-voice.js"]
    .map(async (name) => writeFile(join(root, name), source, { mode: 0o600 })));
  const storeRoot = join(root, "artifacts");
  const store = new HostedCampaignArtifactStore(storeRoot, "campaign-1");
  await store.initialize();
  return { processAdapter: new HostedCampaignProcessAdapter({
    artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50,
    trustedRuntimeEnvironment,
    ...(outputLimitBytes === undefined ? {} : { outputLimitBytes }),
  }), store };
}
async function recordingReadyAdapter(source: string) {
  const root = await mkdtemp(join(tmpdir(), "hosted-recording-ready-process-"));
  await chmod(root, 0o700);
  await writeFile(join(root, "collect-recording-ready-receipt.js"), source, { mode: 0o600 });
  const store = new HostedCampaignArtifactStore(join(root, "artifacts"), "campaign-1");
  await store.initialize();
  return { processAdapter: new HostedCampaignProcessAdapter({
    artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50,
    trustedRuntimeEnvironment,
  }), store };
}
async function finiteAdapter(entrypoint: string, source: string) {
  const root = await mkdtemp(join(tmpdir(), "hosted-finite-process-"));
  await chmod(root, 0o700);
  await writeFile(join(root, entrypoint), source, { mode: 0o600 });
  const store = new HostedCampaignArtifactStore(join(root, "artifacts"), "campaign-1");
  await store.initialize();
  return new HostedCampaignProcessAdapter({
    artifactStore: store, distRoot: root, terminationGraceMilliseconds: 50, trustedRuntimeEnvironment,
  });
}
async function serviceLevelsAdapter(source: string) {
  return finiteAdapter("collect-hosted-service-levels.js", source);
}
async function serviceLevelSourcesAdapter(source: string) {
  return finiteAdapter("collect-hosted-service-level-sources.js", source);
}
const bounded = () => ({ deadlineEpochMilliseconds: Date.now() + 1_000, signal: new AbortController().signal });
async function readJsonEventually(path: string): Promise<unknown> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8")) as unknown;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {throw error;}
      await new Promise((resolve) => {setTimeout(resolve, 10);});
    }
  }
  throw new Error(`Hosted child did not write environment marker: ${path}`);
}
function environmentProbeSpec(
  entrypoint: HostedCampaignEntrypoint,
  outputPath: string,
): HostedCampaignExecutableSpec {
  return {
    arguments: { kind: "environment" },
    childId: `environment-${entrypoint}`,
    entrypoint,
    environment: {
      DISCORD_E2E_EVIDENCE_OUTPUT: outputPath,
      ...(entrypoint === "actor" ? {
        DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
        DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      } : {}),
      ...(entrypoint === "live-observer" ? {
        DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.publicationChannelId,
        DISCORD_E2E_LIVE_SUT_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
      } : {}),
      ...(entrypoint === "collector" || entrypoint === "provenance-probe"
        || entrypoint === "service-level-sources" ? {
        DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
        DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
        DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
      } : {}),
      ...(entrypoint === "replay-attestation-publisher" ? {
        DISCORD_E2E_REPLAY_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        DISCORD_E2E_REPLAY_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
      } : {}),
    },
    produces: [], requires: [], startBefore: { kind: "campaign" },
  };
}
const spec = (
  environment: Readonly<Record<string, string>> = {}, releaseGate?: HostedCampaignExecutableSpec["releaseGate"],
): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" as const }, childId: "actor", entrypoint: "actor" as const,
  environment: {
    DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
    DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    ...environment,
  }, produces: [], requires: [], ...(releaseGate === undefined ? {} : { releaseGate }), startBefore: { kind: "campaign" as const },
});
const verifierSpec = (ordinal = 1, runId = "run-1"): HostedCampaignExecutableSpec => ({
  arguments: { evidencePath: "/evidence.json", kind: "evidence-verifier", manifestPath: "/manifest.json" },
  childId: `verifier-${ordinal}`,
  completion: { action: { kind: "run-verified", ordinal, runId }, kind: "evidence-verifier" },
  entrypoint: "evidence-verifier", environment: {}, produces: [], requires: [],
  startBefore: { action: { kind: "run-verified", ordinal, runId }, kind: "barrier", ordinal, runId },
});
const collectorSpec = (): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" }, childId: "collector",
  completion: {
    action: { kind: "run-verified", ordinal: 1, runId: "run-1" }, evidencePath: "/evidence/run-1.json",
    kind: "collector", runId: "run-1",
  },
  entrypoint: "collector", environment: {
    DISCORD_E2E_EVIDENCE_OUTPUT: "/evidence/run-1.json",
    DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
    DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
    DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
    DISCORD_E2E_RUN_ID: "run-1",
  }, produces: [], requires: [], startBefore: { action: { kind: "run-verified", ordinal: 1, runId: "run-1" }, kind: "barrier", ordinal: 1, runId: "run-1" },
});
const campaignVerifierSpec = (): HostedCampaignExecutableSpec => ({
  arguments: {
    evidencePaths: ["/evidence/1.json", "/evidence/2.json", "/evidence/3.json"],
    kind: "campaign-verifier", manifestPath: "/manifest.json",
  }, childId: "campaign-verifier",
  completion: {
    action: { kind: "campaign-verified" }, campaignId: "campaign-1", kind: "campaign-verifier",
    runIds: ["run-1", "run-2", "run-3"],
  }, entrypoint: "campaign-verifier", environment: {}, produces: [], requires: [],
  startBefore: { action: { kind: "campaign-verified" }, kind: "barrier", ordinal: 3, runId: "run-3" },
});
const campaignResult = (runIds: readonly string[]) => JSON.stringify({
  failures: [], passed: true,
  runResults: Object.fromEntries(runIds.map((runId) => [runId, { failures: [], metrics: [], passed: true }])),
});
function completionAction(specification: HostedCampaignExecutableSpec) {
  const completion = specification.completion;
  if (completion === undefined || !("action" in completion)) {
    throw new Error("Expected an action-producing completion");
  }
  return completion.action;
}
const provenanceSpec = (phase: "after" | "before"): HostedCampaignExecutableSpec => ({
  arguments: { kind: "environment" }, childId: `provenance-${phase}`,
  completion: {
    action: { kind: phase === "before" ? "provenance-before" : "provenance-after" },
    campaignId: "campaign-1", kind: "provenance-probe", phase,
    runIds: ["run-1", "run-2", "run-3"], snapshotPath: "/evidence/provenance.json",
  },
  entrypoint: "provenance-probe",
  environment: {
    DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
    DISCORD_E2E_PROVENANCE_CAMPAIGN_ID: "campaign-1", DISCORD_E2E_PROVENANCE_PHASE: phase,
    DISCORD_E2E_PROVENANCE_RUN_IDS_JSON: '["run-1","run-2","run-3"]',
    DISCORD_E2E_PROVENANCE_SNAPSHOT_PATH: "/evidence/provenance.json",
    DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
    DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
    DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
  },
  produces: [{
    action: { kind: phase === "before" ? "provenance-before" : "provenance-after" },
    ordinal: phase === "before" ? 1 : 3,
    outputPath: `/evidence/provenance-${phase}.json`,
    runId: phase === "before" ? "run-1" : "run-3",
  }],
  requires: [],
  startBefore: {
    action: { kind: phase === "before" ? "provenance-before" : "provenance-after" },
    kind: "barrier",
    ordinal: phase === "before" ? 1 : 3,
    runId: phase === "before" ? "run-1" : "run-3",
  },
});
function serviceLevelsSpec(outputPath: string, reportPath: string): HostedCampaignExecutableSpec {
  return {
    arguments: { kind: "environment" }, childId: "service-levels",
    completion: {
      action: { kind: "service-levels-ready" }, campaignId: "campaign-1", kind: "service-levels",
      meetingId: "meeting-1", outputPath, recordingId: "meeting-1", reportPath, runId: "run-overlap-1",
    },
    entrypoint: "service-levels",
    environment: {
      DISCORD_E2E_SLA_CAMPAIGN_ID: "campaign-1", DISCORD_E2E_SLA_MEETING_ID: "meeting-1",
      DISCORD_E2E_SLA_OUTPUT: outputPath, DISCORD_E2E_SLA_RECORDING_ID: "meeting-1",
      DISCORD_E2E_SLA_REPORT_OUTPUT: reportPath, DISCORD_E2E_SLA_RUN_ID: "run-overlap-1",
    },
    produces: [{
      action: { kind: "service-levels-ready" }, ordinal: 3,
      outputPath, runId: "run-overlap-1",
    }],
    requires: [],
    startBefore: {
      action: { kind: "service-levels-ready" }, kind: "barrier", ordinal: 3, runId: "run-overlap-1",
    },
  };
}

function serviceLevelSourcesSpec(root: string): HostedCampaignExecutableSpec {
  const paths = {
    clock: join(root, "clock.json"), database: join(root, "database.json"),
    logs: join(root, "meeting-platform.log"), report: join(root, "source-report.json"),
    s3: join(root, "s3.json"),
  };
  return {
    arguments: { kind: "environment" }, childId: "service-level-sources",
    completion: {
      action: { kind: "service-level-sources-ready" }, campaignId: "campaign-1",
      clockAttestationsPath: paths.clock, databasePath: paths.database,
      kind: "service-level-sources", meetingId: "meeting-1",
      meetingPlatformLogsPath: paths.logs, recordingId: "recording-1",
      reportPath: paths.report, runId: "run-3", s3Path: paths.s3,
    },
    entrypoint: "service-level-sources",
    environment: {
      DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
      DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
      DISCORD_E2E_REMOTE_HOST: HOSTED_CAMPAIGN_TARGET.host,
      DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
      DISCORD_E2E_SLA_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_SLA_CLOCK_ATTESTATIONS_INPUT: paths.clock,
      DISCORD_E2E_SLA_DATABASE_INPUT: paths.database,
      DISCORD_E2E_SLA_MEETING_ID: "meeting-1",
      DISCORD_E2E_SLA_MEETING_PLATFORM_LOG_INPUT: paths.logs,
      DISCORD_E2E_SLA_RECORDING_ID: "recording-1",
      DISCORD_E2E_SLA_RUN_ID: "run-3", DISCORD_E2E_SLA_S3_INPUT: paths.s3,
      DISCORD_E2E_SLA_SOURCE_REPORT_OUTPUT: paths.report,
    },
    produces: [{ action: { kind: "service-level-sources-ready" }, ordinal: 3,
      outputPath: paths.report, runId: "run-3" }], requires: [],
    startBefore: { action: { kind: "service-level-sources-ready" }, kind: "barrier",
      ordinal: 3, runId: "run-3" },
  };
}

describe("hosted campaign process adapter", () => {
  it("keeps one-shot completion JSON distinct from the process event protocol", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true}));',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded()))
      .resolves.toBeUndefined();
  });

  it("publishes service-level readiness only from an exactly correlated finite completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-service-level-completion-"));
    const outputPath = join(root, "service-levels.json");
    const reportPath = join(root, "report.json");
    await writeFile(outputPath, JSON.stringify(serviceLevelsProof()), { mode: 0o600 });
    await writeFile(reportPath, JSON.stringify({
      measurementCount: 3, outputCreated: true, runId: "run-overlap-1",
      schemaVersion: 1, status: "ready",
    }), { mode: 0o600 });
    const completion = JSON.stringify({
      campaignId: "campaign-1", kind: "hosted-service-levels-completion", measurementCount: 3,
      meetingId: "meeting-1", outputPath, recordingId: "meeting-1", reportPath,
      runId: "run-overlap-1", status: "ready",
    });
    const processAdapter = await serviceLevelsAdapter(`process.stdout.write(${JSON.stringify(completion)});`);
    const executable = serviceLevelsSpec(outputPath, reportPath);
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
    await expect(processAdapter.awaitBarrier({ kind: "service-levels-ready" }, bounded())).resolves.toEqual({
      measurementCount: 3, outputPath, recordingId: "meeting-1", runId: "run-overlap-1",
    });
  });

  it("publishes raw source readiness only from exact create-only artifacts and identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-service-level-sources-completion-"));
    await chmod(root, 0o700);
    const executable = serviceLevelSourcesSpec(root);
    const completion = executable.completion;
    if (completion?.kind !== "service-level-sources") {throw new Error("Expected source completion");}
    await Promise.all([
      writeFile(completion.databasePath, "{}\n", { mode: 0o600 }),
      writeFile(completion.s3Path, "{}\n", { mode: 0o600 }),
      writeFile(completion.meetingPlatformLogsPath, "{}\n", { mode: 0o600 }),
      writeFile(completion.clockAttestationsPath, "{}\n", { mode: 0o600 }),
    ]);
    await writeFile(completion.reportPath, JSON.stringify({
      campaignId: completion.campaignId, meetingId: "meeting-1",
      outputs: { clockAttestations: completion.clockAttestationsPath,
        database: completion.databasePath, meetingPlatformLogs: completion.meetingPlatformLogsPath,
        s3: completion.s3Path }, outputsCreated: true, recordingId: "recording-1",
      reportPath: completion.reportPath, runId: completion.runId, schemaVersion: 1, status: "ready",
    }), { mode: 0o600 });
    const stdout = JSON.stringify({
      campaignId: completion.campaignId, clockAttestationsPath: completion.clockAttestationsPath,
      databasePath: completion.databasePath, kind: "hosted-service-level-sources-completion",
      meetingId: "meeting-1", meetingPlatformLogsPath: completion.meetingPlatformLogsPath,
      recordingId: "recording-1", reportPath: completion.reportPath, runId: completion.runId,
      s3Path: completion.s3Path, status: "ready",
    });
    const processAdapter = await serviceLevelSourcesAdapter(
      `process.stdout.write(${JSON.stringify(stdout)});`,
    );
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
    await expect(processAdapter.awaitBarrier({ kind: "service-level-sources-ready" }, bounded()))
      .resolves.toEqual({ outputPath: completion.reportPath, runId: "run-3", sourcesReady: true });
  });

  it("does not publish service-level readiness for a blocked producer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-service-level-blocked-"));
    const executable = serviceLevelsSpec(join(root, "missing.json"), join(root, "report.json"));
    const processAdapter = await serviceLevelsAdapter("process.exit(1);");
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/failed/u);
  });

  it("uses a fresh allowlisted environment and rejects dangerous inheritance", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    await expect(processAdapter.startChild(spec({ PATH: "/bin" }), bounded())).rejects.toThrow(/PATH/u);
    await expect(processAdapter.startChild(spec({ NODE_OPTIONS: "--inspect" }), bounded())).rejects.toThrow(/NODE_OPTIONS/u);
    await expect(processAdapter.startChild(spec({ UNKNOWN: "x" }), bounded())).rejects.toThrow(/UNKNOWN/u);
    const handle = await processAdapter.startChild(spec({ DISCORD_E2E_RUN_ID: "sandbox" }), bounded());
    await processAdapter.stopChild(handle);
  });

  it.each(["collector", "provenance-probe", "recording-ready", "replay-attestation-publisher", "service-level-sources"] as const)(
    "passes the exact trusted runtime environment to the %s child",
    async (entrypoint) => {
      const root = await mkdtemp(join(tmpdir(), "hosted-ssh-environment-"));
      const outputPath = join(root, "environment.json");
      const { processAdapter } = await adapter(`
        void import("node:fs").then(({ writeFileSync }) => {
          const runtimeEnvironment = Object.fromEntries(${JSON.stringify(Object.keys(trustedRuntimeEnvironment))}
            .map((name) => [name, process.env[name]]));
          writeFileSync(process.env.DISCORD_E2E_EVIDENCE_OUTPUT, JSON.stringify(runtimeEnvironment));
          setInterval(() => {}, 1000);
        });
      `);
      const handle = await processAdapter.startChild(environmentProbeSpec(entrypoint, outputPath), bounded());
      try {
        await expect(readJsonEventually(outputPath)).resolves.toEqual(trustedRuntimeEnvironment);
      } finally {
        await processAdapter.stopChild(handle);
      }
    },
  );

  it("rejects a replay attestation publisher outside the pinned hosted target", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-replay-target-"));
    const { processAdapter } = await adapter("setInterval(() => {}, 1000);");
    const declared = environmentProbeSpec("replay-attestation-publisher", join(root, "environment.json"));
    await expect(processAdapter.startChild({
      ...declared,
      environment: { ...declared.environment, DISCORD_E2E_REPLAY_REMOTE_HOST: "other-host" },
    }, bounded())).rejects.toThrow(/target mismatch/u);
  });

  it.each(["actor", "campaign-verifier", "conversation-observer", "evidence-verifier", "live-observer",
    "playback-link-observer", "service-levels", "supplemental-player"] as const)(
    "withholds the trusted SSH runtime environment from the %s child",
    async (entrypoint) => {
      const root = await mkdtemp(join(tmpdir(), "hosted-non-ssh-environment-"));
      const outputPath = join(root, "environment.json");
      const { processAdapter } = await adapter(`
        void import("node:fs").then(({ writeFileSync }) => {
          const runtimeEnvironment = Object.fromEntries(${JSON.stringify(Object.keys(trustedRuntimeEnvironment))}
            .filter((name) => process.env[name] !== undefined)
            .map((name) => [name, process.env[name]]));
          writeFileSync(process.env.DISCORD_E2E_EVIDENCE_OUTPUT, JSON.stringify(runtimeEnvironment));
          setInterval(() => {}, 1000);
        });
      `);
      const handle = await processAdapter.startChild(environmentProbeSpec(entrypoint, outputPath), bounded());
      try {
        await expect(readJsonEventually(outputPath)).resolves.toEqual({});
      } finally {
        await processAdapter.stopChild(handle);
      }
    },
  );

  it("rejects mismatched pinned coordinates before spawning a child", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    await expect(processAdapter.startChild(spec({ DISCORD_E2E_GUILD_ID: "999999999999999999" }), bounded()))
      .rejects.toThrow(/target mismatch.*GUILD_ID/u);
    await expect(processAdapter.startChild({
      arguments: { kind: "environment" }, childId: "observer", entrypoint: "live-observer",
      environment: {
        DISCORD_E2E_LIVE_RESULT_CHANNEL_ID: "999999999999999999",
        DISCORD_E2E_LIVE_SUT_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
      }, produces: [], requires: [], startBefore: { kind: "campaign" },
    }, bounded())).rejects.toThrow(/target mismatch.*RESULT_CHANNEL_ID/u);
    await expect(processAdapter.startChild({
      arguments: { kind: "environment" }, childId: "collector", entrypoint: "collector",
      environment: {
        DISCORD_E2E_MUTATION_TARGET: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        DISCORD_E2E_REMOTE_CRAIG_PROJECT: HOSTED_CAMPAIGN_TARGET.craigProject,
        DISCORD_E2E_REMOTE_HOST: "wrong-host",
        DISCORD_E2E_REMOTE_PROJECT: HOSTED_CAMPAIGN_TARGET.project,
      }, produces: [], requires: [], startBefore: { action: { kind: "provenance-before" }, kind: "barrier", ordinal: 1, runId: "run-1" },
    }, bounded())).rejects.toThrow(/target mismatch.*REMOTE_HOST/u);
  });

  it("rejects early nonzero exit", async () => {
    const { processAdapter } = await adapter("process.exit(7)");
    await processAdapter.startChild(spec(), bounded());
    await expect(processAdapter.awaitBarrier({ kind: "provenance-before" }, bounded()))
      .rejects.toThrow(/exited early/u);
  });

  it("publishes an exact create-only actor release gate", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    const root = await mkdtemp(join(tmpdir(), "hosted-release-"));
    const path = join(root, "gate.json");
    const armedPath = join(root, "gate.armed.json");
    const releaseGate = {
      action: { kind: "provenance-before" as const }, armedPath, ordinal: 1, path, runId: "run-1",
    };
    const executable = spec({
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: "campaign-1",
      DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: armedPath,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: path,
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "1000",
      DISCORD_E2E_RUN_ID: "run-1",
      DISCORD_E2E_SCENARIO: "sequential",
    }, releaseGate);
    await writeFile(armedPath, `${JSON.stringify({
      armedAtEpochMs: Date.now(), campaignId: "campaign-1", phase: "connection", runId: "run-1",
      scenario: "sequential", schemaVersion: 1,
    })}\n`, { mode: 0o600 });
    await processAdapter.publishReleaseGate(executable, bounded());
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      campaignId: "campaign-1", runId: "run-1", scenario: "sequential", schemaVersion: 1,
      target: { guildId: "1533228590643155034", mutationTarget: "test-only", voiceChannelId: "1533228823045214398" },
    });
    await expect(processAdapter.publishReleaseGate(executable, bounded())).rejects.toMatchObject({ code: "EEXIST" });
    await expect(processAdapter.publishReleaseGate({
      ...executable,
      releaseGate: { ...releaseGate, path: join(root, "other-gate.json") },
    }, bounded())).rejects.toThrow(/release gate path mismatch/u);
  });

  it("publishes a supplemental gate only after its correlated waiter is armed", async () => {
    const { processAdapter } = await adapter("setInterval(() => {}, 1000)");
    const root = await mkdtemp(join(tmpdir(), "hosted-supplemental-gate-"));
    const gatePath = join(root, "connection.json");
    const armedPath = join(root, "connection.armed.json");
    const executable: HostedCampaignExecutableSpec = {
      arguments: { kind: "environment" }, childId: "supplemental", entrypoint: "supplemental-player",
      environment: {
        DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: "campaign-1",
        DISCORD_E2E_SUPPLEMENTAL_RUN_ID: "run-3",
      }, produces: [], requires: [], startBefore: { kind: "campaign" }, supplementalGates: {
        connection: { armedPath, path: gatePath, trigger: {
          action: { kind: "capture-retained", ordinal: 3 }, ordinal: 3, runId: "run-3",
        } },
        playback: { armedPath: join(root, "playback.armed.json"), path: join(root, "playback.json"), trigger: {
          action: { kind: "capture-retained", ordinal: 4 }, ordinal: 3, runId: "run-3",
        } },
      },
    };
    const expectation = {
      armedPath, campaignId: "campaign-1", guildId: HOSTED_CAMPAIGN_TARGET.guildId,
      path: gatePath, phase: "connection" as const, runId: "run-3",
      voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    };
    const waiting = waitForSupplementalPlaybackGate(expectation, AbortSignal.timeout(1_000));
    await expect(processAdapter.publishSupplementalGate(executable, "connection", bounded()))
      .resolves.toBeUndefined();
    await expect(waiting).resolves.toBeUndefined();

    const unarmed = { ...executable, supplementalGates: {
      ...executable.supplementalGates!, connection: {
        ...executable.supplementalGates!.connection,
        armedPath: join(root, "missing.armed.json"), path: join(root, "unarmed.json"),
      },
    } };
    await expect(processAdapter.publishSupplementalGate(unarmed, "connection", bounded()))
      .rejects.toThrow(/readiness/u);
  });
});

describe("hosted campaign finite process completion", () => {
  it("awaits a successful one-shot verifier and publishes its exact typed barrier", async () => {
    const { processAdapter, store } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true}));',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(store.awaitAction(completionAction(executable), bounded())).resolves.toEqual({
      ordinal: 1, runId: "run-1", verified: true,
    });
    await expect(processAdapter.awaitBarrier(completionAction(executable), bounded())).resolves.toEqual({
      ordinal: 1, runId: "run-1", verified: true,
    });
  });

  it("allows a finite exit to publish its completion while the barrier is already waiting", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true}));',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await new Promise((resolve) => {setTimeout(resolve, 20);});
    const barrier = processAdapter.awaitBarrier(completionAction(executable), bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(barrier).resolves.toEqual({ordinal: 1, runId: "run-1", verified: true});
  });

  it("finishes bounded teardown after a finite child exits within the caller deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-deadline-teardown-"));
    const readyPath = join(root, "ready.json");
    const exitPath = join(root, "exit.json");
    const source = `
      const { existsSync, writeFileSync } = require("node:fs");
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
        { stdio: "ignore" }).unref();
      process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true}));
      writeFileSync(${JSON.stringify(readyPath)}, "ready");
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(exitPath)})) { clearInterval(timer); process.exit(0); }
      }, 1);
    `;
    const { processAdapter, store } = await adapter(source);
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { await readFile(readyPath, "utf8"); break; } catch {
        if (attempt === 99) { throw new Error("Finite child did not become ready"); }
        await new Promise((resolve) => {setTimeout(resolve, 5);});
      }
    }
    await writeFile(exitPath, "exit", { mode: 0o600 });
    // Arm the caller deadline only after the finite parent had enough time to
    // exit; the deliberately surviving grandchild still needs the adapter's
    // separate teardown budget.
    await new Promise((resolve) => {setTimeout(resolve, 20);});
    const completionDeadline = {
      deadlineEpochMilliseconds: Date.now() + 15,
      signal: new AbortController().signal,
    };
    await expect(processAdapter.awaitChildCompletion(handle, executable, completionDeadline))
      .resolves.toBeUndefined();
    await expect(store.awaitAction(completionAction(executable), bounded())).resolves.toEqual({
      ordinal: 1, runId: "run-1", verified: true,
    });
  });

  it("publishes provenance only from an exactly correlated completion", async () => {
    const completion = JSON.stringify({
      campaignId: "campaign-1", digestSha256: "a".repeat(64), phase: "before",
      runIds: ["run-1", "run-2", "run-3"], schemaVersion: 1, target: HOSTED_CAMPAIGN_TARGET,
    });
    const { processAdapter, store } = await adapter(`process.stdout.write(${JSON.stringify(completion)});`);
    const executable = provenanceSpec("before");
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
    await expect(store.awaitAction({ kind: "provenance-before" }, bounded())).resolves.toEqual({
      digestSha256: "a".repeat(64),
    });

    const mismatched = JSON.stringify({ ...JSON.parse(completion), campaignId: "other" });
    const bad = await adapter(`process.stdout.write(${JSON.stringify(mismatched)});`);
    const badHandle = await bad.processAdapter.startChild(executable, bounded());
    await expect(bad.processAdapter.awaitChildCompletion(badHandle, executable, bounded()))
      .rejects.toThrow(/correlation mismatch/u);
  });

  it("fails closed on malformed or unsuccessful verification output", async () => {
    for (const source of [
      'process.stdout.write("not-json")',
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:false}))',
    ]) {
      const { processAdapter } = await adapter(source);
      const executable = verifierSpec();
      const handle = await processAdapter.startChild(executable, bounded());
      await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow();
    }
  });

  it("rejects nonzero exit even when stdout claims verification passed", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})); process.exit(7);',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/failed \(7\)/u);
  });

  it("kills and rejects completion output beyond the configured bound", async () => {
    const { processAdapter } = await adapter('process.stdout.write("x".repeat(65));', 64);
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/stdout limit/u);
  });

  it("waits for fragmented stdout to drain before parsing completion", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write("{\\\"failures\\\":[],"); process.stdout.write("\\\"metrics\\\":[],\\\"passed\\\":true}");',
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
  });

  it("rejects stderr overflow without exposing buffered process output", async () => {
    const { processAdapter } = await adapter(
      'process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})); process.stderr.write("x".repeat(65));', 64,
    );
    const executable = verifierSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow(/stderr limit/u);
  });

  it("binds collector completion to the exact evidence path and run ID", async () => {
    const good = JSON.stringify({
      evidencePath: "/evidence/run-1.json", metrics: [], recordingId: "recording-1", runId: "run-1", status: "passed",
    });
    const { processAdapter } = await adapter(`process.stdout.write(${JSON.stringify(good)});`);
    const executable = collectorSpec();
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();

    const bad = JSON.stringify({ ...JSON.parse(good), runId: "run-other" });
    const second = await adapter(`process.stdout.write(${JSON.stringify(bad)});`);
    const secondHandle = await second.processAdapter.startChild(executable, bounded());
    await expect(second.processAdapter.awaitChildCompletion(secondHandle, executable, bounded()))
      .rejects.toThrow(/correlation mismatch/u);
  });

  it("publishes campaign verification only for exactly the three configured passing runs", async () => {
    const executable = campaignVerifierSpec();
    const { processAdapter, store } = await adapter(`process.stdout.write(${JSON.stringify(campaignResult([
      "run-1", "run-2", "run-3",
    ]))});`);
    const handle = await processAdapter.startChild(executable, bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(store.awaitAction({ kind: "campaign-verified" }, bounded())).resolves.toEqual({ campaignId: "campaign-1" });

    const invalid = await adapter(`process.stdout.write(${JSON.stringify(campaignResult(["run-1", "run-2", "run-extra"]))});`);
    const invalidHandle = await invalid.processAdapter.startChild(executable, bounded());
    await expect(invalid.processAdapter.awaitChildCompletion(invalidHandle, executable, bounded()))
      .rejects.toThrow(/run results mismatch/u);
  });

  it("does not expose a run barrier before its one-shot completion", async () => {
    const { processAdapter, store } = await adapter(
      'setTimeout(() => process.stdout.write(JSON.stringify({failures:[],metrics:[],passed:true})), 50);',
    );
    const executable = verifierSpec(2, "run-2");
    const handle = await processAdapter.startChild(executable, bounded());
    let visible = false;
    const waiting = (async () => {
      await store.awaitAction(completionAction(executable), bounded());
      visible = true;
    })();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(visible).toBe(false);
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await waiting;
    expect(visible).toBe(true);
  });

  it("maps the recording-ready entrypoint and passes only its required output coordinate", async () => {
    const { processAdapter } = await recordingReadyAdapter("setInterval(() => {}, 1000)");
    const handle = await processAdapter.startChild({
      ...spec({
        DISCORD_E2E_EXPECTED_PIPECAT_SOURCE_REVISION: "d".repeat(40),
        DISCORD_E2E_READY_RECEIPT_OUTPUT: "/evidence/recording-ready.json",
      }),
      childId: "recording-ready",
      entrypoint: "recording-ready",
    }, bounded());
    await processAdapter.stopChild(handle);
  });

  it("publishes recording identity coordinates only from a verified ready artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "recording-ready-artifact-"));
    const outputPath = join(root, "ready.json");
    const receipt = {
      authoritativeSource: { eventDigestSha256: "a".repeat(64), eventId: "event-1",
        kind: "meeting-platform-completion-receipt-v2", occurredAt: "2026-08-12T10:00:00.000Z" },
      meetingId: "recording-1", observedAt: "2026-08-12T10:00:01.000Z",
      pinnedTestTarget: { guildId: HOSTED_CAMPAIGN_TARGET.guildId, provenanceDigestSha256: "b".repeat(64),
        voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId },
      recordingId: "recording-1", runId: "run-1", schemaVersion: 1,
    };
    await writeFile(outputPath, JSON.stringify(receipt), { mode: 0o600 });
    const stdout = JSON.stringify({ kind: "recording-ready-completion", outputPath,
      recordingId: "recording-1", runId: "run-1", status: "ready" });
    const { processAdapter, store } = await recordingReadyAdapter(`process.stdout.write(${JSON.stringify(stdout)});`);
    const action = { kind: "recording-ready" as const, ordinal: 1, runId: "run-1" };
    const executable: HostedCampaignExecutableSpec = {
      arguments: { kind: "environment" }, childId: "recording-ready", completion: {
        action, kind: "recording-ready", outputPath, runId: "run-1",
      }, entrypoint: "recording-ready", environment: {
        DISCORD_E2E_READY_RECEIPT_OUTPUT: outputPath, DISCORD_E2E_RUN_ID: "run-1",
      }, produces: [], requires: [], startBefore: { kind: "campaign" },
    };
    const handle = await processAdapter.startChild(executable, bounded());
    await processAdapter.awaitChildCompletion(handle, executable, bounded());
    await expect(store.awaitAction(action, bounded())).resolves.toMatchObject({
      meetingId: "recording-1", recordingId: "recording-1",
    });
  });
});

describe("hosted campaign finite actor completion", () => {
  it("accepts a finite actor exit only after its stdout and retained artifact correlate", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-finite-artifact-"));
    const outputPath = join(root, "actor.json");
    const actorRun = {
      events: [{ actorName: "speaker-a", atEpochMs: 1_000, type: "ready" }],
      fixtureSetId: "fixtures-v1",
      fixtures: [
        { audioSha256: "1".repeat(64), durationMs: 100, fixtureId: "a", sourceSha256: "2".repeat(64) },
        { audioSha256: "3".repeat(64), durationMs: 100, fixtureId: "b", sourceSha256: "4".repeat(64) },
      ],
      recordingId: null, runId: "run-1", scenario: "sequential",
      schemaVersion: 1, timelineOrigin: "unix-epoch",
    };
    await writeFile(outputPath, JSON.stringify(actorRun), { mode: 0o600 });
    const output = JSON.stringify({
      kind: "actor-completion", outputPath, runId: "run-1",
      scenario: "sequential", status: "completed",
    });
    const processAdapter = await finiteAdapter("main.js", `process.stdout.write(${JSON.stringify(`log\n${output}\n`)});`);
    const executable: HostedCampaignExecutableSpec = {
      ...spec({ DISCORD_E2E_ACTOR_RUN_OUTPUT: outputPath, DISCORD_E2E_RUN_ID: "run-1", DISCORD_E2E_SCENARIO: "sequential" }),
      completion: { action: { kind: "actor-completed", ordinal: 1, runId: "run-1" },
        kind: "actor", outputPath, runId: "run-1", scenario: "sequential" },
    };
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
  });

  it("ingests a finite actor event before verifying its unprefixed completion trailer", async () => {
    const root = await mkdtemp(join(tmpdir(), "hosted-finite-event-"));
    const outputPath = join(root, "actor.json");
    const actorRun = {
      events: [{ actorName: "speaker-a", atEpochMs: 1_000, type: "ready" }],
      fixtureSetId: "fixtures-v1",
      fixtures: [
        { audioSha256: "1".repeat(64), durationMs: 100, fixtureId: "a", sourceSha256: "2".repeat(64) },
        { audioSha256: "3".repeat(64), durationMs: 100, fixtureId: "b", sourceSha256: "4".repeat(64) },
      ],
      recordingId: null, runId: "run-3", scenario: "reconnect",
      schemaVersion: 1, timelineOrigin: "unix-epoch",
    };
    await writeFile(outputPath, JSON.stringify(actorRun), { mode: 0o600 });
    const event = serializeHostedCampaignProcessEvent({
      campaignId: "campaign-1", event: {
        action: { kind: "reconnect-ready" }, evidence: {
          observedAtEpochMilliseconds: 1_000, participantId: "1533224479209885868",
        },
      }, kind: "hosted-campaign-barrier", runId: "run-3", schemaVersion: 1,
    });
    const completion = JSON.stringify({
      kind: "actor-completion", outputPath, runId: "run-3",
      scenario: "reconnect", status: "completed",
    });
    const processAdapter = await finiteAdapter(
      "main.js", `process.stdout.write(${JSON.stringify(`${event}${completion}\n`)});`,
    );
    const produced = { action: { kind: "reconnect-ready" as const }, ordinal: 3,
      outputPath: join(root, "ready.json"), runId: "run-3" };
    const executable: HostedCampaignExecutableSpec = {
      ...spec({ DISCORD_E2E_HOSTED_CAMPAIGN_ID: "campaign-1",
        DISCORD_E2E_RUN_ID: "run-3", DISCORD_E2E_SCENARIO: "reconnect" }),
      completion: { action: { kind: "actor-completed", ordinal: 3, runId: "run-3" },
        kind: "actor", outputPath, runId: "run-3", scenario: "reconnect" },
      produces: [produced],
    };
    const handle = await processAdapter.startChild(executable, bounded());
    await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).resolves.toBeUndefined();
    await expect(processAdapter.awaitBarrier({ kind: "reconnect-ready" }, bounded())).resolves.toMatchObject({
      observedAtEpochMilliseconds: 1_000,
    });
  });

  it("rejects a finite successful exit when its artifact is missing or stdout is malformed", async () => {
    const outputPath = join(await mkdtemp(join(tmpdir(), "hosted-missing-artifact-")), "actor.json");
    const executable: HostedCampaignExecutableSpec = {
      ...spec({ DISCORD_E2E_ACTOR_RUN_OUTPUT: outputPath, DISCORD_E2E_RUN_ID: "run-1", DISCORD_E2E_SCENARIO: "sequential" }),
      completion: { action: { kind: "actor-completed", ordinal: 1, runId: "run-1" },
        kind: "actor", outputPath, runId: "run-1", scenario: "sequential" },
    };
    const completion = JSON.stringify({
      kind: "actor-completion", outputPath, runId: "run-1", scenario: "sequential", status: "completed",
    });
    for (const source of ['process.stdout.write("not-json\\n")', `process.stdout.write(${JSON.stringify(`${completion}\n`)});`]) {
      const processAdapter = await finiteAdapter("main.js", source);
      const handle = await processAdapter.startChild(executable, bounded());
      await expect(processAdapter.awaitChildCompletion(handle, executable, bounded())).rejects.toThrow();
    }
  });
});
