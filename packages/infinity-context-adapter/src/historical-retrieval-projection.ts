import type {
  HistoricalIndexDocumentV1,
  HistoricalTopologyV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";
import {
  DOCUMENT_RETRIEVAL_PROJECTION_SCHEMA_V1,
  documentRetrievalProjectionV1Payload,
  type DocumentRetrievalProjectionV1Input,
} from "@infinity-context/sdk-v2";

const HISTORICAL_RETRIEVAL_CATEGORY = "meeting_evidence";

export interface HistoricalRetrievalActorKeyMapper {
  activeActorKey(actorId: string): string;
}

export function historicalRetrievalProjection(
  topology: HistoricalTopologyV1,
  document: HistoricalIndexDocumentV1,
  actorKeys: HistoricalRetrievalActorKeyMapper,
): DocumentRetrievalProjectionV1Input {
  return Object.freeze({
    actorKeys: Object.freeze([
      ...new Set(document.manifest.turnSources.map(({ speakerId }) =>
        actorKeys.activeActorKey(speakerId)
      )),
    ].toSorted(compareUtf8)),
    category: HISTORICAL_RETRIEVAL_CATEGORY,
    kind: "record_block",
    locator: document.manifest.candidateLocator,
    projectionGeneration: topology.indexGeneration,
    relativeTimeInterval: Object.freeze({
      endMs: document.manifest.endMs,
      startMs: document.manifest.startMs,
    }),
    schemaVersion: DOCUMENT_RETRIEVAL_PROJECTION_SCHEMA_V1,
    sequenceOrdinal: document.manifest.ordinal,
    sourceKey: topology.releaseRef,
    tags: Object.freeze([]),
    timeInterval: null,
  });
}

export function validHistoricalRetrievalProjection(
  topology: HistoricalTopologyV1,
  document: HistoricalIndexDocumentV1,
  actorKeys: HistoricalRetrievalActorKeyMapper,
): boolean {
  try {
    documentRetrievalProjectionV1Payload(
      historicalRetrievalProjection(topology, document, actorKeys),
    );
    return true;
  } catch {
    return false;
  }
}

function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) {
      return difference;
    }
  }
  return leftBytes.length - rightBytes.length;
}
