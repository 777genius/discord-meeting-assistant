import type {
  ConversationPortResult,
  GroundedKnowledgeAnswerOptions,
  GroundedKnowledgePlaybackAuthorityRequest,
  GroundedKnowledgeAnswerPort,
  GroundedKnowledgeAnswerRequest,
} from "@discord-meeting/meeting-core/conversation";

/**
 * Structural view of the published Meeting Knowledge use case. This adapter
 * intentionally does not import its implementation, database, Infinity or
 * provider types.
 */
export interface PublishedMeetingKnowledgeAnswerUseCase {
  execute(
    input: {
      readonly activeParticipantId: string;
      readonly locale: string;
      readonly meetingId: string;
      readonly question: string;
      readonly roomId: string;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;

  recheckPlaybackAuthority(
    input: {
      readonly activeParticipantId: string;
      readonly citationTurnIds: readonly string[];
      readonly evidenceEpoch: string;
      readonly knowledgeEpoch: string;
      readonly locale: string;
      readonly meetingId: string;
      readonly question: string;
      readonly roomId: string;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<unknown>;
}

/** Anti-corruption adapter from the published answer use case to Conversation. */
export class MeetingKnowledgeGroundedAnswerAcl implements GroundedKnowledgeAnswerPort {
  public constructor(
    private readonly publishedAnswers: PublishedMeetingKnowledgeAnswerUseCase,
  ) {}

  public async answer(
    request: GroundedKnowledgeAnswerRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<unknown>> {
    if (options.signal.aborted) {
      return failure("GROUNDED_ANSWER_CANCELLED", true);
    }
    let published: unknown;
    try {
      published = await this.publishedAnswers.execute({
        activeParticipantId: request.participantId,
        locale: request.locale,
        meetingId: request.meetingId,
        question: request.question,
        roomId: request.roomId,
      }, { signal: options.signal });
    } catch {
      return failure(
        signalWasAborted(options.signal)
          ? "GROUNDED_ANSWER_CANCELLED"
          : "GROUNDED_ANSWER_UNAVAILABLE",
        true,
      );
    }
    if (signalWasAborted(options.signal)) {
      return failure("GROUNDED_ANSWER_CANCELLED", true);
    }
    const mapped = mapPublishedAnswer(published);
    return mapped === null
      ? failure("GROUNDED_ANSWER_REJECTED", false)
      : { ok: true, value: mapped };
  }

  public async recheckPlaybackAuthority(
    input: GroundedKnowledgePlaybackAuthorityRequest,
    options: GroundedKnowledgeAnswerOptions,
  ): Promise<ConversationPortResult<"current">> {
    if (options.signal.aborted) {
      return failure("GROUNDED_PLAYBACK_CANCELLED", true);
    }
    let result: unknown;
    try {
      result = await this.publishedAnswers.recheckPlaybackAuthority({
        activeParticipantId: input.request.participantId,
        citationTurnIds: input.citationTurnIds,
        evidenceEpoch: input.evidenceEpoch,
        knowledgeEpoch: input.knowledgeEpoch,
        locale: input.request.locale,
        meetingId: input.request.meetingId,
        question: input.request.question,
        roomId: input.request.roomId,
      }, { signal: options.signal });
    } catch {
      return failure(
        signalWasAborted(options.signal)
          ? "GROUNDED_PLAYBACK_CANCELLED"
          : "GROUNDED_PLAYBACK_UNAVAILABLE",
        true,
      );
    }
    return !signalWasAborted(options.signal) && isCurrentPlaybackAuthority(result)
      ? { ok: true, value: "current" }
      : failure("GROUNDED_PLAYBACK_STALE", false);
  }
}

function isCurrentPlaybackAuthority(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ["schemaVersion", "status"]) &&
    value.schemaVersion === 1 && value.status === "current";
}

function mapPublishedAnswer(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !hasExactKeys(value, ["answer", "schemaVersion", "status"]) ||
    value.schemaVersion !== 1 || value.status !== "answered" || !isRecord(value.answer) ||
    !hasExactKeys(value.answer, [
      "citations",
      "evidenceEpoch",
      "knowledgeEpoch",
      "plainText",
    ])) {
    return null;
  }
  const answer = value.answer;
  if (!Array.isArray(answer.citations)) {
    return null;
  }
  const citations: { readonly turnId: unknown }[] = [];
  for (const citation of answer.citations) {
    if (!isRecord(citation) || !hasExactKeys(citation, ["turnId"])) {
      return null;
    }
    citations.push({ turnId: citation.turnId });
  }
  return {
    citations,
    evidenceEpoch: answer.evidenceEpoch,
    knowledgeEpoch: answer.knowledgeEpoch,
    plainText: answer.plainText,
    schemaVersion: 1,
    status: "answered",
  };
}

function failure(code: string, retryable: boolean): ConversationPortResult<never> {
  return {
    failure: {
      code,
      message: "Grounded knowledge answer was not admitted for speech",
      retryable,
    },
    ok: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signalWasAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
