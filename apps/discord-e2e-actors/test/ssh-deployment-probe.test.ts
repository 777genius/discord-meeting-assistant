import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReplayTargetAttestation } from "../src/e2e-retained-evidence-contracts.js";
import {
  SshDeploymentEvidenceProbe,
  type SshDeploymentProbeCommands,
} from "../src/ssh-deployment-probe.js";
import {
  runRemoteProbe,
} from "../src/ssh-deployment-probe-commands.js";
import {
  completionReceiptsScript,
  replayJobScript,
  replayReadinessScript,
} from "../src/ssh-deployment-probe-scripts.js";
import {
  assertReplayTargetAttestation,
  parseSshDeploymentProbeOptions,
} from "../src/ssh-deployment-probe-validation.js";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

const containerId = "a".repeat(64);
const imageId = `sha256:${"d".repeat(64)}`;
const sourceRevision = "f".repeat(40);
const target: ReplayTargetAttestation = {
  fixtureSetId: "fixture-v1",
  recordingId: "recording-1",
  runId: "run-1",
};

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});

function fakeChildProcess(kill: ChildProcess["kill"] = vi.fn(() => true)): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.kill = kill;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

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

function marker(overrides: Partial<ReplayTargetAttestation> & {
  readonly containerId?: string;
  readonly imageId?: string;
  readonly sourceRevision?: string;
} = {}): string {
  return JSON.stringify({
    containerId,
    ...target,
    imageId,
    ...overrides,
    purpose: "bullmq-post-call-replay",
    schemaVersion: 2,
    sourceRevision: overrides.sourceRevision ?? sourceRevision,
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
          jobId: "post-call-v2-test",
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
          jobId: "post-call-v2-test",
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
        if (args.some((argument) => argument.includes("containerStartedAt"))) {
          return JSON.stringify({
            composeConfigHash: "c".repeat(64),
            composeProject: "discord-meeting-assistant",
            composeService: "meeting-platform",
            containerId: currentContainerId,
            containerStartedAt: "2026-08-12T09:00:00.000Z",
            imageId,
          });
        }
        return JSON.stringify({
          composeProject: "discord-meeting-assistant",
          composeService: "meeting-platform",
          testOnly: input.label ?? "true",
        });
      }
      if (args[0] === "docker" && args[1] === "image") {
        expect(args.at(-1)).toBe(imageId);
        return JSON.stringify({
          imageId,
          repositoryDigests: [`registry.test/image@sha256:${"e".repeat(64)}`],
          sourceRevision,
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
  it("allows read-only provenance probes without a replay attestation path", async () => {
    const servicesByContainer = new Map<string, { project: string; service: string }>();
    let containerSequence = 0;
    const commands: SshDeploymentProbeCommands = {
      runCompose: async () => { throw new Error("unexpected Compose probe"); },
      runContainer: async () => { throw new Error("unexpected container probe"); },
      runRemote: async (_settings, args) => {
        if (args[0] === "docker" && args[1] === "ps") {
          const project = String(args.find((value) => value.startsWith("label=com.docker.compose.project="))?.split("=").at(-1));
          const service = String(args.find((value) => value.startsWith("label=com.docker.compose.service="))?.split("=").at(-1));
          const id = (containerSequence += 1).toString(16).repeat(64);
          servicesByContainer.set(id, { project, service });
          return id;
        }
        if (args[0] === "docker" && args[1] === "inspect" && args[2] === "--format") {
          const identity = servicesByContainer.get(String(args.at(-1)));
          if (identity === undefined) {
            throw new Error("unknown test container");
          }
          return JSON.stringify({
            composeConfigHash: "c".repeat(64), composeProject: identity.project,
            composeService: identity.service, containerId: args.at(-1),
            containerStartedAt: "2026-08-12T09:00:00.000Z",
            imageId: `sha256:${"d".repeat(64)}`,
          });
        }
        if (args[0] === "docker" && args[1] === "image") {
          return JSON.stringify({
            imageId: `sha256:${"d".repeat(64)}`,
            repositoryDigests: [`registry.test/image@sha256:${"e".repeat(64)}`],
            sourceRevision: "f".repeat(40),
          });
        }
        throw new Error(`unexpected remote probe: ${args.join(" ")}`);
      },
    };
    const deployment = new SshDeploymentEvidenceProbe({
      composeFile: "/srv/e2e/compose.yaml", craigProjectName: "craig-meeting-e2e",
      craigServiceName: "bot", envFile: "/srv/e2e/source.env", host: "fake-e2e-host",
      mutationTarget: "test-only", projectName: "discord-meeting-assistant",
      sourceRoot: "/srv/e2e/source",
    }, commands);

    await expect(deployment.collectProvenance()).resolves.toMatchObject({
      craig: { composeProject: "craig-meeting-e2e" },
      meetingPlatform: { composeProject: "discord-meeting-assistant" },
    });
    await expect(deployment.replayPostCall(target)).rejects.toThrow(
      "Replay target attestation file is required",
    );
  });

  it("reads completion receipts through the exact running test container", async () => {
    const base = fakeCommands({ mutations: [] });
    const commands: SshDeploymentProbeCommands = {
      ...base,
      runContainer: async (_settings, exactContainerId, args) => {
      expect(exactContainerId).toBe(containerId);
      expect(args).toEqual(["node", "--input-type=module", "-e", completionReceiptsScript]);
      return JSON.stringify([{ recordingId: "recording-1" }]);
      },
    };

    await expect(probe(commands).collectRecordingCompletionReceipts()).resolves.toEqual([
      { recordingId: "recording-1" },
    ]);
  });

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
    vi.useFakeTimers();
    const kill = vi.fn(() => true);
    const child = fakeChildProcess(kill);
    spawnMock.mockReturnValue(child);
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
    let outcome: "pending" | "rejected" | "resolved" = "pending";

    const result = runRemoteProbe(settings, ["true"]);
    void result.then(
      () => (outcome = "resolved"),
      () => (outcome = "rejected"),
    );
    await vi.advanceTimersByTimeAsync(250);

    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(outcome).toBe("pending");

    child.emit("close", 0, "SIGTERM");

    await expect(result).rejects.toThrow("timed out after 250ms");
    expect(outcome).toBe("rejected");
  });

  it("terminates the SSH child when the caller aborts and waits for cleanup", async () => {
    const kill = vi.fn(() => true);
    const child = fakeChildProcess(kill);
    spawnMock.mockReturnValue(child);
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
      timeoutMs: 5_000,
    });
    const controller = new AbortController();
    const result = runRemoteProbe(settings, ["true"], controller.signal);

    controller.abort(new Error("campaign deadline expired"));
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    child.emit("close", 0, "SIGTERM");

    await expect(result).rejects.toThrow("campaign deadline expired");
  });
});

describe("SshDeploymentEvidenceProbe replay mutation fences", () => {
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

  it.each([
    ["containerId", { containerId: "b".repeat(64) }],
    ["imageId", { imageId: `sha256:${"9".repeat(64)}` }],
    ["sourceRevision", { sourceRevision: "8".repeat(40) }],
  ] as const)("rejects marker with stale %s before mutation", async (_name, mismatch) => {
    const mutations: string[] = [];
    const deployment = probe(fakeCommands({ marker: marker(mismatch), mutations }));

    await expect(deployment.replayPostCall(target)).rejects.toThrow("container provenance");
    expect(mutations).toEqual([]);
  });

  it("rejects legacy marker v1 for campaign replay", async () => {
    const mutations: string[] = [];
    const legacy = JSON.stringify({
      ...target, purpose: "bullmq-post-call-replay", schemaVersion: 1,
    });

    await expect(probe(fakeCommands({ marker: legacy, mutations })).replayPostCall(target))
      .rejects.toThrow("Legacy replay marker v1");
    expect(mutations).toEqual([]);
  });

  it("allows a legacy marker only for an explicit historical read", () => {
    const legacy = {
      ...target, purpose: "bullmq-post-call-replay", schemaVersion: 1,
    } as const;

    expect(() => {
      assertReplayTargetAttestation({
        composeProject: "discord-meeting-assistant",
        composeService: "meeting-platform",
        testOnly: "true",
      }, legacy, target, { containerId, imageId, sourceRevision }, "historical-read");
    }).not.toThrow();
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
      /container (?:changed|provenance)/u,
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
