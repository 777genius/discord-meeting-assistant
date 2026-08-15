import {
  HISTORICAL_EVIDENCE_POLICY_VERSION,
  type AcceptedFinalMeetingV1,
  type HistoricalReleaseBindingV1,
} from "../domain/historical-evidence.js";
import type {
  HistoricalBlockManifestV1,
  HistoricalIndexDocumentV1,
  HistoricalIndexPlanV1,
  HistoricalOpaqueIdPort,
  HistoricalTopologyV1,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";

export interface HistoricalEvidenceBlockPolicyV1 {
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly version: "meeting-knowledge.block-policy.v1";
}

type HistoricalEvidenceBlockPolicyInputV1 = Omit<
  HistoricalEvidenceBlockPolicyV1,
  "version"
> & { readonly version: string };

export const DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY: HistoricalEvidenceBlockPolicyV1 =
  Object.freeze({
    maxBlockUtf8Bytes: 4_096,
    maxBlocksPerMeeting: 100,
    maxTurnsPerBlock: 64,
    version: "meeting-knowledge.block-policy.v1",
  });

export class HistoricalIndexPlanError extends Error {
  public override readonly name = "HistoricalIndexPlanError";

  public constructor(
    public readonly code: "BLOCK_LIMIT_EXCEEDED" | "INVALID_POLICY" | "STALE_PLAN",
    message: string,
  ) {
    super(message);
  }
}

export function buildHistoricalRoomTopology(
  scopeId: string,
  roomId: string,
  ids: HistoricalOpaqueIdPort,
): Pick<HistoricalTopologyV1, "roomScopeExternalRef" | "spaceSlug"> {
  return Object.freeze({
    roomScopeExternalRef: opaque(
      "mkroom1",
      ids.keyedId("historical-room", [scopeId, roomId]),
    ),
    spaceSlug: opaque(
      "mkspace1",
      ids.keyedId("historical-space", [scopeId]),
    ),
  });
}

export function buildHistoricalTopology(
  binding: HistoricalReleaseBindingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1 =
    DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
): HistoricalTopologyV1 {
  const policy = assertPolicy(candidatePolicy);
  const { roomScopeExternalRef, spaceSlug } = buildHistoricalRoomTopology(
    binding.scopeId,
    binding.roomId,
    ids,
  );
  const threadExternalRef = opaque(
    "mkthread1",
    ids.keyedId("historical-meeting", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
    ]),
  );
  const releaseRef = opaque(
    "mkrelease1",
    ids.keyedId("historical-release", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
      binding.transcriptId,
      String(binding.transcriptVersion),
      HISTORICAL_EVIDENCE_POLICY_VERSION,
    ]),
  );
  return Object.freeze({
    indexGeneration: opaque(
      "mkgen1",
      ids.keyedId("historical-index-generation", [
        releaseRef,
        String(binding.desiredGeneration),
        policy.version,
        String(policy.maxBlockUtf8Bytes),
        String(policy.maxBlocksPerMeeting),
        String(policy.maxTurnsPerBlock),
      ]),
    ),
    releaseRef,
    roomScopeExternalRef,
    spaceSlug,
    threadExternalRef,
  });
}

function assertPolicy(
  policy: HistoricalEvidenceBlockPolicyInputV1,
): HistoricalEvidenceBlockPolicyV1 {
  if (
    policy.version !== "meeting-knowledge.block-policy.v1" ||
    !Number.isSafeInteger(policy.maxBlockUtf8Bytes) ||
    policy.maxBlockUtf8Bytes < 256 ||
    policy.maxBlockUtf8Bytes > 32_768 ||
    !Number.isSafeInteger(policy.maxBlocksPerMeeting) ||
    policy.maxBlocksPerMeeting < 1 ||
    policy.maxBlocksPerMeeting > 2_048 ||
    !Number.isSafeInteger(policy.maxTurnsPerBlock) ||
    policy.maxTurnsPerBlock < 1 ||
    policy.maxTurnsPerBlock > 64
  ) {
    throw new HistoricalIndexPlanError(
      "INVALID_POLICY",
      "historical evidence block policy is outside its qualified bounds",
    );
  }
  return Object.freeze({ ...policy, version: "meeting-knowledge.block-policy.v1" });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function opaque(prefix: string, value: string): string {
  return `${prefix}.${value}`;
}

function canonicalTurn(
  ids: HistoricalOpaqueIdPort,
  binding: HistoricalReleaseBindingV1,
  turn: AcceptedFinalMeetingV1["humanTurns"][number],
): string {
  const turnRef = opaque(
    "turn1",
    ids.keyedId("historical-turn", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
      binding.transcriptId,
      String(binding.transcriptVersion),
      turn.turnId,
    ]),
  );
  const speakerRef = opaque(
    "actor1",
    ids.keyedId("historical-actor", [
      binding.scopeId,
      binding.roomId,
      binding.meetingId,
      turn.speakerId,
    ]),
  );
  return [
    `turn=${turnRef}`,
    `speaker=${speakerRef}`,
    `start_ms=${turn.startMs}`,
    `end_ms=${turn.endMs}`,
    "text:",
    turn.text,
  ].join("\n");
}

function partitionTurns(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  policy: HistoricalEvidenceBlockPolicyV1,
): readonly (readonly AcceptedFinalMeetingV1["humanTurns"][number][])[] {
  const partitions: Array<AcceptedFinalMeetingV1["humanTurns"][number][]> = [];
  let current: AcceptedFinalMeetingV1["humanTurns"][number][] = [];
  let currentBytes = 0;

  for (const turn of meeting.humanTurns) {
    const serialized = canonicalTurn(ids, meeting.binding, turn);
    const serializedBytes = byteLength(serialized) + (current.length === 0 ? 0 : 2);
    if (serializedBytes > policy.maxBlockUtf8Bytes) {
      throw new HistoricalIndexPlanError(
        "BLOCK_LIMIT_EXCEEDED",
        `authoritative turn ${turn.turnId} exceeds the evidence block byte bound`,
      );
    }
    if (
      current.length > 0 &&
      (currentBytes + serializedBytes > policy.maxBlockUtf8Bytes ||
        current.length >= policy.maxTurnsPerBlock)
    ) {
      partitions.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(turn);
    currentBytes += serializedBytes;
  }
  if (current.length > 0) {
    partitions.push(current);
  }
  if (partitions.length > policy.maxBlocksPerMeeting) {
    throw new HistoricalIndexPlanError(
      "BLOCK_LIMIT_EXCEEDED",
      "accepted meeting requires more evidence blocks than the qualified policy permits",
    );
  }
  return Object.freeze(partitions.map((partition) => Object.freeze(partition)));
}

export function buildHistoricalIndexPlan(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1 =
    DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
): HistoricalIndexPlanV1 {
  const policy = assertPolicy(candidatePolicy);
  const { binding } = meeting;
  const topology = buildHistoricalTopology(binding, ids, policy);
  const { indexGeneration, releaseRef } = topology;

  const documents: HistoricalIndexDocumentV1[] = partitionTurns(
    meeting,
    ids,
    policy,
  ).map((turns, ordinal) => {
    const remoteText = turns
      .map((turn) => canonicalTurn(ids, binding, turn))
      .join("\n\n");
    const contentHash = opaque(
      "mkcontent1",
      ids.keyedId("historical-block-content", [remoteText]),
    );
    const candidateLocator = opaque(
      "mkcandidate1",
      ids.keyedId("historical-candidate", [
        indexGeneration,
        String(ordinal),
        contentHash,
      ]),
    );
    const documentExternalId = opaque(
      "mkdocument1",
      ids.keyedId("historical-document", [candidateLocator]),
    );
    const mutationId = opaque(
      "mkmutation1",
      ids.keyedId("historical-index-mutation", [documentExternalId]),
    );
    const manifest: HistoricalBlockManifestV1 = Object.freeze({
      candidateLocator,
      contentHash,
      documentExternalId,
      endMs: turns.at(-1)?.endMs ?? 0,
      indexGeneration,
      ordinal,
      startMs: turns[0]?.startMs ?? 0,
      turnIds: Object.freeze(turns.map(({ turnId }) => turnId)),
    });
    return Object.freeze({
      manifest,
      mutationId,
      remoteText,
      title: opaque(
        "mkevidence1",
        ids.keyedId("historical-document-title", [candidateLocator]),
      ),
    });
  });
  const planDigest = opaque(
    "mkplan1",
    ids.keyedId("historical-index-plan", [
      indexGeneration,
      ...documents.map(({ manifest }) =>
        [
          manifest.candidateLocator,
          manifest.contentHash,
          manifest.turnIds.join(","),
        ].join("|")
      ),
    ]),
  );
  return Object.freeze({
    binding,
    deleteMutationId: opaque(
      "mkmutation1",
      ids.keyedId("historical-delete-mutation", [releaseRef]),
    ),
    documents: Object.freeze(documents),
    indexMutationId: opaque(
      "mkmutation1",
      ids.keyedId("historical-release-index-mutation", [releaseRef]),
    ),
    planDigest,
    schemaVersion: 1,
    topology,
  });
}

export function rehydrateHistoricalBlock(
  meeting: AcceptedFinalMeetingV1,
  plan: HistoricalIndexPlanV1,
  ordinal: number,
  ids: HistoricalOpaqueIdPort,
  policy: HistoricalEvidenceBlockPolicyV1 = DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
): LocallyRehydratedEvidenceBlockV1 {
  const current = buildHistoricalIndexPlan(meeting, ids, policy);
  const expected = plan.documents[ordinal];
  const actual = current.documents[ordinal];
  if (
    expected === undefined ||
    actual === undefined ||
    current.planDigest !== plan.planDigest ||
    actual.manifest.candidateLocator !== expected.manifest.candidateLocator ||
    actual.manifest.contentHash !== expected.manifest.contentHash ||
    current.topology.indexGeneration !== plan.topology.indexGeneration
  ) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical candidate no longer matches canonical local evidence",
    );
  }
  const turnsById = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  const turns = expected.manifest.turnIds.map((turnId) => {
    const turn = turnsById.get(turnId);
    if (turn === undefined) {
      throw new HistoricalIndexPlanError(
        "STALE_PLAN",
        "historical candidate references a missing authoritative turn",
      );
    }
    return turn;
  });
  return Object.freeze({
    binding: meeting.binding,
    candidateLocator: expected.manifest.candidateLocator,
    contentHash: expected.manifest.contentHash,
    indexGeneration: expected.manifest.indexGeneration,
    ordinal,
    turns: Object.freeze(turns),
  });
}
