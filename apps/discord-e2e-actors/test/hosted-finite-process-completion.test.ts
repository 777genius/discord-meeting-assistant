import { chmod, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { verifyHostedFiniteProcessCompletion } from
  "../src/hosted-finite-process-completion.js";
import { retainedV8Evidence } from "./e2e-evidence-fixtures.js";

async function privateArtifact(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "finite-completion-"));
  await chmod(root, 0o700);
  const path = join(root, "evidence.json");
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  return path;
}

describe("hosted finite process completion", () => {
  it("correlates replay attestation completion to the pinned fixture manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-attestation-completion-"));
    const fixtureManifestPath = join(root, "manifest.json");
    await writeFile(fixtureManifestPath, await readFile(new URL("./fixtures/manifest.v1.json", import.meta.url)), {
      mode: 0o600,
    });
    await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
      containerId: "a".repeat(64), fixtureSetId: "discord-meeting-ru-en-v6",
      imageId: `sha256:${"b".repeat(64)}`, kind: "replay-attestation-publisher-completion",
      recordingId: "recording-1", remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json",
      runId: "run-1", sourceRevision: "c".repeat(40), status: "ready",
    }), {
      fixtureManifestPath, kind: "replay-attestation-publisher", recordingId: "recording-1",
      remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json", runId: "run-1",
    })).resolves.toMatchObject({ fixtureSetId: "discord-meeting-ru-en-v6", recordingId: "recording-1" });
  });
  it("accepts actor completion only when stdout and retained artifact share exact coordinates", async () => {
    const source = retainedV8Evidence().actorRun;
    const artifact = {
      ...source,
      events: source.events.map((event, index) => ({ ...event, atEpochMs: 1_000 + index * 100 })),
      recordingId: null, timelineOrigin: "unix-epoch",
    };
    const outputPath = await privateArtifact(artifact);
    const completion = JSON.stringify({
      kind: "actor-completion", outputPath, runId: artifact.runId,
      scenario: artifact.scenario, status: "completed",
    });
    await expect(verifyHostedFiniteProcessCompletion(`human log\n${completion}\n`, {
      kind: "actor", outputPath, runId: artifact.runId, scenario: artifact.scenario,
    })).resolves.toMatchObject({ runId: artifact.runId, scenario: artifact.scenario });
    await expect(verifyHostedFiniteProcessCompletion(completion, {
      kind: "actor", outputPath, runId: "wrong-run", scenario: artifact.scenario,
    })).rejects.toThrow(/run ID correlation mismatch/u);
  });

  it("binds conversation completion to every ordered output and retained run ID", async () => {
    const captures = retainedV8Evidence().conversation.voice.slice(0, 2);
    const outputPaths = await Promise.all(captures.map(privateArtifact));
    const runId = captures[0]!.runId;
    const completion = JSON.stringify({
      kind: "conversation-observer-completion", outputPaths, runId, status: "completed",
    });
    await expect(verifyHostedFiniteProcessCompletion(completion, {
      kind: "conversation-observer", outputPaths, runId,
    })).resolves.toHaveLength(2);
    await expect(verifyHostedFiniteProcessCompletion(completion, {
      kind: "conversation-observer", outputPaths: outputPaths.toReversed(), runId,
    })).rejects.toThrow(/output paths correlation mismatch/u);
  });

  it("rejects missing, malformed and uncorrelated completion output", async () => {
    const artifact = retainedV8Evidence().conversation.supplementalPlayback;
    const outputPath = await privateArtifact(artifact);
    const expected = { kind: "supplemental-player" as const, outputPath, runId: artifact.runId };
    await expect(verifyHostedFiniteProcessCompletion("", expected)).rejects.toThrow(/no completion/u);
    await expect(verifyHostedFiniteProcessCompletion("not-json\n", expected)).rejects.toThrow(/malformed/u);
    await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
      kind: "supplemental-player-completion", outputPath, runId: "other-run", status: "completed",
    }), expected)).rejects.toThrow(/run ID correlation mismatch/u);
  });

  it("rejects symlinked and non-private retained artifacts", async () => {
    const artifact = retainedV8Evidence().conversation.supplementalPlayback;
    const outputPath = await privateArtifact(artifact);
    const completion = (path: string) => JSON.stringify({
      kind: "supplemental-player-completion", outputPath: path,
      runId: artifact.runId, status: "completed",
    });

    await chmod(outputPath, 0o644);
    await expect(verifyHostedFiniteProcessCompletion(completion(outputPath), {
      kind: "supplemental-player", outputPath, runId: artifact.runId,
    })).rejects.toThrow(/regular owned mode-0600/u);

    await chmod(outputPath, 0o600);
    const linkPath = `${outputPath}.link`;
    await symlink(outputPath, linkPath);
    await expect(verifyHostedFiniteProcessCompletion(completion(linkPath), {
      kind: "supplemental-player", outputPath: linkPath, runId: artifact.runId,
    })).rejects.toThrow(/regular owned mode-0600/u);
  });

  it("rejects empty and oversized retained artifacts before JSON parsing", async () => {
    const root = await mkdtemp(join(tmpdir(), "finite-completion-size-"));
    await chmod(root, 0o700);
    for (const [label, value] of [["empty", ""], ["oversized", "x".repeat(32 * 1024 * 1024 + 1)]] as const) {
      const outputPath = join(root, `${label}.json`);
      await writeFile(outputPath, value, { mode: 0o600 });
      await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
        kind: "supplemental-player-completion", outputPath,
        runId: "run-overlap-1", status: "completed",
      }), { kind: "supplemental-player", outputPath, runId: "run-overlap-1" }))
        .rejects.toThrow(/at most 32 MiB/u);
    }
  });

  it("validates recording-ready and playback-link retained artifacts after stdout correlation", async () => {
    const fixture = retainedV8Evidence();
    const runId = fixture.actorRun.runId;
    const recordingId = fixture.recording.recordingId;
    const ready = {
      authoritativeSource: {
        eventDigestSha256: "a".repeat(64), eventId: "event-1",
        kind: "meeting-platform-completion-receipt-v2", occurredAt: "2026-08-12T10:00:00.000Z",
      },
      meetingId: recordingId, observedAt: "2026-08-12T10:00:01.000Z",
      pinnedTestTarget: {
        guildId: "1533228590643155034", provenanceDigestSha256: "b".repeat(64),
        voiceChannelId: "1533228823045214398",
      },
      recordingId, runId, schemaVersion: 1,
    };
    const readyPath = await privateArtifact(ready);
    await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
      kind: "recording-ready-completion", outputPath: readyPath,
      recordingId, runId, status: "ready",
    }), { kind: "recording-ready", outputPath: readyPath, runId })).resolves.toMatchObject({ recordingId, runId });

    const source = {
      capabilitySha256: "6".repeat(64),
      container: { kind: "channel-message" as const, parentChannelId: "1533228891827736657" },
      firstSeenPollCompletedAt: { epochMilliseconds: 9_500, monotonicMilliseconds: 19_500 },
      firstSeenPollStartedAt: { epochMilliseconds: 9_490, monotonicMilliseconds: 19_490 },
      messageId: "message-1", origin: "https://recordings.example.test", pathname: "/recordings/playback" as const,
      projectionMarker: "meeting-1:final", resultChannelId: "1533228891827736657",
    };
    const proof = {
      container: source.container,
      firstSeenPollCompletedAt: source.firstSeenPollCompletedAt,
      firstSeenPollStartedAt: source.firstSeenPollStartedAt,
      link: { capabilitySha256: source.capabilitySha256, origin: source.origin, pathname: source.pathname },
      messageId: source.messageId,
      observerArmedAt: { epochMilliseconds: 9_400, monotonicMilliseconds: 19_400 },
      pollIntervalMs: 50, projectionMarker: source.projectionMarker,
      recordingId, resultChannelId: source.resultChannelId, runId,
      schemaVersion: 1, sutApplicationId: "1533224474609057793",
    };
    const proofPath = await privateArtifact(proof);
    await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
      kind: "playback-link-observer-completion", messageId: proof.messageId,
      outputPath: proofPath, recordingId, runId, status: "captured",
    }), { kind: "playback-link-observer", outputPath: proofPath, recordingId, runId }))
      .resolves.toMatchObject({ messageId: proof.messageId, recordingId, runId });
    await expect(verifyHostedFiniteProcessCompletion(JSON.stringify({
      kind: "playback-link-observer-completion", messageId: proof.messageId,
      outputPath: proofPath, recordingId, runId, status: "captured",
    }), { kind: "playback-link-observer", outputPath: proofPath, runId }))
      .resolves.toMatchObject({ recordingId });
  });
});
