import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  readPrivateLiveDiscordPlaybackLinkProof,
  serviceLevelSourcesFromLiveProof,
} from "../src/e2e-collector-service-level-input.js";
import { serviceLevelsProof } from "./e2e-service-level-fixtures.js";

describe("collector Live Discord playback link proof input", () => {
  it("strictly parses a private exact-marker observer proof", async () => {
    const path = await writeProofFile(proof());

    await expect(readPrivateLiveDiscordPlaybackLinkProof(path)).resolves.toEqual(proof());
  });

  it("rejects a proof file that is not mode 0600", async () => {
    const path = await writeProofFile(proof());
    await chmod(path, 0o644);

    await expect(readPrivateLiveDiscordPlaybackLinkProof(path)).rejects.toThrow("mode-0600");
  });

  it("rejects fields outside the exact observer proof schema", async () => {
    const path = await writeProofFile({ ...proof(), operatorTimestamp: 9_505 });

    await expect(readPrivateLiveDiscordPlaybackLinkProof(path)).rejects.toThrow();
  });

  it("maps an exact observer proof only when the SLA measurement matches it", () => {
    const result = serviceLevelSourcesFromLiveProof(proof(), serviceLevelsProof(), {
      playbackOrigin: "https://recordings.example.test",
      recordingId: "meeting-1",
      runId: "run-overlap-1",
    });

    expect(result.discordPlaybackLinkProof.firstSeenPollCompletedAt.epochMilliseconds).toBe(9_500);
    expect(result.participantLifecycleReceipts).toEqual([]);
  });

  it("rejects a run mismatch before collection", () => {
    expect(() => serviceLevelSourcesFromLiveProof(
      { ...proof(), runId: "stale-run" }, serviceLevelsProof(), {
        playbackOrigin: "https://recordings.example.test",
        recordingId: "meeting-1",
        runId: "run-1",
      },
    )).toThrow("does not match the requested run and recording");
  });

  it("rejects a measurement timestamp not supplied by the exact observer", () => {
    const serviceLevels = serviceLevelsProof();
    const measurement = serviceLevels.measurements.find(
      ({ serviceLevelId }) => serviceLevelId === "recording-end-to-discord-first-seen",
    )!;
    measurement.end.atEpochMs += 1;

    expect(() => serviceLevelSourcesFromLiveProof(proof(), serviceLevels, {
      playbackOrigin: "https://recordings.example.test",
      recordingId: "meeting-1",
      runId: "run-overlap-1",
    })).toThrow("end timestamp does not match");
  });
});

function proof() {
  const measurement = serviceLevelsProof().measurements.find(
    ({ serviceLevelId }) => serviceLevelId === "recording-end-to-discord-first-seen",
  )!;
  if (measurement.serviceLevelId !== "recording-end-to-discord-first-seen") {
    throw new Error("recording link measurement required");
  }
  const source = measurement.end.source;
  const container = source.container.kind === "channel-message"
    ? source.container
    : {
        id: source.container.threadId,
        kind: "thread" as const,
        name: "Meeting results",
        parentId: source.container.parentChannelId,
      };
  return {
    container,
    firstSeenPollCompletedAt: source.firstSeenPollCompletedAt,
    firstSeenPollStartedAt: source.firstSeenPollStartedAt,
    link: {
      capabilitySha256: source.capabilitySha256,
      origin: source.origin,
      pathname: source.pathname,
    },
    messageId: source.messageId,
    observerArmedAt: { epochMilliseconds: 9_300, monotonicMilliseconds: 19_300 },
    pollIntervalMs: 100,
    projectionMarker: source.projectionMarker,
    recordingId: source.recordingId,
    resultChannelId: source.resultChannelId,
    runId: source.runId,
    schemaVersion: 1 as const,
    sutApplicationId: "sut-application-1",
  };
}

async function writeProofFile(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "discord-link-proof-"));
  const path = join(directory, "proof.json");
  await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
