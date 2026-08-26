import { requiresExhaustiveCoverage } from "../domain/question-scope.js";
import { createFocusedRetrievalGroundingPlan, type RehydratedEvidenceTurn } from "../domain/grounding-plan.js";
import type { ExhaustiveCoverage } from "./exhaustive-coverage.js";
import { GroundedMeetingAnswer } from "./grounded-meeting-answer.js";
import type { HistoricalAuthorizationObservationV1, HistoricalAuthorizationPort } from "./ports/historical-grounding.js";
import type { CanonicalEvidenceTurnHashPort } from "./ports/final-reply.js";
import type { LiveFinalizedMemoryQueryPort } from "./ports/live-finalized-memory.js";
import type { FocusedHistoricalEvidenceV2Port } from
  "./ports/focused-locator-retrieval-v2.js";
import { deduplicateEvidenceTurns, executeActiveExhaustiveCoverage,
  crossSourceTurns, normalizedLocale, notAnswered,
  recheckGroundedPlaybackAuthority, sameAuthorization,
  sameLiveContext, type GroundedPlaybackAuthorityRequest,
  type GroundedPlaybackAuthorityResultV1 } from "./grounded-question-internals.js";
export interface GroundedMeetingQuestionIdentityPort { digest(namespace: string, parts: readonly string[]): string }
export interface AnswerGroundedMeetingQuestionPolicyV1 {
  readonly maximumCandidates: number;
  readonly neighborTurns: number;
  readonly version: string;
}
export const DEFAULT_GROUNDED_MEETING_QUESTION_POLICY: AnswerGroundedMeetingQuestionPolicyV1 = Object.freeze({
    maximumCandidates: 24,
    neighborTurns: 2,
    version: "meeting-knowledge.grounded-question.v1",
  });
export type GroundedMeetingQuestionResultV1 =
  | {
      readonly answer: {
        readonly citations: readonly { readonly turnId: string }[];
        readonly evidenceEpoch: string;
        readonly knowledgeEpoch: string;
        readonly plainText: string;
      };
      readonly schemaVersion: 1;
      readonly status: "answered";
    }
  | {
      readonly reason: string;
      readonly schemaVersion: 1;
      readonly status: "cancelled" | "insufficient_evidence" | "unavailable";
    };
export type GroundedMeetingPlaybackAuthorityResultV1 = GroundedPlaybackAuthorityResultV1;
interface PreparedFocusedEvidence {
  readonly authorityGeneration: string;
  readonly canonicalEvidenceHash: string;
  readonly humanActorIds: readonly string[];
  readonly knowledgeEpoch: string;
  readonly transcriptVersion: number;
  readonly turns: readonly RehydratedEvidenceTurn[];
}
/**
 * Published synchronous Meeting Knowledge answer use case used by voice and
 * reusable by other transports. Retrieval produces locators, every selected
 * turn is canonically rehydrated, and the shared generation use case validates
 * the complete answer before this boundary returns speech-safe plain text.
 */
export class AnswerGroundedMeetingQuestion {
  readonly #policy: AnswerGroundedMeetingQuestionPolicyV1;
  public constructor(
    private readonly dependencies: {
      readonly answers: GroundedMeetingAnswer;
      readonly authorization?: HistoricalAuthorizationPort;
      readonly exhaustive?: Pick<ExhaustiveCoverage, "buildPlan">;
      readonly historical?: FocusedHistoricalEvidenceV2Port;
      readonly ids: GroundedMeetingQuestionIdentityPort;
      readonly live: LiveFinalizedMemoryQueryPort;
      readonly turnHashes: CanonicalEvidenceTurnHashPort;
    },
    policy: AnswerGroundedMeetingQuestionPolicyV1 =
      DEFAULT_GROUNDED_MEETING_QUESTION_POLICY,
  ) {
    if (
      policy.version !== "meeting-knowledge.grounded-question.v1" ||
      !Number.isSafeInteger(policy.maximumCandidates) ||
      policy.maximumCandidates < 1 ||
      policy.maximumCandidates > 256 ||
      !Number.isSafeInteger(policy.neighborTurns) ||
      policy.neighborTurns < 0 ||
      policy.neighborTurns > 8
    ) {
      throw new RangeError("grounded meeting question policy is outside its bounds");
    }
    this.#policy = Object.freeze({ ...policy });
  }
  public async execute(
    input: {
      readonly activeParticipantId: string;
      readonly authorizationPrincipalRef?: string;
      readonly locale: string;
      readonly meetingId: string;
      readonly question: string;
      readonly roomId: string;
    },
    options: { readonly signal: AbortSignal },
  ): Promise<GroundedMeetingQuestionResultV1> {
    if (options.signal.aborted) {
      return notAnswered("cancelled", "request_cancelled");
    }
    const current = await this.dependencies.live.resolveContext({
      meetingId: input.meetingId,
      requesterActorId: input.activeParticipantId,
      roomId: input.roomId,
      signal: options.signal,
    });
    if (current === null) {
      return notAnswered("unavailable", "live_room_authority_unavailable");
    }
    const admittedAuthorization = await this.authorize(input, current.scopeId, options.signal);
    if (admittedAuthorization === null) {
      return notAnswered("unavailable", "source_room_authorization_denied");
    }
    if (requiresExhaustiveCoverage(input.question)) {
      return executeActiveExhaustiveCoverage({
        ...input,
        exhaustive: this.dependencies.exhaustive,
        ids: this.dependencies.ids,
        scopeId: current.scopeId,
        signal: options.signal,
      });
    }
    const prepared = await this.prepareFocused(input, current, options.signal);
    if (prepared === "route_required") {
      return executeActiveExhaustiveCoverage({
        ...input,
        exhaustive: this.dependencies.exhaustive,
        ids: this.dependencies.ids,
        scopeId: current.scopeId,
        signal: options.signal,
      });
    }
    if (prepared === null) {
      return notAnswered("insufficient_evidence", "no_current_authorized_evidence");
    }
    const locale = normalizedLocale(input.locale, input.question);
    const plan = createFocusedRetrievalGroundingPlan({
      authorityGeneration: prepared.authorityGeneration,
      coverage: "sufficient",
      humanActorIds: prepared.humanActorIds,
      turns: prepared.turns,
    });
    const request = {
      attemptId: this.dependencies.ids.digest("grounded-answer-attempt", [
        input.meetingId,
        input.activeParticipantId,
        input.question,
        prepared.authorityGeneration,
      ]),
      binding: {
        canonicalEvidenceHash: prepared.canonicalEvidenceHash,
        memoryGeneration: prepared.authorityGeneration,
        transcriptVersion: prepared.transcriptVersion,
      },
      locale,
      plan,
      question: input.question,
    } as const;
    const fence = async () => await this.recheckFocusedFence(
      input,
      current,
      admittedAuthorization,
      prepared,
      options.signal,
    );
    const generated = await this.dependencies.answers.execute(request, {
      beforeGenerate: async () => await fence()
        ? "continue"
        : "stale_authorization",
      signal: options.signal,
    });
    if (generated.status !== "completed" || generated.answer.status !== "answered") {
      return notAnswered(
        generated.status === "cancelled" ? "cancelled" : "unavailable",
        `generation_${generated.status}`,
      );
    }
    const answer = generated.answer.toSnapshot();
    const evidenceById = new Map(plan.evidence.map((item) => [
      item.evidenceId,
      item,
    ]));
    const citations = [...new Set(answer.claims.flatMap(({ evidenceIds }) =>
      evidenceIds.map((evidenceId) => evidenceById.get(evidenceId)?.turnId)
        .filter((turnId): turnId is string => turnId !== undefined)
    ))].map((turnId) => Object.freeze({ turnId }));
    if (citations.length === 0) {
      return notAnswered("unavailable", "validated_answer_has_no_citations");
    }
    if (!await fence()) {
      return notAnswered("cancelled", "authority_changed_before_publication");
    }
    return Object.freeze({
      answer: Object.freeze({
        citations: Object.freeze(citations),
        evidenceEpoch: prepared.authorityGeneration,
        knowledgeEpoch: prepared.knowledgeEpoch,
        plainText: answer.claims.map(({ text }) => text).join(" "),
      }),
      schemaVersion: 1,
      status: "answered",
    });
  }
  /**
   * Rebuilds the locally authorized focused watermark immediately before voice
   * playback. The answer text is never accepted as evidence for this check.
   */
  public async recheckPlaybackAuthority(
    input: GroundedPlaybackAuthorityRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<GroundedMeetingPlaybackAuthorityResultV1> {
    return recheckGroundedPlaybackAuthority({
      ...input,
      maximumCandidates: this.#policy.maximumCandidates,
      signal: options.signal,
    }, {
      authorize: (scopeId) => this.authorize(input, scopeId, options.signal),
      live: this.dependencies.live,
      prepare: (context) => this.prepareFocused(input, context, options.signal),
    });
  }
  private async prepareFocused(
    input: Parameters<AnswerGroundedMeetingQuestion["execute"]>[0],
    context: NonNullable<Awaited<ReturnType<LiveFinalizedMemoryQueryPort["resolveContext"]>>>,
    signal: AbortSignal,
  ): Promise<PreparedFocusedEvidence | "route_required" | null> {
    const livePromise = this.dependencies.live.searchHotTail({
      maximumCandidates: this.#policy.maximumCandidates,
      meetingId: input.meetingId,
      neighborTurns: this.#policy.neighborTurns,
      question: input.question,
      requesterActorId: input.activeParticipantId,
      roomId: input.roomId,
      signal,
      scopeId: context.scopeId,
    });
    const historicalPromise = input.authorizationPrincipalRef === undefined ||
      this.dependencies.historical === undefined
      ? Promise.resolve({ status: "unavailable" as const })
      : this.dependencies.historical.retrieve({
          authorizationPrincipalRef: input.authorizationPrincipalRef,
          currentMeetingId: input.meetingId,
          maximumCandidates: this.#policy.maximumCandidates,
          question: input.question,
          roomId: input.roomId,
          scopeId: context.scopeId,
          signal,
        });
    const [liveResult, historicalResult] = await Promise.all([
      livePromise,
      historicalPromise,
    ]);
    signal.throwIfAborted();
    const liveTurns: RehydratedEvidenceTurn[] = [];
    const generationParts = [context.knowledgeEpoch];
    if (liveResult.status === "current") {
      const rehydrated = await this.dependencies.live.rehydrateHotTail({
        candidates: liveResult.candidates,
        expectedGeneration: liveResult.context.sourceGeneration,
        meetingId: input.meetingId,
        requesterActorId: input.activeParticipantId,
        roomId: input.roomId,
        signal,
        scopeId: context.scopeId,
      });
      if (rehydrated.status === "current") {
        liveTurns.push(...rehydrated.turns);
        generationParts.push(rehydrated.context.knowledgeEpoch);
      }
    }
    const historicalTurns = historicalResult.status === "current"
      ? historicalResult.turns
      : [];
    if (historicalResult.status === "current") {
      generationParts.push(historicalResult.authorityGeneration);
    }
    const fallbackSource = {
      meetingId: input.meetingId,
      transcriptId: `live-memory-v1:${input.meetingId}`,
      transcriptVersion: context.sourceGeneration,
    };
    const selected = crossSourceTurns(
      [...deduplicateEvidenceTurns(liveTurns, fallbackSource).values()],
      [...deduplicateEvidenceTurns(historicalTurns, fallbackSource).values()],
      this.#policy.maximumCandidates,
    );
    if (selected.length === 0) {
      return null;
    }
    const canonicalEvidenceHash = this.dependencies.ids.digest(
      "grounded-canonical-evidence",
      selected.flatMap((turn) => [
        turn.source?.meetingId ?? input.meetingId,
        turn.turnId,
        turn.turnHash,
      ]),
    );
    const generationDigest = this.dependencies.ids.digest(
      "grounded-knowledge-generation",
      generationParts,
    );
    const knowledgeEpoch = `room-memory:v1:${generationDigest}`;
    return Object.freeze({
      authorityGeneration: knowledgeEpoch,
      canonicalEvidenceHash,
      humanActorIds: Object.freeze([
        ...new Set(selected.map(({ speakerId }) => speakerId)),
      ].toSorted()),
      knowledgeEpoch,
      transcriptVersion: Math.max(1, context.sourceGeneration),
      turns: Object.freeze(selected),
    });
  }
  private async authorize(
    input: Parameters<AnswerGroundedMeetingQuestion["execute"]>[0],
    scopeId: string,
    signal: AbortSignal,
  ): Promise<HistoricalAuthorizationObservationV1 | null> {
    signal.throwIfAborted();
    if (this.dependencies.authorization === undefined) {
      return Object.freeze({
        authorizationDigest: "local-live-authority",
        authorizationEpoch: "local-live-authority",
        authorized: true,
        policyVersion: "local-live-authority.v1",
      });
    }
    if (input.authorizationPrincipalRef === undefined) {
      return null;
    }
    try {
      const observation = await this.dependencies.authorization.authorize({
        authorizationPrincipalRef: input.authorizationPrincipalRef,
        roomId: input.roomId,
        signal,
        scopeId,
      });
      signal.throwIfAborted();
      return observation.authorized ? observation : null;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }
  private async recheckFocusedFence(
    input: Parameters<AnswerGroundedMeetingQuestion["execute"]>[0],
    admittedContext: NonNullable<Awaited<ReturnType<LiveFinalizedMemoryQueryPort["resolveContext"]>>>,
    admittedAuthorization: HistoricalAuthorizationObservationV1,
    admittedEvidence: PreparedFocusedEvidence,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (signal.aborted) {
      return false;
    }
    const [context, authorization] = await Promise.all([
      this.dependencies.live.resolveContext({
        meetingId: input.meetingId,
        requesterActorId: input.activeParticipantId,
        roomId: input.roomId,
        signal,
      }),
      this.authorize(input, admittedContext.scopeId, signal),
    ]);
    if (
      context === null ||
      authorization === null ||
      !sameLiveContext(admittedContext, context) ||
      !sameAuthorization(admittedAuthorization, authorization)
    ) {
      return false;
    }
    const refreshed = await this.prepareFocused(input, context, signal);
    return refreshed !== null && refreshed !== "route_required" &&
      refreshed.authorityGeneration === admittedEvidence.authorityGeneration &&
      refreshed.canonicalEvidenceHash === admittedEvidence.canonicalEvidenceHash &&
      refreshed.knowledgeEpoch === admittedEvidence.knowledgeEpoch;
  }
}
