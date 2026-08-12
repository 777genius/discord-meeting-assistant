import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ReplayTargetAttestation } from "../src/e2e-retained-evidence-contracts.js";
import {
  SshDeploymentEvidenceProbe,
  type SshDeploymentProbeCommands,
} from "../src/ssh-deployment-probe.js";
import {
  runRemoteProbe,
} from "../src/ssh-deployment-probe-commands.js";
import {
  replayJobScript,
  replayReadinessScript,
} from "../src/ssh-deployment-probe-scripts.js";
import {
  parseSshDeploymentProbeOptions,
} from "../src/ssh-deployment-probe-validation.js";

const containerId = "a".repeat(64);
const target: ReplayTargetAttestation = {
  fixtureSetId: "fixture-v1",
  recordingId: "recording-1",
  runId: "run-1",
};

function probe(commands: SshDeploymentProbeCommands): SshDeploymentEvidenceProbe {
  return new SshDeploymentEvidenceProbe({
    attestationFile: "/tmp/discord-e2e-attestations/run-1.json",
    composeFile: "/srv/e2e/compose.yaml",
    craigProjectName: "craig-meeting-e2e",
    craigServiceName: "bot",
    envFile: "/srv/e2e/source.env",
    host: "fake-e2e-host",
    mutationTarget: "test-only",
    projectName: "discord-meeting-assistant",
    sourceRoot: "/srv/e2e/source",
  }, commands);
}

function marker(overrides: Partial<ReplayTargetAttestation> = {}): string {
  return JSON.stringify({
    ...target,
    ...overrides,
    purpose: "bullmq-post-call-replay",
    schemaVersion: 1,
  });
}

function fakeCommands(input: {
  readonly consumeError?: Error;
  readonly containerIds?: readonly string[];
  readonly label?: string;
  readonly marker?: string;
  readonly mutations: string[];
  readonly playbackOrigin?: string;
  readonly replayError?: Error;
}): SshDeploymentProbeCommands {
  let currentContainerId = containerId;
  let dockerPsCall = 0;
  return {
    runCompose: async () => {
      throw new Error("unexpected Compose probe");
    },
    runContainer: async (_settings, exactContainerId, args) => {
      expect(exactContainerId).toBe(currentContainerId);
      if (args.includes(replayReadinessScript)) {
        expect(args).toEqual([
          "node",
          "--input-type=module",
          "-e",
          replayReadinessScript,
          target.recordingId,
        ]);
        return JSON.stringify({
          beforeProcessedOn: 1_000,
          jobId: "post-call-v1-test",
          state: "completed",
        });
      }
      if (args.includes(replayJobScript)) {
        expect(args).toEqual([
          "node",
          "--input-type=module",
          "-e",
          replayJobScript,
          target.recordingId,
          "1000",
        ]);
        if (input.replayError !== undefined) {
          throw input.replayError;
        }
        input.mutations.push("retry");
        return JSON.stringify({
          afterProcessedOn: 2_000,
          beforeProcessedOn: 1_000,
          jobId: "post-call-v1-test",
          state: "completed",
        });
      }
      throw new Error("unexpected container probe");
    },
    runRemote: async (_settings, args) => {
      if (args[0] === "docker" && args[1] === "ps") {
        currentContainerId = input.containerIds?.[dockerPsCall] ?? containerId;
        dockerPsCall += 1;
        return currentContainerId;
      }
      if (args[0] === "docker" && args[1] === "inspect") {
        expect(args.at(-1)).toBe(currentContainerId);
        return JSON.stringify({
          composeProject: "discord-meeting-assistant",
          composeService: "meeting-platform",
          testOnly: input.label ?? "true",
        });
      }
      if (args[0] === "docker" && args[1] === "exec") {
        expect(args).toEqual([
          "docker",
          "exec",
          currentContainerId,
          "printenv",
          "RECORDING_PLAYBACK_PUBLIC_BASE_URL",
        ]);
        return input.playbackOrigin ?? "https://recordings.example.test";
      }
      if (args[0] === "sh" && args[2]?.includes("rm --") === true) {
        if (input.consumeError !== undefined) {
          throw input.consumeError;
        }
        input.mutations.push("consume-marker");
        return "";
      }
      if (args[0] === "sh") {
        return input.marker ?? marker();
      }
      throw new Error("unexpected remote probe");
    },
  };
}

describe("SshDeploymentEvidenceProbe replay target safety", () => {
  it("keeps the outer SSH timeout beyond the remote replay deadline", () => {
    const settings = parseSshDeploymentProbeOptions({
      attestationFile: "/tmp/discord-e2e-attestations/run-1.json",
      composeFile: "/srv/e2e/compose.yaml",
      craigProjectName: "craig-meeting-e2e",
      craigServiceName: "bot",
      envFile: "/srv/e2e/source.env",
      host: "fake-e2e-host",
      mutationTarget: "test-only",
      projectName: "discord-meeting-assistant",
      sourceRoot: "/srv/e2e/source",
    });

    expect(settings.timeoutMs).toBe(330_000);
  });

  it("waits for SSH child cleanup after a timeout", async () => {
    const directory = await mkdtemp(join(tmpdir(), "discord-e2e-fake-ssh-"));
    const executable = join(directory, "ssh");
    await writeFile(executable, [
      "#!/usr/bin/env node",
      "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 100));",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"));
    await chmod(executable, 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${directory}:${originalPath ?? ""}`;
    const startedAt = Date.now();
    try {
      const settings = parseSshDeploymentProbeOptions({
        attestationFile: "/tmp/discord-e2e-attestations/run-1.json",
        composeFile: "/srv/e2e/compose.yaml",
        craigProjectName: "craig-meeting-e2e",
        craigServiceName: "bot",
        envFile: "/srv/e2e/source.env",
        host: "fake-e2e-host",
        mutationTarget: "test-only",
        projectName: "discord-meeting-assistant",
        sourceRoot: "/srv/e2e/source",
        timeoutMs: 250,
      });

      await expect(runRemoteProbe(settings, ["true"]))
        .rejects.toThrow("timed out after 250ms");
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(325);
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a non-allowlisted project before invoking a remote command", () => {
    const mutations: string[] = [];
    const commands = fakeCommands({ mutations });

    expect(() => new SshDeploymentEvidenceProbe({
      attestationFile: "/tmp/discord-e2e-attestations/run-1.json",
      composeFile: "/srv/e2e/compose.yaml",
      craigProjectName: "craig-meeting-e2e",
      craigServiceName: "bot",
      envFile: "/srv/e2e/source.env",
      host: "fake-e2e-host",
      mutationTarget: "test-only",
      projectName: "production-meetings",
      sourceRoot: "/srv/e2e/source",
    }, commands)).toThrow();
    expect(mutations).toEqual([]);
  });

  it("rejects a missing test-only label before marker consumption or retry", async () => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({ label: "false", mutations }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow();
    expect(mutations).toEqual([]);
  });

  it.each(["", "http://recordings.example.test", "https://other.example.test"])(
    "rejects playback origin %j outside the attested test deployment",
    async (playbackOrigin) => {
      const mutations: string[] = [];
      const deployment = probe(fakeCommands({ mutations, playbackOrigin }));

      await expect(deployment.assertRecordingPlaybackTargetSafe({
        meetingPlatformContainerId: containerId,
        origin: "https://recordings.example.test",
        scope: "private-test-deployment",
      })).rejects.toThrow(
        /recording playback|HTTPS origin/iu,
      );
      expect(mutations).toEqual([]);
    },
  );

  it.each([
    ["fixtureSetId", { fixtureSetId: "other-fixture" }],
    ["runId", { runId: "other-run" }],
    ["recordingId", { recordingId: "other-recording" }],
  ] as const)("rejects a wrong %s marker before mutation", async (_name, mismatch) => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({ marker: marker(mismatch), mutations }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow("does not match");
    expect(mutations).toEqual([]);
  });

  it("consumes an exact attestation before permitting a fake replay", async () => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({ mutations }));

    await expect(deployment.replayPostCall(target)).resolves.toMatchObject({
      afterProcessedOn: 2_000,
      beforeProcessedOn: 1_000,
      state: "completed",
    });
    expect(mutations).toEqual(["consume-marker", "retry"]);
  });

  it("rejects a changed exact container before consuming the marker", async () => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({
      containerIds: [containerId, "b".repeat(64)],
      mutations,
    }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow(
      "container changed",
    );
    expect(mutations).toEqual([]);
  });

  it("does not attempt replay when marker consumption fails", async () => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({
      consumeError: new Error("fake marker consume failure"),
      mutations,
    }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow(
      "fake marker consume failure",
    );
    expect(mutations).toEqual([]);
  });

  it("keeps a changed completed job from reaching retry", async () => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({
      mutations,
      replayError: new Error("post-call job changed after replay safety preflight"),
    }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow(
      "post-call job changed",
    );
    expect(mutations).toEqual(["consume-marker"]);
  });
});
