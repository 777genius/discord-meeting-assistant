import { describe, expect, it } from "vitest";

import {
  SshHostedServiceLevelRawProbe,
  type HostedClockObserver,
  type HostedServiceLevelRawProbeCommands,
} from "../src/hosted-service-level-raw-probe.js";
import { postgresEvidenceQuery, s3EvidenceScript } from
  "../src/ssh-deployment-probe-scripts.js";

const containerId = "a".repeat(64);

describe("hosted service-level read-only raw probe", () => {
  it("collects database, S3, and only correlated Meeting Platform JSON logs", async () => {
    const calls: string[] = [];
    let observerSampleIndex = 0;
    const clockObserver: HostedClockObserver = {
      sample: async () => ({
        bootId: "observer-boot", epochMs: 10_000 + observerSampleIndex * 10,
        monotonicNs: String(10_000_000_000n + BigInt(observerSampleIndex++) * 10_000_000n),
      }),
    };
    const commands: HostedServiceLevelRawProbeCommands = {
      runCompose: async (_settings, service, args) => {
        calls.push(`compose:${service}`);
        if (service === "postgres") {
          expect(args.at(-1)).toBe(postgresEvidenceQuery.replaceAll(
            "__RECORDING_ID__",
            "meeting-1",
          ));
          return JSON.stringify(database());
        }
        if (args.includes("--input-type=commonjs")) {
          return JSON.stringify({
            after: { bootId: "source-boot", epochMs: 10_008, monotonicNs: "10008000000" },
            before: { bootId: "source-boot", epochMs: 10_005, monotonicNs: "10005000000" },
            sample: { bootId: "source-boot", epochMs: 10_007, monotonicNs: "10007000000" },
          });
        }
        expect(args).toEqual([
          "node",
          "--input-type=module",
          "-e",
          s3EvidenceScript,
          "s3://recordings/meeting-1/manifest.json",
          "meeting-1",
        ]);
        return JSON.stringify(s3());
      },
      runRemote: async (_settings, args) => {
        calls.push(`remote:${args.slice(0, 2).join(":")}`);
        if (args[1] === "ps") {
          return containerId;
        }
        expect(args).toEqual([
          "docker",
          "logs",
          "--since",
          "1970-01-01T00:00:01.000Z",
          containerId,
        ]);
        return [
          JSON.stringify({ meetingId: "other", message: "ignore" }),
          "not-json",
          JSON.stringify({ meetingId: "meeting-1", message: "keep" }),
        ].join("\n");
      },
    };
    const probe = new SshHostedServiceLevelRawProbe(remote(), commands, clockObserver);

    await expect(probe.collectDatabase("meeting-1")).resolves.toEqual(database());
    await expect(probe.collectS3("s3://recordings/meeting-1/manifest.json", "meeting-1"))
      .resolves.toEqual(s3());
    await expect(probe.collectMeetingPlatformLogs(
      "meeting-1",
      "1970-01-01T00:00:01.000Z",
    )).resolves.toBe(`${JSON.stringify({ meetingId: "meeting-1", message: "keep" })}\n`);
    await expect(probe.collectClockCompletion()).resolves.toMatchObject({
      observer: { after: { epochMs: 10_010 }, before: { epochMs: 10_000 } },
      observerClockId: "host:codex-workers-eu-01",
      sourceClockId: "container:meeting-platform",
    });
    expect(calls).toEqual([
      "compose:postgres",
      "compose:meeting-platform",
      "remote:docker:ps",
      "remote:docker:logs",
      "compose:meeting-platform",
    ]);
  });
});

function remote() {
  return {
    composeFile: "/srv/e2e/compose.yaml",
    craigProjectName: "craig-meeting-e2e" as const,
    craigServiceName: "bot" as const,
    environmentFile: "/srv/e2e/source.env",
    host: "codex-workers-eu-01" as const,
    mutationTarget: "test-only" as const,
    projectName: "discord-meeting-assistant" as const,
    sourceRoot: "/srv/e2e/source",
  };
}

function database() {
  return {
    matchingMeetingCount: 1,
    matchingRecordingCount: 1,
    matchingSummaryCount: 1,
    matchingTranscriptCount: 1,
    snapshot: {},
  };
}

function s3() {
  return {
    endedAt: "1970-01-01T00:00:10.000Z",
    manifestChecksumSha256: "a".repeat(64),
    manifestLocator: "s3://recordings/meeting-1/manifest.json",
    recordingId: "meeting-1",
    sourceChecksumSha256: "b".repeat(64),
    startedAt: "1970-01-01T00:00:01.000Z",
    tracks: [{
      checksumSha256: "c".repeat(64),
      durationMs: 9_000,
      locator: "s3://recordings/meeting-1/speaker.ogg",
      sizeBytes: 42,
      speakerId: "speaker-1",
      timelineOffsetMs: 0,
    }],
  };
}
