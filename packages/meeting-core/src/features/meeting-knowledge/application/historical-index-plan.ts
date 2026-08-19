import { canonicalHistoricalTurn } from "./canonical-historical-turn.js";
import {
  HistoricalIndexPlanError,
  resolveHistoricalEvidenceBlockPolicy,
  type HistoricalEvidenceBlockPolicyV1,
  type ResolvedHistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan-types.js";
export {
  HistoricalIndexPlanError,
  resolveHistoricalEvidenceBlockPolicy,
  type HistoricalEvidenceBlockPolicyV1,
  type ResolvedHistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan-types.js";
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
  historicalEmbeddingTokenProfile,
  type HistoricalEmbeddingTokenizerPort,
} from "./ports/historical-embedding-tokenizer.js";
import type {
  HistoricalIndexPlannerResultV1,
  HistoricalReceiptDigestPort,
} from "./ports/historical-index-planner.js";
import {
  validatePreparedEnvelope,
  validatePreparedWindows,
} from "./prepared-historical-index-validation.js";
import { rehydrateHistoricalBlockFromPersistedPlan } from
  "./historical-block-rehydration.js";
export { canonicalHistoricalPlannerJson } from
  "./prepared-historical-index-validation.js";
import {
  buildHistoricalTurnSources,
  canonicalHistoricalTurnSources,
  estimateHistoricalEmbeddingTokens,
  historicalEmbeddingText,
  historicalPlanProjectionMatches,
  partitionHistoricalEmbeddingWindows,
  type HistoricalTurnProjection,
} from "./historical-embedding-windows.js";

export const DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY: HistoricalEvidenceBlockPolicyV1 =
  Object.freeze({
    maximumEmbeddingTokens: 96,
    maxBlockUtf8Bytes: 4_096,
    maxBlocksPerMeeting: 500,
    maxTurnsPerBlock: 64,
    turnOverlap: 2,
    version: "meeting-knowledge.block-policy.v1",
  });

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
  tokenizer?: HistoricalEmbeddingTokenizerPort,
): HistoricalTopologyV1 {
  return buildHistoricalTopologyForProfile(
    binding,
    ids,
    candidatePolicy,
    historicalEmbeddingTokenProfile(tokenizer),
  );
}

function buildHistoricalTopologyForProfile(
  binding: HistoricalReleaseBindingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1,
  tokenProfile: string,
): HistoricalTopologyV1 {
  const policy = resolveHistoricalEvidenceBlockPolicy(candidatePolicy);
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
        tokenProfile,
      ]),
    ),
    releaseRef,
    roomScopeExternalRef,
    spaceSlug,
    threadExternalRef,
  });
}

function opaque(prefix: string, value: string): string {
  return `${prefix}.${value}`;
}

export function buildHistoricalIndexPlan(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1 =
    DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
  tokenizer?: HistoricalEmbeddingTokenizerPort,
): HistoricalIndexPlanV1 {
  const candidate = resolveHistoricalEvidenceBlockPolicy(candidatePolicy);
  const policy = Object.freeze({
    ...candidate,
    maximumEmbeddingTokens: Math.min(
      candidate.maximumEmbeddingTokens,
      tokenizer?.profile.maxInputTokens ?? candidate.maximumEmbeddingTokens,
    ),
  });
  let partitionResult: ReturnType<typeof partitionHistoricalEmbeddingWindows>;
  try {
    partitionResult = partitionHistoricalEmbeddingWindows(meeting, policy, tokenizer);
  } catch (error) {
    throw blockLimitError(error);
  }
  const tokenProfile = historicalEmbeddingTokenProfile(tokenizer);
  return assembleHistoricalIndexPlan({
    ids,
    meeting,
    policy: Object.freeze({
      ...policy,
      turnOverlap: partitionResult.effectiveTurnOverlap,
    }),
    tokenCounts: partitionResult.windows.map((window) =>
      tokenizer?.countTokens(historicalEmbeddingText(window)) ??
        estimateHistoricalEmbeddingTokens(historicalEmbeddingText(window))
    ),
    tokenProfile,
    windows: partitionResult.windows,
  });
}

export function buildHistoricalIndexPlanFromPreparedWindows(
  meeting: AcceptedFinalMeetingV1,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1,
  prepared: HistoricalIndexPlannerResultV1,
  receiptDigest: HistoricalReceiptDigestPort,
): HistoricalIndexPlanV1 {
  const candidate = resolveHistoricalEvidenceBlockPolicy(candidatePolicy);
  validatePreparedEnvelope(meeting, candidatePolicy, prepared, receiptDigest);
  const policy = Object.freeze({
    ...candidate,
    maximumEmbeddingTokens: Math.min(
      candidate.maximumEmbeddingTokens,
      prepared.planningProfile.maximumInputTokens,
    ),
  });
  const projections = validatePreparedWindows(meeting, prepared, policy);
  const plan = assembleHistoricalIndexPlan({
    ids,
    meeting,
    policy: Object.freeze({
      ...policy,
      turnOverlap: prepared.effectiveTurnOverlap,
    }),
    tokenCounts: prepared.windows.map(({ tokenCount }) => tokenCount),
    tokenProfile: prepared.planningProfile.identity,
    windows: projections,
  });
  if (!historicalPlanProjectionMatches(meeting, plan, (turnId) =>
    opaque("turn1", ids.keyedId("historical-turn", [
      meeting.binding.scopeId, meeting.binding.roomId, meeting.binding.meetingId,
      meeting.binding.transcriptId, String(meeting.binding.transcriptVersion), turnId,
    ]))
  )) {
    throw new HistoricalIndexPlanError(
      "STALE_PLAN",
      "historical window result does not cover canonical evidence",
    );
  }
  return plan;
}

function blockLimitError(error: unknown): HistoricalIndexPlanError {
  return new HistoricalIndexPlanError(
    "BLOCK_LIMIT_EXCEEDED",
    error instanceof Error ? error.message : "historical projection failed",
  );
}

interface HistoricalIndexAssembly {
  readonly ids: HistoricalOpaqueIdPort;
  readonly meeting: AcceptedFinalMeetingV1;
  readonly policy: ResolvedHistoricalEvidenceBlockPolicyV1;
  readonly tokenCounts: readonly number[];
  readonly tokenProfile: string;
  readonly windows: readonly (readonly HistoricalTurnProjection[])[];
}

function assembleHistoricalIndexPlan(input: HistoricalIndexAssembly): HistoricalIndexPlanV1 {
  const { ids, meeting, policy, tokenCounts, tokenProfile, windows } = input;
  const { binding } = meeting;
  const topology = buildHistoricalTopologyForProfile(binding, ids, policy, tokenProfile);
  const { indexGeneration, releaseRef } = topology;
  const documents: HistoricalIndexDocumentV1[] = windows.map(
    (projections, ordinal) => {
      const remoteText = projections.map((projection) =>
        canonicalHistoricalTurn(ids, binding, projection)
      ).join("\n\n");
      const cleanEmbeddingText = historicalEmbeddingText(projections);
      const turnSources = buildHistoricalTurnSources(projections, (turnId) => opaque(
        "turn1", ids.keyedId("historical-turn", [
          binding.scopeId, binding.roomId, binding.meetingId, binding.transcriptId,
          String(binding.transcriptVersion), turnId,
        ]),
      ));
      const contentHash = opaque("mkcontent1", ids.keyedId(
        "historical-block-content",
        [cleanEmbeddingText, remoteText, canonicalHistoricalTurnSources(turnSources)],
      ));
      const candidateLocator = opaque("mkcandidate1", ids.keyedId(
        "historical-candidate", [indexGeneration, String(ordinal), contentHash],
      ));
      const documentExternalId = opaque(
        "mkdocument1", ids.keyedId("historical-document", [candidateLocator]),
      );
      const mutationId = opaque(
        "mkmutation1", ids.keyedId("historical-index-mutation", [documentExternalId]),
      );
      const manifest: HistoricalBlockManifestV1 = Object.freeze({
        candidateLocator,
        contentHash,
        documentExternalId,
        embeddingTokenEstimate: tokenCounts[ordinal] ?? 0,
        embeddingTokenLimit: policy.maximumEmbeddingTokens,
        embeddingTokenProfile: tokenProfile,
        endMs: projections.at(-1)?.turn.endMs ?? 0,
        indexGeneration,
        ordinal,
        startMs: projections[0]?.turn.startMs ?? 0,
        turnIds: Object.freeze([...new Set(projections.map(({ turn }) => turn.turnId))]),
        turnSources,
      });
      return Object.freeze({
        embeddingText: cleanEmbeddingText,
        manifest,
        mutationId,
        remoteText,
        title: opaque(
          "mkevidence1", ids.keyedId("historical-document-title", [candidateLocator]),
        ),
      });
    },
  );
  const planDigest = opaque("mkplan1", ids.keyedId("historical-index-plan", [
    indexGeneration,
    `turnOverlap=${policy.turnOverlap}`,
    ...documents.map(({ manifest }) => [
      manifest.candidateLocator, manifest.contentHash, manifest.turnIds.join(","),
    ].join("|")),
  ]));
  return Object.freeze({
    binding,
    deleteMutationId: opaque(
      "mkmutation1", ids.keyedId("historical-delete-mutation", [releaseRef]),
    ),
    documents: Object.freeze(documents),
    effectiveTurnOverlap: policy.turnOverlap,
    indexMutationId: opaque(
      "mkmutation1", ids.keyedId("historical-release-index-mutation", [releaseRef]),
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
  policyOrOptions: HistoricalEvidenceBlockPolicyV1 | {
    readonly policy: HistoricalEvidenceBlockPolicyV1;
    readonly tokenizer: HistoricalEmbeddingTokenizerPort | undefined;
  } = DEFAULT_HISTORICAL_EVIDENCE_BLOCK_POLICY,
): LocallyRehydratedEvidenceBlockV1 {
  const candidatePolicy = "policy" in policyOrOptions
    ? policyOrOptions.policy
    : policyOrOptions;
  return rehydrateHistoricalBlockFromPersistedPlan(
    meeting,
    plan,
    ordinal,
    ids,
    candidatePolicy,
  );
}
