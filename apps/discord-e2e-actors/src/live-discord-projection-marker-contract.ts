import { createHash } from "node:crypto";

const liveProjectionKeyVersion = "meeting-discord-projection:v2";
const finalProjectionKeyVersion = "meeting-discord-final-summary:v1";
const projectionMarkerPrefix = "meeting-projection:";

/**
 * Consumer-owned representation of the projection identities observed by the
 * hosted Discord E2E boundary. A compatibility test pins these values to the
 * publishing adapter's public contract without importing that adapter at
 * runtime.
 */
export function createObservedMeetingProjectionMarkers(
  meetingId: string,
  targetChannelId: string,
): readonly [live: string, final: string] {
  return [
    markerFor(projectionKey(liveProjectionKeyVersion, meetingId, targetChannelId)),
    markerFor(projectionKey(finalProjectionKeyVersion, meetingId, targetChannelId)),
  ];
}

function projectionKey(version: string, meetingId: string, targetChannelId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([version, meetingId, targetChannelId]), "utf8")
    .digest("hex");
  return `${version}:${digest}`;
}

function markerFor(projectionKeyValue: string): string {
  const digest = createHash("sha256")
    .update(projectionKeyValue, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `${projectionMarkerPrefix}${digest}`;
}
