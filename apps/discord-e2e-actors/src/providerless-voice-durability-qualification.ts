import { createHash } from "node:crypto";

import { z } from "zod";

import { hostedCampaignReleaseReferenceV1Schema } from
  "./hosted-campaign-release-reference.js";

const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const safeNonnegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const contentSchema = z.object({
  backpressure: z.object({
    derivedPacketsDropped: z.number().int().positive(),
    events: z.number().int().positive(),
    peakQueuedPackets: z.number().int().positive().max(64),
  }).strict(),
  cancellation: z.object({
    activeGroundedTurnAborted: z.literal(true),
    activeStage: z.literal("generation"),
    abortSignalObserved: z.literal(true),
    factualPcmPacketsAfterAbort: z.literal(0),
    lateFactualPcmAttemptsRejected: z.literal(1),
    reason: z.literal("disconnected"),
  }).strict(),
  executionMode: z.literal("virtual-time-providerless"),
  finalizationOrder: z.tuple([
    z.literal("recording-authoritative-ready"),
    z.literal("transcript-finalized"),
    z.literal("summary-finalized"),
  ]),
  greeting: z.object({
    initialCount: z.literal(1),
    reconnectRepeatCount: z.literal(0),
  }).strict(),
  memory: z.object({
    maximumLiveTranscriptTurns: z.literal(256),
    maximumQueuedPackets: z.literal(64),
    peakBufferedBytes: z.number().int().positive(),
    peakLiveTranscriptTurns: z.literal(256),
  }).strict(),
  networkLatencyEvidence: z.literal("excluded-use-retained-live-campaign-measurements"),
  recording: z.object({
    authoritativePacketCount: z.number().int().positive(),
    generatedPacketCount: z.number().int().positive(),
    status: z.literal("authoritative-ready"),
  }).strict(),
  reconnect: z.object({
    count: z.literal(1),
    greetingAdmission: z.literal("reused"),
    recoveredAtVirtualMs: z.literal(3_600_500),
    startedAtVirtualMs: z.literal(3_600_000),
  }).strict(),
  release: hostedCampaignReleaseReferenceV1Schema,
  schemaVersion: z.literal(1),
  simulatedDurationMs: z.literal(7_200_000),
  sourceRevision: z.string().regex(/^(?:[a-f\d]{40}|[a-f\d]{64})$/u),
  summary: z.object({
    evidenceTurnIds: z.array(z.string().regex(/^turn-\d+$/u)).min(3),
    status: z.literal("finalized"),
  }).strict(),
  transcript: z.object({
    durableTurnCount: z.number().int().positive(),
    finalTurnEndMs: z.literal(7_200_000),
    status: z.literal("finalized"),
  }).strict(),
  transitionTrace: z.tuple([
    z.literal("0:recording:idle->recording"),
    z.literal("0:greeting:pending->played"),
    z.literal("3599980:grounded-answer:idle->generation"),
    z.literal("3600000:connection:connected->disconnected"),
    z.literal("3600000:grounded-answer:generation->aborted"),
    z.literal("3600500:connection:disconnected->connected"),
    z.literal("3600500:greeting:played->reused"),
    z.literal("7200000:recording:recording->authoritative-ready"),
    z.literal("7200000:transcript:live->finalized"),
    z.literal("7200000:summary:pending->finalized"),
  ]),
  virtualTransitions: safeNonnegative,
}).strict().superRefine((value, context) => {
  if (value.recording.generatedPacketCount !== value.recording.authoritativePacketCount) {
    context.addIssue({ code: "custom", message: "Authoritative recording lost generated packets" });
  }
  const turnIds = new Set(Array.from(
    { length: value.transcript.durableTurnCount },
    (_, index) => `turn-${index + 1}`,
  ));
  if (value.summary.evidenceTurnIds.some((turnId) => !turnIds.has(turnId))) {
    context.addIssue({ code: "custom", message: "Durability summary cites a missing transcript turn" });
  }
});

export const providerlessVoiceDurabilityQualificationV1Schema = contentSchema.extend({
  artifactSha256: sha256,
}).strict().superRefine((value, context) => {
  const { artifactSha256, ...content } = value;
  if (digestCanonical(content) !== artifactSha256) {
    context.addIssue({ code: "custom", message: "Durability qualification digest is invalid" });
  }
});

export type ProviderlessVoiceDurabilityQualificationV1 = z.infer<
  typeof providerlessVoiceDurabilityQualificationV1Schema
>;

const simulatedDurationMs = 2 * 60 * 60 * 1_000;
const packetIntervalMs = 20;
const maximumQueuedPackets = 64;
const maximumLiveTranscriptTurns = 256;
const packetBytes = 192;

/** Executes every transition against virtual time; it does not claim network latency. */
export function qualifyProviderlessVoiceDurability(input: {
  readonly release: z.input<typeof hostedCampaignReleaseReferenceV1Schema>;
  readonly sourceRevision: string;
}): ProviderlessVoiceDurabilityQualificationV1 {
  const release = hostedCampaignReleaseReferenceV1Schema.parse(input.release);
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/u.test(input.sourceRevision)) {
    throw new Error("Durability qualification requires an exact source revision");
  }
  const state = new DurabilityStateMachine();
  const liveQueue: number[] = [];
  const recentTurns: string[] = [];
  let recentTurnBytes = 0;
  let authoritativePacketCount = 0;
  let backpressureEvents = 0;
  let derivedPacketsDropped = 0;
  let peakQueuedPackets = 0;
  let peakLiveTranscriptTurns = 0;
  let peakBufferedBytes = 0;
  let durableTurnCount = 0;
  let transitions = 0;

  for (let virtualMs = 0; virtualMs < simulatedDurationMs; virtualMs += packetIntervalMs) {
    state.advance(virtualMs);
    authoritativePacketCount += 1;
    transitions += 1;
    // A deterministic 1.5 s derived-path stall every virtual minute forces
    // backpressure while the authoritative recorder continues losslessly.
    const derivedStalled = virtualMs % 60_000 < 1_500;
    if (liveQueue.length === maximumQueuedPackets) {
      derivedPacketsDropped += 1;
      backpressureEvents += 1;
    } else {
      liveQueue.push(virtualMs);
    }
    if (!derivedStalled) {
      liveQueue.splice(0, Math.min(2, liveQueue.length));
    }
    if ((virtualMs + packetIntervalMs) % 10_000 === 0) {
      durableTurnCount += 1;
      const turnId = `turn-${durableTurnCount}`;
      recentTurns.push(turnId);
      recentTurnBytes += turnId.length * 2;
      if (recentTurns.length > maximumLiveTranscriptTurns) {
        const removed = recentTurns.shift();
        if (removed !== undefined) {
          recentTurnBytes -= removed.length * 2;
        }
      }
      transitions += 1;
    }
    peakQueuedPackets = Math.max(peakQueuedPackets, liveQueue.length);
    peakLiveTranscriptTurns = Math.max(peakLiveTranscriptTurns, recentTurns.length);
    peakBufferedBytes = Math.max(
      peakBufferedBytes,
      liveQueue.length * packetBytes + recentTurnBytes,
    );
  }
  const generatedPacketCount = simulatedDurationMs / packetIntervalMs;
  const finalized = state.finalize({
    authoritativePacketCount,
    durableTurnCount,
    generatedPacketCount,
  });
  const content = {
    backpressure: {
      derivedPacketsDropped,
      events: backpressureEvents,
      peakQueuedPackets,
    },
    cancellation: {
      ...finalized.cancellation,
    },
    executionMode: "virtual-time-providerless" as const,
    finalizationOrder: finalized.finalizationOrder,
    greeting: finalized.greeting,
    memory: {
      maximumLiveTranscriptTurns: maximumLiveTranscriptTurns as 256,
      maximumQueuedPackets: maximumQueuedPackets as 64,
      peakBufferedBytes,
      peakLiveTranscriptTurns: peakLiveTranscriptTurns as 256,
    },
    networkLatencyEvidence: "excluded-use-retained-live-campaign-measurements" as const,
    recording: {
      authoritativePacketCount,
      generatedPacketCount,
      status: finalized.recordingStatus,
    },
    reconnect: finalized.reconnect,
    release,
    schemaVersion: 1 as const,
    simulatedDurationMs: simulatedDurationMs as 7_200_000,
    sourceRevision: input.sourceRevision,
    summary: {
      evidenceTurnIds: finalized.summaryEvidenceTurnIds,
      status: finalized.summaryStatus,
    },
    transcript: {
      durableTurnCount,
      finalTurnEndMs: simulatedDurationMs as 7_200_000,
      status: finalized.transcriptStatus,
    },
    transitionTrace: finalized.transitionTrace,
    virtualTransitions: transitions + finalized.transitionTrace.length,
  };
  return Object.freeze(providerlessVoiceDurabilityQualificationV1Schema.parse({
    ...content,
    artifactSha256: digestCanonical(content),
  }));
}

class DurabilityStateMachine {
  private activeGrounded: {
    readonly controller: AbortController;
    readonly stage: "generation";
  } | null = null;
  private connection: "connected" | "disconnected" = "connected";
  private factualPcmPacketsAfterAbort = 0;
  private lateFactualPcmAttemptsRejected = 0;
  private readonly greetedParticipants = new Set<string>();
  private recordingStatus: "idle" | "recording" | "authoritative-ready" = "idle";
  private reconnectCount = 0;
  private readonly trace: string[] = [];
  private transcriptStatus: "live" | "finalized" = "live";
  private summaryStatus: "pending" | "finalized" = "pending";

  public constructor() {
    this.recordingStatus = "recording";
    this.trace.push("0:recording:idle->recording");
    this.admitGreeting(0, false);
  }

  public advance(virtualMs: number): void {
    if (virtualMs === 3_599_980) {
      this.activeGrounded = {
        controller: new AbortController(),
        stage: "generation",
      };
      this.trace.push("3599980:grounded-answer:idle->generation");
      return;
    }
    if (virtualMs === 3_600_000) {
      this.disconnect(virtualMs);
      return;
    }
    if (virtualMs === 3_600_500) {
      this.reconnect(virtualMs);
    }
  }

  public finalize(input: {
    readonly authoritativePacketCount: number;
    readonly durableTurnCount: number;
    readonly generatedPacketCount: number;
  }) {
    if (this.connection !== "connected" || this.recordingStatus !== "recording" ||
      input.authoritativePacketCount !== input.generatedPacketCount ||
      input.durableTurnCount < 3 || this.factualPcmPacketsAfterAbort !== 0 ||
      this.lateFactualPcmAttemptsRejected !== 1) {
      throw new Error("Providerless durability state did not reach a safe finalization fence");
    }
    this.recordingStatus = "authoritative-ready";
    this.trace.push("7200000:recording:recording->authoritative-ready");
    this.transcriptStatus = "finalized";
    this.trace.push("7200000:transcript:live->finalized");
    const summaryEvidenceTurnIds = [
      "turn-1",
      `turn-${Math.floor(input.durableTurnCount / 2)}`,
      `turn-${input.durableTurnCount}`,
    ];
    const knownTurns = new Set(Array.from(
      { length: input.durableTurnCount },
      (_, index) => `turn-${index + 1}`,
    ));
    if (summaryEvidenceTurnIds.some((turnId) => !knownTurns.has(turnId))) {
      throw new Error("Summary finalized without a complete cited transcript");
    }
    this.summaryStatus = "finalized";
    this.trace.push("7200000:summary:pending->finalized");
    return Object.freeze({
      cancellation: Object.freeze({
        abortSignalObserved: true as const,
        activeGroundedTurnAborted: true as const,
        activeStage: "generation" as const,
        factualPcmPacketsAfterAbort: this.factualPcmPacketsAfterAbort,
        lateFactualPcmAttemptsRejected: this.lateFactualPcmAttemptsRejected,
        reason: "disconnected" as const,
      }),
      finalizationOrder: [
        "recording-authoritative-ready",
        "transcript-finalized",
        "summary-finalized",
      ] as const,
      greeting: Object.freeze({ initialCount: 1 as const, reconnectRepeatCount: 0 as const }),
      reconnect: Object.freeze({
        count: this.reconnectCount as 1,
        greetingAdmission: "reused" as const,
        recoveredAtVirtualMs: 3_600_500 as const,
        startedAtVirtualMs: 3_600_000 as const,
      }),
      recordingStatus: this.recordingStatus,
      summaryEvidenceTurnIds: Object.freeze(summaryEvidenceTurnIds),
      summaryStatus: this.summaryStatus,
      transcriptStatus: this.transcriptStatus,
      transitionTrace: Object.freeze([...this.trace]) as readonly [
        "0:recording:idle->recording",
        "0:greeting:pending->played",
        "3599980:grounded-answer:idle->generation",
        "3600000:connection:connected->disconnected",
        "3600000:grounded-answer:generation->aborted",
        "3600500:connection:disconnected->connected",
        "3600500:greeting:played->reused",
        "7200000:recording:recording->authoritative-ready",
        "7200000:transcript:live->finalized",
        "7200000:summary:pending->finalized",
      ],
    });
  }

  private admitGreeting(virtualMs: number, reconnect: boolean): "played" | "reused" {
    const participantId = "synthetic-participant-1";
    if (this.greetedParticipants.has(participantId)) {
      this.trace.push(`${virtualMs}:greeting:played->reused`);
      return "reused";
    }
    if (reconnect) {
      throw new Error("Reconnect admitted a greeting for an unknown participant");
    }
    this.greetedParticipants.add(participantId);
    this.trace.push(`${virtualMs}:greeting:pending->played`);
    return "played";
  }

  private disconnect(virtualMs: number): void {
    if (this.connection !== "connected" || this.activeGrounded === null) {
      throw new Error("Synthetic disconnect did not interrupt an active grounded turn");
    }
    this.connection = "disconnected";
    this.trace.push(`${virtualMs}:connection:connected->disconnected`);
    this.activeGrounded.controller.abort("disconnected");
    if (!this.activeGrounded.controller.signal.aborted) {
      throw new Error("Active grounded AbortSignal was not observed");
    }
    this.trace.push(`${virtualMs}:grounded-answer:generation->aborted`);
    this.attemptFactualPcm();
  }

  private reconnect(virtualMs: number): void {
    if (this.connection !== "disconnected") {
      throw new Error("Synthetic reconnect occurred without a disconnect");
    }
    this.connection = "connected";
    this.reconnectCount += 1;
    this.trace.push(`${virtualMs}:connection:disconnected->connected`);
    if (this.admitGreeting(virtualMs, true) !== "reused") {
      throw new Error("Synthetic reconnect repeated its greeting");
    }
  }

  private attemptFactualPcm(): void {
    if (this.activeGrounded?.controller.signal.aborted === true) {
      this.lateFactualPcmAttemptsRejected += 1;
      return;
    }
    this.factualPcmPacketsAfterAbort += 1;
  }
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
}
