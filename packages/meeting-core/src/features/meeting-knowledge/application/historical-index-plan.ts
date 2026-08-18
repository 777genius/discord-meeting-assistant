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
import {
  buildHistoricalTurnSources,
  canonicalHistoricalTurnSources,
  estimateHistoricalEmbeddingTokens,
  historicalEmbeddingText,
  partitionHistoricalEmbeddingWindows,
  rehydrateHistoricalProjectionTurns,
  type HistoricalTurnProjection,
} from "./historical-embedding-windows.js";

export interface HistoricalEvidenceBlockPolicyV1 {
  /** Conservative retrieval projection budget; provider input must be at least this large. */
  readonly maximumEmbeddingTokens?: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap?: number;
  readonly version: "meeting-knowledge.block-policy.v1";
}

type HistoricalEvidenceBlockPolicyInputV1 = Omit<
  HistoricalEvidenceBlockPolicyV1,
  "version"
> & { readonly version: string };

export const DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY: HistoricalEvidenceBlockPolicyV1 =
  Object.freeze({
    maximumEmbeddingTokens: 96,
    maxBlockUtf8Bytes: 4_096,
    maxBlocksPerMeeting: 500,
    maxTurnsPerBlock: 64,
    turnOverlap: 2,
    version: "meeting-knowledge.block-policy.v1",
  });

interface ResolvedHistoricalEvidenceBlockPolicyV1 {
  readonly maximumEmbeddingTokens: number;
  readonly maxBlockUtf8Bytes: number;
  readonly maxBlocksPerMeeting: number;
  readonly maxTurnsPerBlock: number;
  readonly turnOverlap: number;
  readonly version: "meeting-knowledge.block-policy.v1";
}

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
        String(policy.maximumEmbeddingTokens),
        String(policy.turnOverlap),
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
): ResolvedHistoricalEvidenceBlockPolicyV1 {
  const maximumEmbeddingTokens = policy.maximumEmbeddingTokens ?? 96;
  const turnOverlap = policy.turnOverlap ?? 2;
  if (
    policy.version !== "meeting-knowledge.block-policy.v1" ||
    !Number.isSafeInteger(policy.maxBlockUtf8Bytes) ||
    policy.maxBlockUtf8Bytes < 256 ||
    policy.maxBlockUtf8Bytes > 32_768 ||
    !Number.isSafeInteger(policy.maxBlocksPerMeeting) ||
    policy.maxBlocksPerMeeting < 1 ||
    policy.maxBlocksPerMeeting > 500 ||
    !Number.isSafeInteger(policy.maxTurnsPerBlock) ||
    policy.maxTurnsPerBlock < 1 ||
    policy.maxTurnsPerBlock > 64 ||
    !Number.isSafeInteger(maximumEmbeddingTokens) ||
    maximumEmbeddingTokens < 16 ||
    maximumEmbeddingTokens > 512 ||
    !Number.isSafeInteger(turnOverlap) ||
    turnOverlap < 0 ||
    turnOverlap > 8 ||
    turnOverlap >= policy.maxTurnsPerBlock
  ) {
    throw new HistoricalIndexPlanError(
      "INVALID_POLICY",
      "historical evidence block policy is outside its qualified bounds",
    );
  }
  return Object.freeze({
    ...policy,
    maximumEmbeddingTokens,
    turnOverlap,
    version: "meeting-knowledge.block-policy.v1",
  });
}

function opaque(prefix: string, value: string): string {
  return `${prefix}.${value}`;
}

function canonicalTurn(
  ids: HistoricalOpaqueIdPort,
  binding: HistoricalReleaseBindingV1,
  projection: HistoricalTurnProjection,
): string {
  const { turn } = projection;
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
    `source_code_points=${projection.sourceStartCodePoint}:${projection.sourceEndCodePoint}`,
    "text:",
    projection.text,
  ].join("\n");
}

export function buildHistoricalIndexPlan(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1 =
    DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
): HistoricalIndexPlanV1 {
  const policy = assertPolicy(candidatePolicy);
  const { binding } = meeting;
  let partitionResult: ReturnType<typeof partitionHistoricalEmbeddingWindows>;
  try {
    partitionResult = partitionHistoricalEmbeddingWindows(meeting, policy);
  } catch (error) {
    throw new HistoricalIndexPlanError(
      "BLOCK_LIMIT_EXCEEDED",
      error instanceof Error ? error.message : "historical projection failed",
    );
  }
  const effectivePolicy = Object.freeze({
    ...policy,
    turnOverlap: partitionResult.effectiveTurnOverlap,
  });
  const topology = buildHistoricalTopology(binding, ids, effectivePolicy);
  const { indexGeneration, releaseRef } = topology;
  const documents: HistoricalIndexDocumentV1[] = partitionResult.windows.map(
    (projections, ordinal) => {
    const remoteText = projections
      .map((projection) => canonicalTurn(ids, binding, projection))
      .join("\n\n");
    const cleanEmbeddingText = historicalEmbeddingText(projections);
    const turnSources = buildHistoricalTurnSources(projections, (turnId) => opaque(
      "turn1",
      ids.keyedId("historical-turn", [
        binding.scopeId,
        binding.roomId,
        binding.meetingId,
        binding.transcriptId,
        String(binding.transcriptVersion),
        turnId,
      ]),
    ));
    const contentHash = opaque(
      "mkcontent1",
      ids.keyedId("historical-block-content", [
        cleanEmbeddingText,
        remoteText,
        canonicalHistoricalTurnSources(turnSources),
      ]),
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
      embeddingTokenEstimate: estimateHistoricalEmbeddingTokens(cleanEmbeddingText),
      embeddingTokenLimit: policy.maximumEmbeddingTokens,
      embeddingTokenProfile: "meeting-knowledge.wordpiece-conservative.v1",
      endMs: projections.at(-1)?.turn.endMs ?? 0,
      indexGeneration,
      ordinal,
      startMs: projections[0]?.turn.startMs ?? 0,
      turnIds: Object.freeze([
        ...new Set(projections.map(({ turn }) => turn.turnId)),
      ]),
      turnSources,
    });
    return Object.freeze({
      embeddingText: cleanEmbeddingText,
      manifest,
      mutationId,
      remoteText,
      title: opaque(
        "mkevidence1",
        ids.keyedId("historical-document-title", [candidateLocator]),
      ),
    });
    },
  );
  const planDigest = opaque(
    "mkplan1",
    ids.keyedId("historical-index-plan", [
      indexGeneration,
      `turnOverlap=${partitionResult.effectiveTurnOverlap}`,
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
    effectiveTurnOverlap: partitionResult.effectiveTurnOverlap,
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
    actual.embeddingText !== expected.embeddingText ||
    !sameTurnSources(actual.manifest.turnSources, expected.manifest.turnSources) ||
    current.topology.indexGeneration !== plan.topology.indexGeneration
  ) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical candidate no longer matches canonical local evidence",
    );
  }
  const turns = rehydrateHistoricalProjectionTurns(
    meeting,
    expected.embeddingText,
    expected.manifest.turnSources,
  );
  if (turns === null) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical source range no longer matches canonical local evidence",
    );
  }
  return Object.freeze({
    binding: meeting.binding,
    candidateLocator: expected.manifest.candidateLocator,
    contentHash: expected.manifest.contentHash,
    indexGeneration: expected.manifest.indexGeneration,
    ordinal,
    turns: Object.freeze(turns),
  });
}

function sameTurnSources(
  left: HistoricalBlockManifestV1["turnSources"],
  right: HistoricalBlockManifestV1["turnSources"],
): boolean {
  return left.length === right.length && left.every((source, index) => {
    const expected = right[index];
    return expected !== undefined &&
      source.embeddingStartCodePoint === expected.embeddingStartCodePoint &&
      source.embeddingEndCodePoint === expected.embeddingEndCodePoint &&
      source.sourceStartCodePoint === expected.sourceStartCodePoint &&
      source.sourceEndCodePoint === expected.sourceEndCodePoint &&
      source.sourceRef === expected.sourceRef &&
      source.turnId === expected.turnId &&
      source.speakerId === expected.speakerId &&
      source.startMs === expected.startMs &&
      source.endMs === expected.endMs;
  });
}
