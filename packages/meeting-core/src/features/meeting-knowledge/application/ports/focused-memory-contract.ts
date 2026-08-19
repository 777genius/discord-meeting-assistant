import {
  MeetingKnowledgeInvariantError,
  requireKnowledgeInteger,
  requireKnowledgeText,
  requireSha256,
} from "../../domain/errors.js";
import {
  type FocusedMemoryReference,
} from "../../domain/grounding-plan.js";
import type {
  FocusedMemoryRetrievalPort,
  FocusedMemoryRetrievalResult,
  QuestionJobTerminalOutcome,
} from "./final-reply.js";

export const focusedMemoryContractVersion = 1 as const;

function focusedMemoryReferenceKey(reference: FocusedMemoryReference): string {
  return [
    reference.meetingId,
    reference.transcriptId,
    reference.transcriptVersion,
    reference.turnId,
    reference.turnHash,
    reference.sourceStartCodePoint ?? "whole",
    reference.sourceEndCodePoint ?? "whole",
  ].join("\u0000");
}

export function mergeFocusedHydrationReferences(
  references: readonly FocusedMemoryReference[],
): readonly FocusedMemoryReference[] {
  return Object.freeze([...new Map(references.map((reference) => [
    focusedMemoryReferenceKey(reference),
    reference,
  ])).values()]);
}

const terminalStatuses = new Set([
  "low_coverage",
  "pending",
  "stale",
  "unavailable",
]);

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      `${field} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      `${field} contains an unknown field`,
    );
  }
}

export function decodeFocusedMemoryRetrievalResult(
  value: unknown,
): FocusedMemoryRetrievalResult {
  const input = record(value, "focused memory result");
  if (
    requireKnowledgeInteger(input.schemaVersion as number, "schemaVersion", 1) !==
      focusedMemoryContractVersion
  ) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "focused memory result version is unsupported",
    );
  }
  const status = input.status;
  if (typeof status === "string" && terminalStatuses.has(status)) {
    assertOnlyKeys(
      input,
      new Set(["schemaVersion", "status"]),
      "focused memory result",
    );
    return Object.freeze({
      schemaVersion: focusedMemoryContractVersion,
      status: status as
        | "low_coverage"
        | "pending"
        | "stale"
        | "unavailable",
    });
  }
  if (status !== "current") {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "focused memory result status is unsupported",
    );
  }
  assertOnlyKeys(
    input,
    new Set([
      "authorityGeneration",
      "candidates",
      "schemaVersion",
      "status",
    ]),
    "focused memory result",
  );
  if (!Array.isArray(input.candidates) || input.candidates.length > 256) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "focused memory result requires at most 256 priority candidate references",
    );
  }
  if (input.candidates.length === 0) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      "focused memory result has neither priority nor complete current evidence",
    );
  }
  const candidates = decodeCandidates(input.candidates, "candidates");
  return Object.freeze({
    authorityGeneration: requireKnowledgeText(
      input.authorityGeneration as string,
      "authorityGeneration",
      512,
    ),
    candidates: Object.freeze(candidates),
    schemaVersion: focusedMemoryContractVersion,
    status: "current",
  });
}

export async function retrieveFocusedMemory(
  memory: FocusedMemoryRetrievalPort,
  input: Parameters<FocusedMemoryRetrievalPort["retrieve"]>[0],
): Promise<FocusedMemoryRetrievalResult> {
  try {
    const result = decodeFocusedMemoryRetrievalResult(await memory.retrieve(input));
    if (result.status !== "current") {
      return result;
    }
    if (
      result.candidates.length > input.maximumCandidates
    ) {
      return { schemaVersion: focusedMemoryContractVersion, status: "unavailable" };
    }
    return result;
  } catch {
    return { schemaVersion: focusedMemoryContractVersion, status: "unavailable" };
  }
}

export function fixedOutcomeForFocusedRetrieval(
  retrieval: Exclude<FocusedMemoryRetrievalResult, { readonly status: "current" }>,
): Extract<
  QuestionJobTerminalOutcome,
  "insufficient_evidence" | "processing" | "unavailable"
> {
  if (retrieval.status === "low_coverage") {
    return "insufficient_evidence";
  }
  if (retrieval.status === "pending" || retrieval.status === "stale") {
    return "processing";
  }
  return "unavailable";
}

function decodeCandidates(
  values: readonly unknown[],
  field: "candidates",
) {
  const candidates = values.map((candidateValue, index) => {
    const candidate = record(candidateValue, `${field}[${index}]`);
    assertOnlyKeys(
      candidate,
      new Set([
        "meetingId",
        "sourceEndCodePoint",
        "sourceStartCodePoint",
        "transcriptId",
        "transcriptVersion",
        "turnHash",
        "turnId",
      ]),
      `${field}[${index}]`,
    );
    const range = decodeCandidateSourceRange(candidate, `${field}[${index}]`);
    return Object.freeze({
      meetingId: requireKnowledgeText(
        candidate.meetingId as string,
        `${field}[${index}].meetingId`,
        1_024,
      ),
      ...range,
      transcriptId: requireKnowledgeText(
        candidate.transcriptId as string,
        `${field}[${index}].transcriptId`,
        1_024,
      ),
      transcriptVersion: requireKnowledgeInteger(
        candidate.transcriptVersion as number,
        `${field}[${index}].transcriptVersion`,
        1,
      ),
      turnHash: requireSha256(
        candidate.turnHash as string,
        `${field}[${index}].turnHash`,
      ),
      turnId: requireKnowledgeText(
        candidate.turnId as string,
        `${field}[${index}].turnId`,
        256,
      ),
    });
  });
  if (new Set(candidates.map(candidateKey)).size !== candidates.length) {
    throw new MeetingKnowledgeInvariantError(
      "DUPLICATE_EVIDENCE",
      `focused memory ${field} identities must be unique`,
    );
  }
  return candidates;
}

function decodeCandidateSourceRange(
  candidate: Record<string, unknown>,
  field: string,
): Pick<FocusedMemoryReference, "sourceEndCodePoint" | "sourceStartCodePoint"> {
  const hasStart = candidate.sourceStartCodePoint !== undefined;
  const hasEnd = candidate.sourceEndCodePoint !== undefined;
  if (hasStart !== hasEnd) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      `${field} source range must be complete`,
    );
  }
  if (!hasStart) {
    return {};
  }
  const sourceStartCodePoint = requireKnowledgeInteger(
    candidate.sourceStartCodePoint as number,
    `${field}.sourceStartCodePoint`,
  );
  const sourceEndCodePoint = requireKnowledgeInteger(
    candidate.sourceEndCodePoint as number,
    `${field}.sourceEndCodePoint`,
    1,
  );
  if (sourceEndCodePoint <= sourceStartCodePoint) {
    throw new MeetingKnowledgeInvariantError(
      "INVALID_GROUNDING_PLAN",
      `${field} source range is invalid`,
    );
  }
  return { sourceEndCodePoint, sourceStartCodePoint };
}

function candidateKey(candidate: {
  readonly meetingId: string;
  readonly sourceEndCodePoint?: number;
  readonly sourceStartCodePoint?: number;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
  readonly turnId: string;
}): string {
  return [
    candidate.meetingId,
    candidate.transcriptId,
    candidate.transcriptVersion,
    candidate.turnId,
    candidate.sourceStartCodePoint ?? "whole",
    candidate.sourceEndCodePoint ?? "whole",
  ].join("\u0000");
}
