import {
  DomainInvariantError,
  requireNonEmpty,
  requireNonNegativeInteger,
  requirePositiveInteger,
} from "./errors.js";
import {
  createExternalPublicationId,
  createMeetingId,
  createPublicationTargetId,
  type ExternalPublicationId,
  type MeetingId,
  type PublicationTargetId,
} from "./identifiers.js";
import type {
  SummaryActionItemSnapshot,
  SummaryDecisionSnapshot,
  SummaryOpenQuestionSnapshot,
  SummaryTopicSnapshot,
} from "./summary.js";
import { TranscriptTurn, type TranscriptTurnSnapshot } from "./transcript.js";

export type LiveMeetingStatus = "active" | "ended";

export interface LiveSummaryDraftSnapshot {
  readonly actionItems: readonly SummaryActionItemSnapshot[];
  readonly decisions: readonly SummaryDecisionSnapshot[];
  readonly openQuestions: readonly SummaryOpenQuestionSnapshot[];
  readonly overview: string;
  readonly revision: number;
  readonly title: string;
  readonly topics: readonly SummaryTopicSnapshot[];
}

export interface LiveGenerationUsageSnapshot {
  readonly apiEquivalentCostUsd: number | null;
  readonly cacheWriteInputTokens: number;
  readonly cachedInputTokens: number;
  readonly inputTokens: number;
  readonly model: string;
  readonly outputTokens: number;
  readonly priceCard: string;
  readonly reasoningOutputTokens: number;
  readonly runId: string;
  readonly totalTokens: number;
}

/** A provider-reported token class that is never represented by a synthetic zero. */
export type LiveGenerationTokenClassSnapshot =
  | {
      readonly availability: "measured";
      readonly value: number;
    }
  | {
      readonly availability: "derived";
      readonly derivedFrom: readonly ["inputTokens", "outputTokens"];
      readonly value: number;
    }
  | {
      readonly availability: "unavailable";
    };

export interface LiveGenerationCostSnapshot {
  readonly exactUsd?: number;
  readonly maximumUsd: number;
  readonly minimumUsd: number;
  readonly priceCardId: string;
  readonly priceCardSource: string;
}

/**
 * Provider-agnostic generation telemetry, including classes a provider cannot
 * report. It is persisted separately from legacy complete usage.
 */
export interface LiveGenerationTelemetrySnapshot {
  readonly cacheWriteInputTokens: LiveGenerationTokenClassSnapshot;
  readonly cachedInputTokens: LiveGenerationTokenClassSnapshot;
  readonly cost?: LiveGenerationCostSnapshot;
  readonly inputTokens: LiveGenerationTokenClassSnapshot;
  readonly model: string;
  readonly outputTokens: LiveGenerationTokenClassSnapshot;
  readonly reasoningOutputTokens: LiveGenerationTokenClassSnapshot;
  readonly runId: string;
  readonly source: string;
  readonly totalTokens: LiveGenerationTokenClassSnapshot;
}

export interface LiveMeetingSnapshot {
  readonly draftSummary: LiveSummaryDraftSnapshot | null;
  readonly endedAtMs: number | null;
  /** Optional while restoring snapshots persisted before partial telemetry. */
  readonly generationTelemetry?: readonly LiveGenerationTelemetrySnapshot[];
  readonly generationUsage: readonly LiveGenerationUsageSnapshot[];
  readonly meetingId: string;
  readonly projectedRevision: number;
  readonly projectionExternalId: string | null;
  readonly publicationTargetId: string;
  readonly revision: number;
  readonly startedAtMs: number;
  readonly status: LiveMeetingStatus;
  readonly summarizedTurnIds: readonly string[];
  readonly summaryGeneratedAtMs: number | null;
  readonly turns: readonly TranscriptTurnSnapshot[];
}

export interface StartLiveMeetingInput {
  readonly meetingId: string;
  readonly publicationTargetId: string;
  readonly startedAtMs: number;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} must be non-negative`);
  }
  return value;
}

function requireLiveMeetingStatus(value: unknown): LiveMeetingStatus {
  if (value !== "active" && value !== "ended") {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "live meeting status is invalid");
  }
  return value;
}

function validateUsage(input: LiveGenerationUsageSnapshot): LiveGenerationUsageSnapshot {
  const usage = {
    apiEquivalentCostUsd:
      input.apiEquivalentCostUsd === null
        ? null
        : requireFiniteNonNegative(input.apiEquivalentCostUsd, "usage.apiEquivalentCostUsd"),
    cacheWriteInputTokens: requireNonNegativeInteger(
      input.cacheWriteInputTokens,
      "usage.cacheWriteInputTokens",
    ),
    cachedInputTokens: requireNonNegativeInteger(
      input.cachedInputTokens,
      "usage.cachedInputTokens",
    ),
    inputTokens: requireNonNegativeInteger(input.inputTokens, "usage.inputTokens"),
    model: requireNonEmpty(input.model, "usage.model"),
    outputTokens: requireNonNegativeInteger(input.outputTokens, "usage.outputTokens"),
    priceCard: requireNonEmpty(input.priceCard, "usage.priceCard"),
    reasoningOutputTokens: requireNonNegativeInteger(
      input.reasoningOutputTokens,
      "usage.reasoningOutputTokens",
    ),
    runId: requireNonEmpty(input.runId, "usage.runId"),
    totalTokens: requireNonNegativeInteger(input.totalTokens, "usage.totalTokens"),
  };
  if (
    usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens ||
    usage.reasoningOutputTokens > usage.outputTokens ||
    usage.totalTokens < usage.inputTokens + usage.outputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation usage totals are inconsistent");
  }
  return Object.freeze(usage);
}

function validateTokenClass(
  input: LiveGenerationTokenClassSnapshot,
  field: string,
  allowDerived: boolean,
): LiveGenerationTokenClassSnapshot {
  const rawToken: unknown = input;
  if (rawToken === null || typeof rawToken !== "object" || Array.isArray(rawToken)) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} token class is invalid`);
  }
  const token = rawToken as Record<string, unknown>;
  if (token.availability === "unavailable") {
    if ("value" in token || "derivedFrom" in token) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        `${field} unavailable token class must not carry a value`,
      );
    }
    return Object.freeze({ availability: "unavailable" });
  }
  if (token.availability === "measured") {
    return Object.freeze({
      availability: "measured",
      value: requireNonNegativeInteger(token.value as number, `${field}.value`),
    });
  }
  if (
    !allowDerived ||
    token.availability !== "derived" ||
    !Array.isArray(token.derivedFrom) ||
    token.derivedFrom.length !== 2 ||
    token.derivedFrom[0] !== "inputTokens" ||
    token.derivedFrom[1] !== "outputTokens"
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", `${field} token availability is invalid`);
  }
  return Object.freeze({
    availability: "derived",
    derivedFrom: ["inputTokens", "outputTokens"] as const,
    value: requireNonNegativeInteger(token.value as number, `${field}.value`),
  });
}

function measuredTokenValue(
  input: LiveGenerationTokenClassSnapshot,
): number | undefined {
  return input.availability === "measured" ? input.value : undefined;
}

function validateGenerationCost(
  input: LiveGenerationCostSnapshot,
): LiveGenerationCostSnapshot {
  const minimumUsd = requireFiniteNonNegative(input.minimumUsd, "telemetry.cost.minimumUsd");
  const maximumUsd = requireFiniteNonNegative(input.maximumUsd, "telemetry.cost.maximumUsd");
  if (minimumUsd > maximumUsd) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation cost range is inverted");
  }
  const exactUsd = input.exactUsd === undefined
    ? undefined
    : requireFiniteNonNegative(input.exactUsd, "telemetry.cost.exactUsd");
  if (
    exactUsd !== undefined &&
    (exactUsd !== minimumUsd || exactUsd !== maximumUsd)
  ) {
    throw new DomainInvariantError(
      "INVALID_SNAPSHOT",
      "exact generation cost must collapse the cost range",
    );
  }
  return Object.freeze({
    ...(exactUsd === undefined ? {} : { exactUsd }),
    maximumUsd,
    minimumUsd,
    priceCardId: requireNonEmpty(input.priceCardId, "telemetry.cost.priceCardId"),
    priceCardSource: requireNonEmpty(
      input.priceCardSource,
      "telemetry.cost.priceCardSource",
    ),
  });
}

function validateTelemetry(
  input: LiveGenerationTelemetrySnapshot,
): LiveGenerationTelemetrySnapshot {
  const inputTokens = validateTokenClass(input.inputTokens, "telemetry.inputTokens", false);
  const cachedInputTokens = validateTokenClass(
    input.cachedInputTokens,
    "telemetry.cachedInputTokens",
    false,
  );
  const cacheWriteInputTokens = validateTokenClass(
    input.cacheWriteInputTokens,
    "telemetry.cacheWriteInputTokens",
    false,
  );
  const outputTokens = validateTokenClass(input.outputTokens, "telemetry.outputTokens", false);
  const reasoningOutputTokens = validateTokenClass(
    input.reasoningOutputTokens,
    "telemetry.reasoningOutputTokens",
    false,
  );
  const totalTokens = validateTokenClass(input.totalTokens, "telemetry.totalTokens", true);
  const measuredInputTokens = measuredTokenValue(inputTokens);
  const measuredCachedInputTokens = measuredTokenValue(cachedInputTokens);
  const measuredCacheWriteInputTokens = measuredTokenValue(cacheWriteInputTokens);
  const measuredOutputTokens = measuredTokenValue(outputTokens);
  const measuredReasoningOutputTokens = measuredTokenValue(reasoningOutputTokens);
  const measuredTotalTokens = measuredTokenValue(totalTokens);

  if (
    measuredInputTokens !== undefined &&
    measuredCachedInputTokens !== undefined &&
    measuredCachedInputTokens > measuredInputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "cached input exceeds input");
  }
  if (
    measuredInputTokens !== undefined &&
    measuredCachedInputTokens !== undefined &&
    measuredCacheWriteInputTokens !== undefined &&
    measuredCachedInputTokens + measuredCacheWriteInputTokens > measuredInputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "cache-write input exceeds input");
  }
  if (
    measuredOutputTokens !== undefined &&
    measuredReasoningOutputTokens !== undefined &&
    measuredReasoningOutputTokens > measuredOutputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "reasoning output exceeds output");
  }
  if (
    totalTokens.availability === "derived" &&
    (measuredInputTokens === undefined ||
      measuredOutputTokens === undefined ||
      !Number.isSafeInteger(measuredInputTokens + measuredOutputTokens) ||
      totalTokens.value !== measuredInputTokens + measuredOutputTokens)
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "derived generation total is inconsistent");
  }
  if (
    totalTokens.availability === "measured" &&
    measuredInputTokens !== undefined &&
    measuredOutputTokens !== undefined &&
    measuredTotalTokens !== undefined &&
    measuredTotalTokens < measuredInputTokens + measuredOutputTokens
  ) {
    throw new DomainInvariantError("INVALID_SNAPSHOT", "generation total is inconsistent");
  }

  return Object.freeze({
    cacheWriteInputTokens,
    cachedInputTokens,
    ...(input.cost === undefined ? {} : { cost: validateGenerationCost(input.cost) }),
    inputTokens,
    model: requireNonEmpty(input.model, "telemetry.model"),
    outputTokens,
    reasoningOutputTokens,
    runId: requireNonEmpty(input.runId, "telemetry.runId"),
    source: requireNonEmpty(input.source, "telemetry.source"),
    totalTokens,
  });
}

function validateSummary(
  input: LiveSummaryDraftSnapshot,
  turns: readonly TranscriptTurn[],
  expectedRevision: number,
): LiveSummaryDraftSnapshot {
  if (input.revision !== expectedRevision) {
    throw new DomainInvariantError(
      "CONFLICTING_COMPLETION",
      "live summary revision must advance exactly once",
    );
  }
  const knownTurns = new Set(turns.map(({ turnId }) => String(turnId)));
  const knownSpeakers = new Set(turns.map(({ speakerId }) => String(speakerId)));
  const evidenceGroups = [
    ...input.topics.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.decisions.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.actionItems.map(({ evidenceTurnIds }) => evidenceTurnIds),
    ...input.openQuestions.map(({ evidenceTurnIds }) => evidenceTurnIds),
  ];
  for (const evidenceTurnIds of evidenceGroups) {
    if (
      evidenceTurnIds.length === 0 ||
      new Set(evidenceTurnIds).size !== evidenceTurnIds.length ||
      evidenceTurnIds.some((turnId) => !knownTurns.has(turnId))
    ) {
      throw new DomainInvariantError(
        "INVALID_EVIDENCE_REFERENCE",
        "live summary evidence must reference unique known finalized turns",
      );
    }
  }
  if (
    input.actionItems.some(
      ({ ownerSpeakerId }) =>
        ownerSpeakerId !== null && !knownSpeakers.has(ownerSpeakerId),
    )
  ) {
    throw new DomainInvariantError(
      "INVALID_EVIDENCE_REFERENCE",
      "live summary action owner must be a known speaker",
    );
  }

  const actionItems = input.actionItems.map((item) => Object.freeze({
    actionItemId: requireNonEmpty(item.actionItemId, "liveSummary.actionItemId"),
    deadline: item.deadline === null
      ? null
      : requireNonEmpty(item.deadline, "liveSummary.actionItem.deadline"),
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    ownerSpeakerId: item.ownerSpeakerId,
    text: requireNonEmpty(item.text, "liveSummary.actionItem.text"),
  }));
  const decisions = input.decisions.map((item) => Object.freeze({
    decisionId: requireNonEmpty(item.decisionId, "liveSummary.decisionId"),
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    text: requireNonEmpty(item.text, "liveSummary.decision.text"),
  }));
  const openQuestions = input.openQuestions.map((item) => Object.freeze({
    evidenceTurnIds: Object.freeze([...item.evidenceTurnIds]),
    id: requireNonEmpty(item.id, "liveSummary.openQuestion.id"),
    text: requireNonEmpty(item.text, "liveSummary.openQuestion.text"),
  }));
  requireUniqueIdentifiers(actionItems.map(({ actionItemId }) => actionItemId));
  requireUniqueIdentifiers(decisions.map(({ decisionId }) => decisionId));
  requireUniqueIdentifiers(openQuestions.map(({ id }) => id));

  return Object.freeze({
    actionItems: Object.freeze(actionItems),
    decisions: Object.freeze(decisions),
    openQuestions: Object.freeze(openQuestions),
    overview: requireNonEmpty(input.overview, "liveSummary.overview"),
    revision: requirePositiveInteger(input.revision, "liveSummary.revision"),
    title: requireNonEmpty(input.title, "liveSummary.title"),
    topics: Object.freeze(input.topics.map((topic) => Object.freeze({
      ...topic,
      evidenceTurnIds: Object.freeze([...topic.evidenceTurnIds]),
      points: Object.freeze(topic.points.map((point) =>
        requireNonEmpty(point, "liveSummary.topic.point")
      )),
      title: requireNonEmpty(topic.title, "liveSummary.topic.title"),
    }))),
  });
}

function requireUniqueIdentifiers(identifiers: readonly string[]): void {
  if (new Set(identifiers).size !== identifiers.length) {
    throw new DomainInvariantError(
      "DUPLICATE_IDENTIFIER",
      "live summary structured item IDs must be unique",
    );
  }
}

function sameUsage(left: LiveGenerationUsageSnapshot, right: LiveGenerationUsageSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameTelemetry(
  left: LiveGenerationTelemetrySnapshot,
  right: LiveGenerationTelemetrySnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class LiveMeeting {
  public readonly meetingId: MeetingId;
  public readonly publicationTargetId: PublicationTargetId;
  public readonly startedAtMs: number;

  private currentRevision: number;
  private currentStatus: LiveMeetingStatus;
  private endedTimestampMs: number | null;
  private readonly finalizedTurns: TranscriptTurn[];
  private summaryDraft: LiveSummaryDraftSnapshot | null;
  private readonly summarizedTurnIdSet: Set<string>;
  private summaryTimestampMs: number | null;
  private externalProjectionId: ExternalPublicationId | null;
  private lastProjectedRevision: number;
  private readonly telemetryRecords: LiveGenerationTelemetrySnapshot[];
  private readonly usageRecords: LiveGenerationUsageSnapshot[];

  private constructor(snapshot: LiveMeetingSnapshot) {
    this.meetingId = createMeetingId(snapshot.meetingId);
    this.publicationTargetId = createPublicationTargetId(snapshot.publicationTargetId);
    this.startedAtMs = requireNonNegativeInteger(snapshot.startedAtMs, "liveMeeting.startedAtMs");
    this.currentRevision = requireNonNegativeInteger(snapshot.revision, "liveMeeting.revision");
    this.currentStatus = requireLiveMeetingStatus(snapshot.status);
    this.endedTimestampMs = snapshot.endedAtMs === null
      ? null
      : requireNonNegativeInteger(snapshot.endedAtMs, "liveMeeting.endedAtMs");
    this.finalizedTurns = snapshot.turns.map((turn) => TranscriptTurn.create(turn));
    if (new Set(this.finalizedTurns.map(({ turnId }) => turnId)).size !== this.finalizedTurns.length) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live turn IDs must be unique");
    }
    const summarizedTurnIds = snapshot.summarizedTurnIds.map((turnId) =>
      requireNonEmpty(turnId, "liveMeeting.summarizedTurnId")
    );
    if (
      new Set(summarizedTurnIds).size !== summarizedTurnIds.length ||
      summarizedTurnIds.some((turnId) =>
        !this.finalizedTurns.some((turn) => turn.turnId === turnId)
      )
    ) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        "summarized live turn IDs must be unique known finalized turns",
      );
    }
    this.summarizedTurnIdSet = new Set(summarizedTurnIds);
    this.summaryDraft = snapshot.draftSummary === null
      ? null
      : validateSummary(snapshot.draftSummary, this.finalizedTurns, snapshot.draftSummary.revision);
    this.summaryTimestampMs = snapshot.summaryGeneratedAtMs === null
      ? null
      : requireNonNegativeInteger(
          snapshot.summaryGeneratedAtMs,
          "liveMeeting.summaryGeneratedAtMs",
        );
    this.externalProjectionId = snapshot.projectionExternalId === null
      ? null
      : createExternalPublicationId(snapshot.projectionExternalId);
    this.lastProjectedRevision = requireNonNegativeInteger(
      snapshot.projectedRevision,
      "liveMeeting.projectedRevision",
    );
    if (this.lastProjectedRevision > this.currentRevision) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "projected revision exceeds live state");
    }
    this.usageRecords = snapshot.generationUsage.map(validateUsage);
    if (new Set(this.usageRecords.map(({ runId }) => runId)).size !== this.usageRecords.length) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "generation usage run IDs must be unique");
    }
    this.telemetryRecords = (snapshot.generationTelemetry ?? []).map(validateTelemetry);
    if (
      new Set(this.telemetryRecords.map(({ runId }) => runId)).size !==
      this.telemetryRecords.length
    ) {
      throw new DomainInvariantError(
        "INVALID_SNAPSHOT",
        "generation telemetry run IDs must be unique",
      );
    }
    this.validateLifecycle();
  }

  public static start(input: StartLiveMeetingInput): LiveMeeting {
    return new LiveMeeting({
      draftSummary: null,
      endedAtMs: null,
      generationTelemetry: [],
      generationUsage: [],
      meetingId: input.meetingId,
      projectedRevision: 0,
      projectionExternalId: null,
      publicationTargetId: input.publicationTargetId,
      revision: 0,
      startedAtMs: input.startedAtMs,
      status: "active",
      summarizedTurnIds: [],
      summaryGeneratedAtMs: null,
      turns: [],
    });
  }

  public static restore(snapshot: LiveMeetingSnapshot): LiveMeeting {
    return new LiveMeeting(snapshot);
  }

  public get revision(): number {
    return this.currentRevision;
  }

  public get status(): LiveMeetingStatus {
    return this.currentStatus;
  }

  public get endedAtMs(): number | null {
    return this.endedTimestampMs;
  }

  public get turns(): readonly TranscriptTurn[] {
    return [...this.finalizedTurns];
  }

  public get draftSummary(): LiveSummaryDraftSnapshot | null {
    return this.summaryDraft;
  }

  public get summarizedTurnIds(): ReadonlySet<string> {
    return new Set(this.summarizedTurnIdSet);
  }

  public get summaryGeneratedAtMs(): number | null {
    return this.summaryTimestampMs;
  }

  public get projectionExternalId(): string | null {
    return this.externalProjectionId;
  }

  public get projectedRevision(): number {
    return this.lastProjectedRevision;
  }

  public appendFinalTurn(snapshot: TranscriptTurnSnapshot): boolean {
    const turn = TranscriptTurn.create(snapshot);
    const existing = this.finalizedTurns.find(({ turnId }) => turnId === turn.turnId);
    if (existing !== undefined) {
      if (existing.equals(turn)) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "live turn identity was reused with different content",
      );
    }
    if (this.currentStatus !== "active") {
      throw new DomainInvariantError(
        "INVALID_LIFECYCLE_STATE",
        "cannot append a live turn after the meeting ended",
      );
    }
    this.finalizedTurns.push(turn);
    this.finalizedTurns.sort((left, right) =>
      left.startMs - right.startMs ||
      left.endMs - right.endMs ||
      String(left.speakerId).localeCompare(String(right.speakerId)) ||
      String(left.turnId).localeCompare(String(right.turnId))
    );
    this.incrementRevision();
    return true;
  }

  public acceptSummary(input: {
    readonly generatedAtMs: number;
    readonly summary: LiveSummaryDraftSnapshot;
    readonly telemetry?: LiveGenerationTelemetrySnapshot;
    readonly throughTurnCount: number;
    readonly usage?: LiveGenerationUsageSnapshot;
  }): void {
    const throughTurnCount = requireNonNegativeInteger(
      input.throughTurnCount,
      "liveSummary.throughTurnCount",
    );
    if (throughTurnCount > this.finalizedTurns.length) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "live summary cannot cover turns outside the generation snapshot",
      );
    }
    const coveredTurns = this.finalizedTurns.slice(0, throughTurnCount);
    const expectedSummaryRevision = (this.summaryDraft?.revision ?? 0) + 1;
    const summary = validateSummary(input.summary, coveredTurns, expectedSummaryRevision);
    const generatedAtMs = requireNonNegativeInteger(input.generatedAtMs, "liveSummary.generatedAtMs");
    if (generatedAtMs < this.startedAtMs) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "summary cannot predate the meeting");
    }
    if (input.usage !== undefined) {
      this.appendGenerationUsage(input.usage);
    }
    if (input.telemetry !== undefined) {
      this.appendGenerationTelemetry(input.telemetry);
    }
    this.summaryDraft = summary;
    this.summarizedTurnIdSet.clear();
    for (const turn of coveredTurns) {
      this.summarizedTurnIdSet.add(turn.turnId);
    }
    this.summaryTimestampMs = generatedAtMs;
    this.incrementRevision();
  }

  public recordGenerationUsage(input: LiveGenerationUsageSnapshot): boolean {
    if (!this.appendGenerationUsage(input)) {
      return false;
    }
    this.incrementInvisibleRevision();
    return true;
  }

  public recordGenerationTelemetry(input: LiveGenerationTelemetrySnapshot): boolean {
    if (!this.appendGenerationTelemetry(input)) {
      return false;
    }
    this.incrementInvisibleRevision();
    return true;
  }

  public completeProjection(externalPublicationId: string, projectedRevision: number): boolean {
    const normalized = createExternalPublicationId(externalPublicationId);
    const revision = requireNonNegativeInteger(projectedRevision, "projection.projectedRevision");
    if (revision > this.currentRevision) {
      throw new DomainInvariantError("CONFLICTING_COMPLETION", "cannot project a future revision");
    }
    const receiptRotated = this.externalProjectionId !== null &&
      this.externalProjectionId !== normalized;
    if (receiptRotated && revision < this.lastProjectedRevision) {
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "cannot rotate a live projection receipt from a stale revision",
      );
    }
    if (
      !receiptRotated &&
      this.externalProjectionId !== null &&
      revision <= this.lastProjectedRevision
    ) {
      return false;
    }

    // The projection key remains stable outside the aggregate. This is only a
    // physical receipt rotation after a deleted or otherwise stale Discord
    // reference. The caller persists this state transition with the aggregate
    // revision CAS, so a stale completion cannot overwrite a newer receipt.
    this.externalProjectionId = normalized;
    this.incrementRevision();
    this.lastProjectedRevision = this.currentRevision;
    return true;
  }

  public end(endedAtMs: number): boolean {
    const normalized = requireNonNegativeInteger(endedAtMs, "liveMeeting.endedAtMs");
    if (normalized < this.startedAtMs) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "meeting end cannot predate start");
    }
    if (this.currentStatus === "ended") {
      if (this.endedTimestampMs === normalized) {
        return false;
      }
      throw new DomainInvariantError(
        "CONFLICTING_COMPLETION",
        "live meeting ended with a different timestamp",
      );
    }
    this.currentStatus = "ended";
    this.endedTimestampMs = normalized;
    this.incrementRevision();
    return true;
  }

  public toSnapshot(): LiveMeetingSnapshot {
    return {
      draftSummary: this.summaryDraft,
      endedAtMs: this.endedTimestampMs,
      generationTelemetry: [...this.telemetryRecords],
      generationUsage: [...this.usageRecords],
      meetingId: this.meetingId,
      projectedRevision: this.lastProjectedRevision,
      projectionExternalId: this.externalProjectionId,
      publicationTargetId: this.publicationTargetId,
      revision: this.currentRevision,
      startedAtMs: this.startedAtMs,
      status: this.currentStatus,
      summarizedTurnIds: this.finalizedTurns
        .filter(({ turnId }) => this.summarizedTurnIdSet.has(turnId))
        .map(({ turnId }) => turnId),
      summaryGeneratedAtMs: this.summaryTimestampMs,
      turns: this.finalizedTurns.map((turn) => turn.toSnapshot()),
    };
  }

  private incrementRevision(): void {
    this.currentRevision += 1;
  }

  private incrementInvisibleRevision(): void {
    const projectionIsCurrent =
      this.externalProjectionId !== null && this.lastProjectedRevision === this.currentRevision;
    this.incrementRevision();
    if (projectionIsCurrent) {
      this.lastProjectedRevision = this.currentRevision;
    }
  }

  private appendGenerationUsage(input: LiveGenerationUsageSnapshot): boolean {
    const usage = validateUsage(input);
    const existing = this.usageRecords.find(({ runId }) => runId === usage.runId);
    if (existing !== undefined) {
      if (!sameUsage(existing, usage)) {
        throw new DomainInvariantError(
          "CONFLICTING_COMPLETION",
          "generation usage run was replayed with different values",
        );
      }
      return false;
    }
    this.usageRecords.push(usage);
    return true;
  }

  private appendGenerationTelemetry(input: LiveGenerationTelemetrySnapshot): boolean {
    const telemetry = validateTelemetry(input);
    const existing = this.telemetryRecords.find(({ runId }) => runId === telemetry.runId);
    if (existing !== undefined) {
      if (!sameTelemetry(existing, telemetry)) {
        throw new DomainInvariantError(
          "CONFLICTING_COMPLETION",
          "generation telemetry run was replayed with different values",
        );
      }
      return false;
    }
    this.telemetryRecords.push(telemetry);
    return true;
  }

  private validateLifecycle(): void {
    if (
      (this.currentStatus === "active" && this.endedTimestampMs !== null) ||
      (this.currentStatus === "ended" && this.endedTimestampMs === null)
    ) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live meeting status is inconsistent");
    }
    if (this.externalProjectionId === null && this.lastProjectedRevision !== 0) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live projection state is inconsistent");
    }
    const hasNoSummaryState =
      this.summaryDraft === null &&
      this.summaryTimestampMs === null &&
      this.summarizedTurnIdSet.size === 0;
    const hasCompleteSummaryState =
      this.summaryDraft !== null &&
      this.summaryTimestampMs !== null &&
      this.summarizedTurnIdSet.size > 0;
    if (!hasNoSummaryState && !hasCompleteSummaryState) {
      throw new DomainInvariantError("INVALID_SNAPSHOT", "live summary state is inconsistent");
    }
  }
}
