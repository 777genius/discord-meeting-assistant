import {
  MeetingKnowledgeIdentity,
  type MeetingKnowledgeIdentityProvenance,
} from "./meeting-knowledge-identity.js";

export const HISTORICAL_MEMORY_SCHEMA_VERSION = 1 as const;
export const HISTORICAL_EVIDENCE_POLICY_VERSION =
  "meeting-knowledge.evidence-block.v1" as const;
export const TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE_VERSION =
  "meeting-knowledge.two-hour-historical-retrieval.v1" as const;

export interface TwoHourHistoricalQualificationV1 {
  readonly evidenceSha256: string;
  readonly releaseRevision: string;
  readonly rolloutEpoch: string;
  readonly schemaVersion: 1;
}

interface TwoHourHistoricalQualificationInputV1 {
  readonly evidenceSha256: string;
  readonly releaseRevision: string;
  readonly rolloutEpoch: string;
  readonly schemaVersion: number;
}

export interface TwoHourHistoricalRetrievalProfileV1 {
  readonly qualification: TwoHourHistoricalQualificationV1 | null;
  readonly minimumDurationMs: 7_200_000;
  readonly minimumHumanTurnCount: 400;
  readonly version: typeof TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE_VERSION;
}

/**
 * Independent production admission for corpora that require retained two-hour
 * retrieval and answer-quality evidence. General historical search never
 * enables this profile.
 */
export const DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE:
  TwoHourHistoricalRetrievalProfileV1 = Object.freeze({
    qualification: null,
    minimumDurationMs: 7_200_000,
    minimumHumanTurnCount: 400,
    version: TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE_VERSION,
  });

export interface HistoricalReleaseBindingV1 {
  readonly acceptedMeetingRevision: number;
  readonly desiredGeneration: number;
  readonly evidencePolicyVersion: typeof HISTORICAL_EVIDENCE_POLICY_VERSION;
  readonly meetingId: string;
  readonly releaseId: string;
  readonly roomId: string;
  readonly schemaVersion: typeof HISTORICAL_MEMORY_SCHEMA_VERSION;
  readonly scopeId: string;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
}

export interface HistoricalActorV1 {
  readonly actorId: string;
  readonly kind: "automation" | "human" | "unknown";
}

interface HistoricalActorInputV1 {
  readonly actorId: string;
  readonly kind: string;
}

type HistoricalReleaseBindingInputV1 = Omit<
  HistoricalReleaseBindingV1,
  "evidencePolicyVersion" | "schemaVersion"
> & {
  readonly evidencePolicyVersion: string;
  readonly schemaVersion: number;
};

export interface HistoricalTranscriptTurnV1 {
  readonly endMs: number;
  readonly speakerId: string;
  readonly startMs: number;
  readonly text: string;
  readonly turnId: string;
}

export interface AcceptedFinalMeetingInputV1 {
  readonly actors: readonly HistoricalActorV1[] | null;
  readonly authoritativeDurationMs?: number | null;
  readonly binding: HistoricalReleaseBindingV1;
  readonly identityProvenance: MeetingKnowledgeIdentityProvenance | null;
  readonly lifecycleGeneration: number | null;
  readonly meetingRevision: number;
  readonly roomId: string | null;
  readonly scopeId: string | null;
  readonly transcriptId: string | null;
  readonly transcriptVersion: number | null;
  readonly turns: readonly HistoricalTranscriptTurnV1[] | null;
}

export interface AcceptedFinalMeetingV1 {
  readonly authoritativeDurationMs: number | null;
  readonly binding: HistoricalReleaseBindingV1;
  readonly humanTurns: readonly HistoricalTranscriptTurnV1[];
  readonly schemaVersion: typeof HISTORICAL_MEMORY_SCHEMA_VERSION;
}

export function admitsHistoricalRetrieval(
  meeting: AcceptedFinalMeetingV1,
  profile: TwoHourHistoricalRetrievalProfileV1 =
    DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
): boolean {
  const runtimeProfile = profile as {
    readonly qualification: TwoHourHistoricalQualificationInputV1 | null;
    readonly minimumDurationMs: number;
    readonly minimumHumanTurnCount: number;
    readonly version: string;
  };
  if (
    runtimeProfile.version !== TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE_VERSION ||
    runtimeProfile.minimumDurationMs !== 7_200_000 ||
    runtimeProfile.minimumHumanTurnCount !== 400
  ) {
    throw new HistoricalEvidenceInvariantError(
      "INVALID_CONTRACT",
      "two-hour historical retrieval profile is not centrally qualified",
    );
  }
  if (runtimeProfile.qualification !== null) {
    const qualification = runtimeProfile.qualification;
    if (
      qualification.schemaVersion !== 1 ||
      !/^[0-9a-f]{64}$/u.test(qualification.evidenceSha256) ||
      !/^[0-9a-f]{40}$/u.test(qualification.releaseRevision) ||
      qualification.rolloutEpoch.trim().length === 0
    ) {
      throw new HistoricalEvidenceInvariantError(
        "INVALID_CONTRACT",
        "two-hour historical retrieval qualification is invalid",
      );
    }
    return true;
  }
  return meeting.authoritativeDurationMs !== null &&
    meeting.authoritativeDurationMs < runtimeProfile.minimumDurationMs &&
    meeting.humanTurns.length < runtimeProfile.minimumHumanTurnCount;
}

export class HistoricalEvidenceInvariantError extends Error {
  public override readonly name = "HistoricalEvidenceInvariantError";

  public constructor(
    public readonly code:
      | "CONFLICTING_BINDING"
      | "DUPLICATE_ACTOR"
      | "DUPLICATE_TURN"
      | "INVALID_CONTRACT",
    message: string,
  ) {
    super(message);
  }
}

function requireString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HistoricalEvidenceInvariantError(
      "INVALID_CONTRACT",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

function requireSafeInteger(
  value: number,
  field: string,
  minimum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new HistoricalEvidenceInvariantError(
      "INVALID_CONTRACT",
      `${field} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value;
}

function identityPart(value: string): string {
  return `${value.length}:${value}`;
}

export function createHistoricalReleaseBinding(input: {
  readonly acceptedMeetingRevision: number;
  readonly desiredGeneration: number;
  readonly meetingId: string;
  readonly roomId: string;
  readonly scopeId: string;
  readonly transcriptId: string;
  readonly transcriptVersion: number;
}): HistoricalReleaseBindingV1 {
  const meetingId = requireString(input.meetingId, "binding.meetingId");
  const scopeId = requireString(input.scopeId, "binding.scopeId");
  const roomId = requireString(input.roomId, "binding.roomId");
  const transcriptId = requireString(input.transcriptId, "binding.transcriptId");
  const transcriptVersion = requireSafeInteger(
    input.transcriptVersion,
    "binding.transcriptVersion",
    1,
  );
  const desiredGeneration = requireSafeInteger(
    input.desiredGeneration,
    "binding.desiredGeneration",
    1,
  );
  const acceptedMeetingRevision = requireSafeInteger(
    input.acceptedMeetingRevision,
    "binding.acceptedMeetingRevision",
    0,
  );
  const releaseId = [
    "historical-release-v1",
    identityPart(meetingId),
    identityPart(transcriptId),
    String(transcriptVersion),
    HISTORICAL_EVIDENCE_POLICY_VERSION,
  ].join("|");

  return Object.freeze({
    acceptedMeetingRevision,
    desiredGeneration,
    evidencePolicyVersion: HISTORICAL_EVIDENCE_POLICY_VERSION,
    meetingId,
    releaseId,
    roomId,
    schemaVersion: HISTORICAL_MEMORY_SCHEMA_VERSION,
    scopeId,
    transcriptId,
    transcriptVersion,
  });
}

export function validateHistoricalReleaseBinding(
  binding: HistoricalReleaseBindingInputV1,
): HistoricalReleaseBindingV1 {
  const expected = createHistoricalReleaseBinding(binding);
  if (
    binding.schemaVersion !== HISTORICAL_MEMORY_SCHEMA_VERSION ||
    binding.evidencePolicyVersion !== HISTORICAL_EVIDENCE_POLICY_VERSION ||
    binding.releaseId !== expected.releaseId
  ) {
    throw new HistoricalEvidenceInvariantError(
      "INVALID_CONTRACT",
      "historical release binding version or deterministic identity is invalid",
    );
  }
  return expected;
}

function normalizeActors(
  actors: readonly HistoricalActorInputV1[],
): readonly HistoricalActorV1[] {
  const normalized = actors.map((actor) => {
    if (
      actor.kind !== "human" &&
      actor.kind !== "automation" &&
      actor.kind !== "unknown"
    ) {
      throw new HistoricalEvidenceInvariantError(
        "INVALID_CONTRACT",
        "historical actor kind is unsupported",
      );
    }
    return Object.freeze({
      actorId: requireString(actor.actorId, "actors.actorId"),
      kind: actor.kind,
    });
  }).toSorted((left, right) => compareOpaque(left.actorId, right.actorId));

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]?.actorId === normalized[index]?.actorId) {
      throw new HistoricalEvidenceInvariantError(
        "DUPLICATE_ACTOR",
        "historical actor roster must contain each actor exactly once",
      );
    }
  }
  return Object.freeze(normalized);
}

function normalizeTurn(turn: HistoricalTranscriptTurnV1): HistoricalTranscriptTurnV1 {
  const startMs = requireSafeInteger(turn.startMs, "turn.startMs", 0);
  const endMs = requireSafeInteger(turn.endMs, "turn.endMs", 1);
  if (endMs <= startMs) {
    throw new HistoricalEvidenceInvariantError(
      "INVALID_CONTRACT",
      "historical turn endMs must be greater than startMs",
    );
  }
  return Object.freeze({
    endMs,
    speakerId: requireString(turn.speakerId, "turn.speakerId"),
    startMs,
    text: requireString(turn.text, "turn.text"),
    turnId: requireString(turn.turnId, "turn.turnId"),
  });
}

/**
 * Admits only the current accepted final transcript from the trusted, sealed
 * lifecycle identity capability and only actors positively identified as
 * human. Live turns, summaries, questions and generated answers have no
 * representation in this contract.
 */
export function admitAcceptedFinalMeeting(
  input: AcceptedFinalMeetingInputV1,
): AcceptedFinalMeetingV1 | null {
  if (
    input.actors === null ||
    input.roomId === null ||
    input.scopeId === null ||
    input.transcriptId === null ||
    input.transcriptVersion === null ||
    input.turns === null
  ) {
    return null;
  }

  const binding = validateHistoricalReleaseBinding(input.binding);
  if (
    binding.scopeId !== input.scopeId ||
    binding.roomId !== input.roomId ||
    binding.transcriptId !== input.transcriptId ||
    binding.transcriptVersion !== input.transcriptVersion ||
    input.meetingRevision < binding.acceptedMeetingRevision
  ) {
    throw new HistoricalEvidenceInvariantError(
      "CONFLICTING_BINDING",
      "authoritative meeting no longer satisfies its accepted release binding",
    );
  }

  const actors = normalizeActors(input.actors);
  const identity = MeetingKnowledgeIdentity.admit({
    actors,
    identityProvenance: input.identityProvenance,
    lifecycleGeneration: input.lifecycleGeneration,
    source: { roomId: input.roomId, scopeId: input.scopeId },
  });
  if (identity === null) {
    return null;
  }
  const humanActors = new Set(identity.humanActorIds);
  const turns = input.turns.map(normalizeTurn).toSorted((left, right) =>
    left.startMs - right.startMs ||
    left.endMs - right.endMs ||
    compareOpaque(left.turnId, right.turnId)
  );
  if (new Set(turns.map(({ turnId }) => turnId)).size !== turns.length) {
    throw new HistoricalEvidenceInvariantError(
      "DUPLICATE_TURN",
      "accepted transcript turn identities must be unique",
    );
  }
  const humanTurns = turns.filter(({ speakerId }) => humanActors.has(speakerId));
  if (humanTurns.length === 0) {
    return null;
  }

  return Object.freeze({
    authoritativeDurationMs: input.authoritativeDurationMs === undefined ||
        input.authoritativeDurationMs === null
      ? null
      : requireSafeInteger(
          input.authoritativeDurationMs,
          "authoritativeDurationMs",
          0,
        ),
    binding,
    humanTurns: Object.freeze(humanTurns),
    schemaVersion: HISTORICAL_MEMORY_SCHEMA_VERSION,
  });
}

function compareOpaque(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
