import type {
  ConversationCancellationReason,
  ConversationStartRequest,
  GroundedKnowledgeAnswerObserverPort,
  GroundedKnowledgeAnswerPort,
} from "./ports/conversation.js";
import {
  groundedLiteralSpeechRequest,
  validateCompleteGroundedKnowledgeAnswer,
} from "./conversation-grounded-answer.js";
import type { PreparedConversation } from "./conversation-coordinator-types.js";

export interface ResolvedGroundedConversation {
  readonly playbackAuthority: (() => Promise<boolean>) | null;
  readonly request: ConversationStartRequest;
}

/** Resolves the optional knowledge boundary before the existing runtime starts. */
export class ConversationGroundedAnswerExecutor {
  private readonly answers: GroundedKnowledgeAnswerPort | null;
  private readonly observer: GroundedKnowledgeAnswerObserverPort | null;

  public constructor(input: {
    readonly answers?: GroundedKnowledgeAnswerPort;
    readonly observer?: GroundedKnowledgeAnswerObserverPort;
  }) {
    this.answers = input.answers ?? null;
    this.observer = input.observer ?? null;
  }

  public async resolve(
    prepared: PreparedConversation,
    signal: AbortSignal,
    isCurrent: () => boolean,
  ): Promise<ResolvedGroundedConversation | null> {
    const request = prepared.groundedKnowledgeRequest;
    const answers = this.answers;
    if (request === undefined || answers === null) {
      return Object.freeze({ playbackAuthority: null, request: prepared.request });
    }
    const grounded = await answers.answer(request, { signal });
    if (!grounded.ok || signal.aborted || !isCurrent()) {
      return null;
    }
    const validated = validateCompleteGroundedKnowledgeAnswer(grounded.value);
    const literalRequest = groundedLiteralSpeechRequest(
      prepared.request,
      request,
      grounded.value,
    );
    if (validated === null || literalRequest === null) {
      return null;
    }
    this.observe({
      citationTurnIds: validated.citations.map(({ turnId }) => turnId),
      evidenceEpoch: validated.evidenceEpoch,
      knowledgeEpoch: validated.knowledgeEpoch,
      meetingId: prepared.request.meetingId,
      participantId: prepared.request.speakerId,
      playbackProvenance: "literal_tts",
      status: "validated",
      turnId: prepared.request.turnId,
    });
    const authorityRequest = Object.freeze({
      citationTurnIds: Object.freeze(validated.citations.map(({ turnId }) => turnId)),
      evidenceEpoch: validated.evidenceEpoch,
      knowledgeEpoch: validated.knowledgeEpoch,
      request,
    });
    return Object.freeze({
      playbackAuthority: async () => {
        if (signal.aborted || !isCurrent()) {
          return false;
        }
        try {
          const result = await answers.recheckPlaybackAuthority(
            authorityRequest,
            { signal },
          );
          return result.ok && authorityRequestRemainsCurrent(signal, isCurrent);
        } catch {
          return false;
        }
      },
      request: literalRequest,
    });
  }

  public observeCancellation(
    prepared: PreparedConversation,
    reason: ConversationCancellationReason,
  ): void {
    if (prepared.groundedKnowledgeRequest === undefined || this.answers === null) {
      return;
    }
    this.observe({
      meetingId: prepared.request.meetingId,
      reason,
      status: "cancelled",
      turnId: prepared.request.turnId,
    });
  }

  private observe(
    observation: Parameters<
      GroundedKnowledgeAnswerObserverPort["observeGroundedKnowledgeAnswer"]
    >[0],
  ): void {
    try {
      const result = this.observer?.observeGroundedKnowledgeAnswer(observation);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Evidence observation cannot change delivery or cancellation.
    }
  }
}

function authorityRequestRemainsCurrent(
  signal: AbortSignal,
  isCurrent: () => boolean,
): boolean {
  return !signal.aborted && isCurrent();
}
