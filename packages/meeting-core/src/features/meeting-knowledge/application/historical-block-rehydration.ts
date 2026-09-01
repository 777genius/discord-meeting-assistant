import { canonicalHistoricalTurn } from "./canonical-historical-turn.js";
import {
  HistoricalIndexPlanError,
  resolveHistoricalEvidenceBlockPolicy,
  type HistoricalEvidenceBlockPolicyV1,
} from "./historical-index-plan-types.js";
import {
  HISTORICAL_EVIDENCE_POLICY_VERSION,
  type AcceptedFinalMeetingV1,
  type HistoricalReleaseBindingV1,
} from "../domain/historical-evidence.js";
import type {
  HistoricalIndexPlanV1,
  HistoricalOpaqueIdPort,
  HistoricalTopologyV1,
  LocallyRehydratedEvidenceBlockV1,
} from "./ports/historical-memory.js";
import { HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION } from
  "./ports/historical-memory.js";
import {
  buildHistoricalTurnSources,
  canonicalHistoricalTurnSources,
  historicalEmbeddingText,
  rehydrateHistoricalProjectionTurns,
  type HistoricalTurnProjection,
} from "./historical-embedding-windows.js";

export function rehydrateHistoricalBlockFromPersistedPlan(
  meeting: AcceptedFinalMeetingV1,
  plan: HistoricalIndexPlanV1,
  ordinal: number,
  ids: HistoricalOpaqueIdPort,
  candidatePolicy: HistoricalEvidenceBlockPolicyV1,
): LocallyRehydratedEvidenceBlockV1 {
  const expected = plan.documents[ordinal];
  if (expected === undefined) {
    throw staleHistoricalCandidate();
  }
  const turns = rehydrateHistoricalProjectionTurns(
    meeting,
    expected.embeddingText,
    expected.manifest.turnSources,
  );
  if (turns === null) {
    throw staleHistoricalCandidate();
  }
  const projections = historicalProjections(meeting, expected.manifest.turnSources);
  const policy = resolveHistoricalEvidenceBlockPolicy(candidatePolicy);
  const topology = buildPersistedHistoricalTopology(
    meeting.binding,
    ids,
    Object.freeze({
      ...policy,
      maximumEmbeddingTokens: expected.manifest.embeddingTokenLimit,
      turnOverlap: plan.effectiveTurnOverlap,
    }),
    expected.manifest.embeddingTokenProfile,
  );
  const sources = buildHistoricalTurnSources(projections, (turnId) => opaque(
    "turn1",
    ids.keyedId("historical-turn", [
      meeting.binding.scopeId,
      meeting.binding.roomId,
      meeting.binding.meetingId,
      meeting.binding.transcriptId,
      String(meeting.binding.transcriptVersion),
      turnId,
    ]),
  ));
  const embeddingText = historicalEmbeddingText(projections);
  const remoteText = projections.map((projection) =>
    canonicalHistoricalTurn(ids, meeting.binding, projection)
  ).join("\n\n");
  const contentHash = opaque("mkcontent1", ids.keyedId(
    "historical-block-content",
    [embeddingText, remoteText, canonicalHistoricalTurnSources(sources)],
  ));
  const candidateLocator = opaque("mkcandidate1", ids.keyedId(
    "historical-candidate",
    [topology.indexGeneration, String(ordinal), contentHash],
  ));
  const documentExternalId = opaque(
    "mkdocument1",
    ids.keyedId("historical-document", [candidateLocator]),
  );
  const planDigest = opaque("mkplan1", ids.keyedId("historical-index-plan", [
    topology.indexGeneration,
    `turnOverlap=${plan.effectiveTurnOverlap}`,
    ...plan.documents.map(({ manifest }) => [
      manifest.candidateLocator,
      manifest.contentHash,
      manifest.turnIds.join(","),
    ].join("|")),
  ]));
  const allowedOverlaps = [...new Set([policy.turnOverlap, 1, 0])]
    .filter((overlap) => overlap <= policy.turnOverlap);

  if (!historicalPlanEnvelopeMatches({
    allowedOverlaps,
    embeddingTokenLimit: expected.manifest.embeddingTokenLimit,
    ids,
    meeting,
    plan,
    planDigest,
    policyMaximumTokens: policy.maximumEmbeddingTokens,
    topology,
  }) || !historicalDocumentMatches({
    candidateLocator,
    contentHash,
    documentExternalId,
    embeddingText,
    ids,
    ordinal,
    plan,
    projections,
    remoteText,
    sources,
    topology,
  })) {
    throw staleHistoricalCandidate();
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

function historicalProjections(
  meeting: AcceptedFinalMeetingV1,
  sources: HistoricalIndexPlanV1["documents"][number]["manifest"]["turnSources"],
): readonly HistoricalTurnProjection[] {
  const turnsById = new Map(meeting.humanTurns.map((turn) => [turn.turnId, turn]));
  return Object.freeze(sources.map((source) => {
    const turn = turnsById.get(source.turnId);
    if (turn === undefined) {
      throw staleHistoricalCandidate();
    }
    return Object.freeze({
      sourceEndCodePoint: source.sourceEndCodePoint,
      sourceStartCodePoint: source.sourceStartCodePoint,
      text: Array.from(turn.text)
        .slice(source.sourceStartCodePoint, source.sourceEndCodePoint)
        .join(""),
      turn,
    });
  }));
}

interface HistoricalPlanEnvelopeValidation {
  readonly allowedOverlaps: readonly number[];
  readonly embeddingTokenLimit: number;
  readonly ids: HistoricalOpaqueIdPort;
  readonly meeting: AcceptedFinalMeetingV1;
  readonly plan: HistoricalIndexPlanV1;
  readonly planDigest: string;
  readonly policyMaximumTokens: number;
  readonly topology: HistoricalTopologyV1;
}

function historicalPlanEnvelopeMatches(input: HistoricalPlanEnvelopeValidation): boolean {
  const { meeting, plan, topology } = input;
  return historicalBindingMatches(plan.binding, meeting.binding) &&
    historicalTopologyMatches(plan.topology, topology) &&
    input.allowedOverlaps.includes(plan.effectiveTurnOverlap) &&
    input.embeddingTokenLimit >= 1 &&
    input.embeddingTokenLimit <= input.policyMaximumTokens &&
    plan.deleteMutationId === opaque(
      "mkmutation1",
      input.ids.keyedId("historical-delete-mutation", [topology.releaseRef]),
    ) &&
    plan.indexMutationId === opaque(
      "mkmutation1",
      input.ids.keyedId("historical-release-index-mutation", [
        topology.releaseRef,
        topology.indexGeneration,
        HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
      ]),
    ) &&
    plan.planDigest === input.planDigest;
}

interface HistoricalDocumentValidation {
  readonly candidateLocator: string;
  readonly contentHash: string;
  readonly documentExternalId: string;
  readonly embeddingText: string;
  readonly ids: HistoricalOpaqueIdPort;
  readonly ordinal: number;
  readonly plan: HistoricalIndexPlanV1;
  readonly projections: readonly HistoricalTurnProjection[];
  readonly remoteText: string;
  readonly sources: HistoricalIndexPlanV1["documents"][number]["manifest"]["turnSources"];
  readonly topology: HistoricalTopologyV1;
}

function historicalDocumentMatches(input: HistoricalDocumentValidation): boolean {
  const expected = input.plan.documents[input.ordinal];
  if (expected === undefined) {
    return false;
  }
  const { manifest } = expected;
  const mutationId = opaque(
    "mkmutation1",
    input.ids.keyedId("historical-index-mutation", [input.documentExternalId]),
  );
  const title = opaque(
    "mkevidence1",
    input.ids.keyedId("historical-document-title", [input.candidateLocator]),
  );
  const manifestsShareProfile = input.plan.documents.every(({ manifest: item }) =>
    item.embeddingTokenLimit === manifest.embeddingTokenLimit &&
    item.embeddingTokenProfile === manifest.embeddingTokenProfile &&
    item.indexGeneration === input.topology.indexGeneration
  );
  return manifest.ordinal === input.ordinal &&
    manifest.startMs === (input.projections[0]?.turn.startMs ?? 0) &&
    manifest.endMs === (input.projections.at(-1)?.turn.endMs ?? 0) &&
    manifest.turnIds.join("\u0000") ===
      [...new Set(input.projections.map(({ turn }) => turn.turnId))].join("\u0000") &&
    canonicalHistoricalTurnSources(manifest.turnSources) ===
      canonicalHistoricalTurnSources(input.sources) &&
    expected.embeddingText === input.embeddingText &&
    expected.remoteText === input.remoteText &&
    manifest.contentHash === input.contentHash &&
    manifest.candidateLocator === input.candidateLocator &&
    manifest.documentExternalId === input.documentExternalId &&
    expected.mutationId === mutationId &&
    expected.title === title &&
    manifest.indexGeneration === input.topology.indexGeneration &&
    manifestsShareProfile;
}

function buildPersistedHistoricalTopology(
  binding: HistoricalReleaseBindingV1,
  ids: HistoricalOpaqueIdPort,
  policy: ReturnType<typeof resolveHistoricalEvidenceBlockPolicy>,
  tokenProfile: string,
): HistoricalTopologyV1 {
  const roomScopeExternalRef = opaque(
    "mkroom1",
    ids.keyedId("historical-room", [binding.scopeId, binding.roomId]),
  );
  const spaceSlug = opaque("mkspace1", ids.keyedId("historical-space", [binding.scopeId]));
  const threadExternalRef = opaque("mkthread1", ids.keyedId("historical-meeting", [
    binding.scopeId, binding.roomId, binding.meetingId,
  ]));
  const releaseRef = opaque("mkrelease1", ids.keyedId("historical-release", [
    binding.scopeId, binding.roomId, binding.meetingId, binding.transcriptId,
    String(binding.transcriptVersion), HISTORICAL_EVIDENCE_POLICY_VERSION,
  ]));
  return Object.freeze({
    indexGeneration: opaque("mkgen1", ids.keyedId("historical-index-generation", [
      releaseRef, String(binding.desiredGeneration), policy.version,
      String(policy.maxBlockUtf8Bytes), String(policy.maxBlocksPerMeeting),
      String(policy.maxTurnsPerBlock), String(policy.maximumEmbeddingTokens),
      String(policy.turnOverlap), tokenProfile,
      HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
    ])),
    projectionContractVersion: HISTORICAL_RETRIEVAL_PROJECTION_CONTRACT_VERSION,
    releaseRef,
    roomScopeExternalRef,
    spaceSlug,
    threadExternalRef,
  });
}

function historicalBindingMatches(
  left: HistoricalReleaseBindingV1,
  right: HistoricalReleaseBindingV1,
): boolean {
  return left.acceptedMeetingRevision === right.acceptedMeetingRevision &&
    left.desiredGeneration === right.desiredGeneration &&
    left.meetingId === right.meetingId && left.releaseId === right.releaseId &&
    left.roomId === right.roomId &&
    left.scopeId === right.scopeId && left.transcriptId === right.transcriptId &&
    left.transcriptVersion === right.transcriptVersion;
}

function historicalTopologyMatches(
  left: HistoricalTopologyV1,
  right: HistoricalTopologyV1,
): boolean {
  return left.indexGeneration === right.indexGeneration &&
    left.projectionContractVersion === right.projectionContractVersion &&
    left.releaseRef === right.releaseRef &&
    left.roomScopeExternalRef === right.roomScopeExternalRef &&
    left.spaceSlug === right.spaceSlug && left.threadExternalRef === right.threadExternalRef;
}

function opaque(prefix: string, value: string): string {
  return `${prefix}.${value}`;
}

function staleHistoricalCandidate(): HistoricalIndexPlanError {
  return new HistoricalIndexPlanError(
    "STALE_PLAN",
    "historical candidate no longer matches canonical local evidence",
  );
}
