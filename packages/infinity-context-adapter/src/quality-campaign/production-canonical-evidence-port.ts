import { rehydrateHistoricalBlock } from
  "@discord-meeting/meeting-core/meeting-knowledge";
import { canonicalFinalReplyTurnHash } from "@discord-meeting/postgres-adapter";
import { createHash } from "node:crypto";

import { custodyDigest, custodyJson } from "./canonical-execution-artifact-validation.js";
import type { QualificationCanonicalTurn, QualificationQuestionEvidencePort,
  QualificationQuestionExecutionContext } from "./execute-admitted-qualification-question.js";
import type { CanonicalEngineInput, CanonicalQuestionState } from
  "./production-canonical-question-chain.js";

export function createCanonicalEvidencePort(input: CanonicalEngineInput,
  state: CanonicalQuestionState): QualificationQuestionEvidencePort {
  return Object.freeze({ rehydrate: async (
    request: Parameters<QualificationQuestionEvidencePort["rehydrate"]>[0],
    options: QualificationQuestionExecutionContext,
  ) => {
    const execution = state.get(options.attemptId);
    assertExecutionRequest(execution, request);
    if (input.diagnostic !== true && execution.request.schemaVersion === 3 &&
      execution.request.filters.sourceGenerations.length !== 1) {
      throw new Error("canonical scalar answer requires the multi-source evidence companion");
    }
    const records = await input.store.findCurrentCandidates(execution.topology.scopeId,
      execution.topology.roomId, request.locatorIds, { signal: options.signal });
    if (records.length !== request.locatorIds.length) {
      throw new Error("PostgreSQL locator authority is missing or ambiguous");
    }
    const turns: QualificationCanonicalTurn[] = [];
    let binding = null;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      await assertAdmissibleRecord(input, execution, record, options);
      const meeting = await input.evidenceAuthority.loadAcceptedFinalMeeting(record.binding,
        { signal: options.signal });
      if (meeting === null) {
        throw new Error("PostgreSQL locator does not reference an accepted final meeting");
      }
      const block = rehydrateHistoricalBlock(meeting, record.plan, record.ordinal, input.ids);
      if (block.candidateLocator !== request.locatorIds[index]) {
        throw new Error("PostgreSQL locator order or ownership is ambiguous");
      }
      appendCanonicalTurns(turns, block, input.diagnostic === true);
      const nextBinding = Object.freeze({ canonicalEvidenceHash: sha256Json(
        turns.map(({ turnHash }) => turnHash)), memoryGeneration: block.indexGeneration,
      transcriptVersion: block.binding.transcriptVersion });
      if (binding !== null && binding.memoryGeneration !== nextBinding.memoryGeneration) {
        throw new Error("PostgreSQL selected locators span ambiguous generations");
      }
      binding = nextBinding;
    }
    const resolved = binding ?? Object.freeze({ canonicalEvidenceHash: sha256Json([]),
      memoryGeneration: "qualification-empty:v1", transcriptVersion: 0 });
    state.set(options.attemptId, { ...execution, binding: resolved, turns: Object.freeze(turns) });
    await input.audit.seal({ attemptId: options.attemptId,
      kind: "selected_canonical_turns", plaintext: utf8Json(turns) });
    return Object.freeze({ authorityGeneration: resolved.memoryGeneration,
      canonicalEvidenceHash: resolved.canonicalEvidenceHash,
      transcriptVersion: resolved.transcriptVersion, turns: Object.freeze(turns) });
  } });
}

type Execution = NonNullable<ReturnType<CanonicalQuestionState["get"]>>;
type EvidenceRequest = Parameters<QualificationQuestionEvidencePort["rehydrate"]>[0];
type CandidateRecord = Awaited<ReturnType<CanonicalEngineInput["store"]["findCurrentCandidates"]>>[number];
type HistoricalBlock = ReturnType<typeof rehydrateHistoricalBlock>;

function assertExecutionRequest(execution: Execution | undefined,
  request: EvidenceRequest): asserts execution is Execution {
  if (execution === undefined || execution.binding !== null ||
    execution.packet.questionId !== request.questionId ||
    custodyJson(request.locatorIds) !== custodyJson(execution.candidateLocators) ||
    execution.packet.scopeTopologyReference !== request.scopeTopologyReference ||
    new Set(request.locatorIds).size !== request.locatorIds.length) {
    throw new Error("canonical qualification retrieval state is absent or duplicated");
  }
}

async function assertAdmissibleRecord(input: CanonicalEngineInput, execution: Execution,
  record: CandidateRecord, options: QualificationQuestionExecutionContext): Promise<void> {
  if (!await input.store.isCurrentGeneration(record.binding,
    record.plan.topology.indexGeneration, { signal: options.signal }) ||
    record.binding.scopeId !== execution.topology.scopeId ||
    record.binding.roomId !== execution.topology.roomId) {
    throw new Error("PostgreSQL locator is stale or cross-room");
  }
  if (!execution.request.filters.sourceGenerations.some(pair =>
    pair.sourceKey === record.plan.topology.releaseRef &&
    pair.projectionGeneration === record.plan.topology.indexGeneration) ||
    execution.retrievalBinding?.diagnosticPlanSha256 !== undefined &&
    execution.retrievalBinding.diagnosticPlanSha256 !== null &&
    custodyDigest({ plan: record.plan, remoteDocumentIds: record.remoteDocumentIds }) !==
      execution.retrievalBinding.diagnosticPlanSha256) {
    throw new Error("canonical evidence is outside the frozen request or diagnostic plan");
  }
}

function appendCanonicalTurns(turns: QualificationCanonicalTurn[], block: HistoricalBlock,
  diagnostic: boolean): void {
  for (const turn of block.turns) {
    const canonical = Object.freeze({ endMs: turn.endMs,
      sourceLocatorId: block.candidateLocator, speakerId: turn.speakerId,
      startMs: turn.startMs, text: turn.text, turnHash: canonicalFinalReplyTurnHash(turn),
      turnId: turn.turnId });
    const previous = diagnostic ? turns.find(value => value.turnId === canonical.turnId) : undefined;
    if (previous !== undefined) {
      if (previous.turnHash !== canonical.turnHash) {
        throw new Error("diagnostic selected incompatible slices of one canonical turn");
      }
    } else {
      turns.push(canonical);
    }
  }
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function utf8Json(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
