import {
  DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
  HistoricalFocusedRetrieval,
  admitAcceptedFinalMeeting,
  createHistoricalReleaseBinding,
  type AcceptedFinalMeetingV1,
  type FocusedRetrievalPolicyV1,
  type HistoricalAppliedPlanV1,
  type HistoricalCandidateRecordV1,
  type HistoricalEvidenceAuthority,
  type HistoricalMemoryPort,
  type HistoricalOpaqueIdPort,
  type HistoricalReleaseBindingV1,
  type HistoricalSyncStore,
  type SpeakerAliasMapV1,
} from "@discord-meeting/meeting-core/meeting-knowledge";

export class TestIds implements HistoricalOpaqueIdPort {
  public keyedId(namespace: string, parts: readonly string[]): string {
    let hash = 0x811c9dc5;
    for (const character of `${namespace}:${parts.join("|")}`) {
      hash = Math.imul(
        hash ^ (character.codePointAt(0) ?? 0),
        0x01000193,
      ) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }
}

export const blockPolicy = Object.freeze({
  maxBlockUtf8Bytes: 512,
  maxBlocksPerMeeting: 100,
  maxTurnsPerBlock: 64,
  version: "meeting-knowledge.block-policy.v1",
} as const);

export const retrievalPolicy: FocusedRetrievalPolicyV1 = Object.freeze({
  blockPolicy,
  candidateLimitPerQuery: 8,
  maximumDecomposedQueries: 4,
  maximumEvidenceBytes: 16_000,
  maximumLocalScanBlocks: 512,
  minimumProviderScore: 0.01,
  neighborRadius: 1,
  rerankLimit: 5,
  searchTimeoutMs: 100,
  version: "meeting-knowledge.focused-retrieval.v1",
});

export function makeMeeting(input: {
  readonly authoritativeDurationMs?: number;
  readonly meetingId: string;
  readonly roomId?: string;
  readonly transcriptId?: string;
  readonly turns: readonly {
    readonly endMs: number;
    readonly speakerId?: string;
    readonly startMs: number;
    readonly text: string;
    readonly turnId: string;
  }[];
}): AcceptedFinalMeetingV1 {
  const binding = createHistoricalReleaseBinding({
    acceptedMeetingRevision: 4,
    desiredGeneration: 1,
    meetingId: input.meetingId,
    roomId: input.roomId ?? "room-1",
    scopeId: "scope-1",
    transcriptId: input.transcriptId ?? `transcript-${input.meetingId}`,
    transcriptVersion: 1,
  });
  const meeting = admitAcceptedFinalMeeting({
    actors: [...new Set(input.turns.map(({ speakerId }) =>
      speakerId ?? "speaker"
    ))].map((actorId) => ({ actorId, kind: "human" as const })),
    authoritativeDurationMs: input.authoritativeDurationMs ?? 60_000,
    binding,
    identityProvenance: {
      actorObservationState: "consistent",
      actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: "fixture-r1",
      rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingRevision: 4,
    roomId: binding.roomId,
    scopeId: binding.scopeId,
    transcriptId: binding.transcriptId,
    transcriptVersion: 1,
    turns: input.turns.map((turn) => ({
      ...turn,
      speakerId: turn.speakerId ?? "speaker",
    })),
  });
  if (meeting === null) {
    throw new Error("fixture admission failed");
  }
  return meeting;
}

export function twoBlockTurns(primary: string, primaryId: string) {
  return [
    { endMs: 1_000, startMs: 0,
      text: `${primary} ${"x".repeat(260)}`, turnId: primaryId },
    { endMs: 2_000, startMs: 1_000,
      text: `unrelated budget detail ${"y".repeat(260)}`,
      turnId: `${primaryId}-noise` },
  ];
}

export class AppliedStore implements HistoricalSyncStore {
  public candidateBatchReads = 0;
  public candidatePointReads = 0;
  public current = true;
  public currentSequence: boolean[] = [];

  public constructor(
    private readonly records: readonly HistoricalAppliedPlanV1[],
  ) {}

  public async acceptRelease(
    _binding: HistoricalReleaseBindingV1,
  ): Promise<"replayed"> {
    return "replayed";
  }

  public async enqueueAppliedProfileRebuilds() {
    return { enqueued: 0, remaining: false } as const;
  }
  public async claimNext(): Promise<null> { return null; }
  public async recordPlan(): Promise<void> {}
  public async recordApplied(): Promise<void> {}
  public async recordRetry(): Promise<void> {}
  public async recordDeadLetter(): Promise<void> {}
  public async recordDeleted(): Promise<void> {}
  public async requestMeetingDeletion(): Promise<void> {}

  public async findCurrentCandidate(
    scopeId: string,
    roomId: string,
    candidateLocator: string,
  ): Promise<HistoricalCandidateRecordV1 | null> {
    this.candidatePointReads += 1;
    for (const record of this.records) {
      if (
        record.binding.scopeId !== scopeId ||
        record.binding.roomId !== roomId
      ) {
        continue;
      }
      const document = record.plan.documents.find(({ manifest }) =>
        manifest.candidateLocator === candidateLocator
      );
      if (document !== undefined) {
        return { ...record, ordinal: document.manifest.ordinal };
      }
    }
    return null;
  }

  public async findCurrentCandidates(
    scopeId: string,
    roomId: string,
    candidateLocators: readonly string[],
  ): Promise<readonly HistoricalCandidateRecordV1[]> {
    this.candidateBatchReads += 1;
    const requested = new Set(candidateLocators);
    return this.records.flatMap((record) => {
      if (
        record.binding.scopeId !== scopeId ||
        record.binding.roomId !== roomId
      ) {
        return [];
      }
      return record.plan.documents.flatMap(({ manifest }) =>
        requested.has(manifest.candidateLocator)
          ? [{ ...record, ordinal: manifest.ordinal }]
          : []
      );
    });
  }

  public async listCurrentRoomPlans(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalAppliedPlanV1[]> {
    return this.records.filter(({ binding }) =>
      binding.scopeId === scopeId && binding.roomId === roomId
    );
  }

  public async listDesiredRoomBindings(
    scopeId: string,
    roomId: string,
  ): Promise<readonly HistoricalReleaseBindingV1[]> {
    return (await this.listCurrentRoomPlans(scopeId, roomId)).map(
      ({ binding }) => binding,
    );
  }

  public async isCurrentGeneration(
    _binding: HistoricalReleaseBindingV1,
    _indexGeneration: string,
  ): Promise<boolean> {
    return this.currentSequence.shift() ?? this.current;
  }
}

function authority(
  meetings: readonly AcceptedFinalMeetingV1[],
): HistoricalEvidenceAuthority {
  const byRelease = new Map(meetings.map((meeting) => [
    meeting.binding.releaseId,
    meeting,
  ]));
  return {
    loadAcceptedFinalMeeting: async (binding) =>
      byRelease.get(binding.releaseId) ?? null,
  };
}

export function retrieval(input: {
  readonly meetings: readonly AcceptedFinalMeetingV1[];
  readonly memory: HistoricalMemoryPort;
  readonly policy?: FocusedRetrievalPolicyV1;
  readonly speakerAliases?: SpeakerAliasMapV1;
  readonly store: AppliedStore;
  readonly twoHourEnabled?: boolean;
}) {
  return new HistoricalFocusedRetrieval({
    authority: authority(input.meetings),
    authorization: {
      authorize: async ({ authorizationPrincipalRef, roomId }) => ({
        authorizationDigest: `${authorizationPrincipalRef}:${roomId}:v1`,
        authorizationEpoch: "1",
        authorized: authorizationPrincipalRef === "principal" &&
          roomId === "room-1",
        policyVersion: "room-policy.v1",
      }),
    },
    ids: new TestIds(),
    memory: input.memory,
    ...(input.speakerAliases === undefined
      ? {}
      : { speakerAliases: input.speakerAliases }),
    store: input.store,
  }, input.policy ?? retrievalPolicy, {
    ...DEFAULT_TWO_HOUR_HISTORICAL_RETRIEVAL_PROFILE,
    qualification: input.twoHourEnabled === true
      ? {
          evidenceSha256: "e".repeat(64),
          releaseRevision: "f".repeat(40),
          rolloutEpoch: "test-r1",
          schemaVersion: 1,
        }
      : null,
  });
}
