import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import type { E2eServiceLevelsV1, ServiceLevelSourcesV1 } from "./e2e-service-levels.js";
import {
  liveDiscordPlaybackLinkProofSchema,
  type LiveDiscordPlaybackLinkProof,
} from "./live-discord-playback-link-observer.js";

const maximumProofBytes = 64 * 1024;

export async function readPrivateLiveDiscordPlaybackLinkProof(
  path: string,
): Promise<LiveDiscordPlaybackLinkProof> {
  const pathStatus = await lstat(path);
  assertSafeProofFile(pathStatus);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const beforeRead = await handle.stat();
    assertSafeProofFile(beforeRead);
    if (beforeRead.dev !== pathStatus.dev || beforeRead.ino !== pathStatus.ino) {
      throw new Error("Live Discord playback link proof changed before read");
    }
    if (beforeRead.size > maximumProofBytes) {
      throw new Error("Live Discord playback link proof exceeds 64 KiB");
    }
    const bytes = new Uint8Array(beforeRead.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    const afterRead = await handle.stat();
    if (
      afterRead.dev !== beforeRead.dev || afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size || afterRead.mtimeMs !== beforeRead.mtimeMs ||
      bytesRead !== beforeRead.size
    ) {
      throw new Error("Live Discord playback link proof changed while reading");
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
    return liveDiscordPlaybackLinkProofSchema.parse(JSON.parse(decoded) as unknown);
  } finally {
    await handle.close();
  }
}

export function serviceLevelSourcesFromLiveProof(
  proof: LiveDiscordPlaybackLinkProof,
  serviceLevels: E2eServiceLevelsV1,
  expected: { readonly playbackOrigin: string; readonly recordingId: string; readonly runId: string },
): ServiceLevelSourcesV1 {
  if (proof.recordingId !== expected.recordingId || proof.runId !== expected.runId) {
    throw new Error("Live Discord playback link proof does not match the requested run and recording");
  }
  if (proof.link.origin !== expected.playbackOrigin) {
    throw new Error("Live Discord playback link proof does not match the configured playback origin");
  }
  const measurement = serviceLevels.measurements.find(
    ({ serviceLevelId }) => serviceLevelId === "recording-end-to-discord-first-seen",
  );
  if (measurement?.serviceLevelId !== "recording-end-to-discord-first-seen") {
    throw new Error("Recording publication service-level measurement is missing");
  }
  const container = proof.container.kind === "channel-message"
    ? proof.container
    : {
        kind: "thread" as const,
        parentChannelId: proof.container.parentId,
        threadId: proof.container.id,
      };
  const discordPlaybackLinkProof = {
    capabilitySha256: proof.link.capabilitySha256,
    container,
    firstSeenPollCompletedAt: proof.firstSeenPollCompletedAt,
    firstSeenPollStartedAt: proof.firstSeenPollStartedAt,
    messageId: proof.messageId,
    origin: proof.link.origin,
    pathname: proof.link.pathname,
    projectionMarker: proof.projectionMarker,
    recordingId: proof.recordingId,
    resultChannelId: proof.resultChannelId,
    runId: proof.runId,
    schemaVersion: 1 as const,
  };
  if (JSON.stringify(discordPlaybackLinkProof) !== JSON.stringify({
    capabilitySha256: measurement.end.source.capabilitySha256,
    container: measurement.end.source.container,
    firstSeenPollCompletedAt: measurement.end.source.firstSeenPollCompletedAt,
    firstSeenPollStartedAt: measurement.end.source.firstSeenPollStartedAt,
    messageId: measurement.end.source.messageId,
    origin: measurement.end.source.origin,
    pathname: measurement.end.source.pathname,
    projectionMarker: measurement.end.source.projectionMarker,
    recordingId: measurement.end.source.recordingId,
    resultChannelId: measurement.end.source.resultChannelId,
    runId: measurement.end.source.runId,
    schemaVersion: 1,
  })) {
    throw new Error("Service-level measurement does not match the exact Live Discord observer proof");
  }
  if (measurement.end.atEpochMs !== proof.firstSeenPollCompletedAt.epochMilliseconds) {
    throw new Error("Service-level measurement end timestamp does not match the exact Live Discord observer proof");
  }
  return { discordPlaybackLinkProof, participantLifecycleReceipts: [], schemaVersion: 1 };
}

function assertSafeProofFile(status: {
  readonly mode: number;
  readonly uid: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): void {
  if (status.isSymbolicLink() || !status.isFile() || (status.mode & 0o777) !== 0o600) {
    throw new Error("Live Discord playback link proof must be a regular owned mode-0600 file");
  }
  if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
    throw new Error("Live Discord playback link proof must be owned by the current user");
  }
}
