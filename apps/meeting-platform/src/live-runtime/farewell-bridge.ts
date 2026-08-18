import { MeetingFarewellPolicy } from "@discord-meeting/meeting-core/conversation";

import type {
  LiveConversationConfiguration,
  LiveFarewellClassificationInput,
  LiveFarewellTurn,
  LiveRuntimeLogger,
  LiveTranscriptionEvent,
} from "./contracts.js";
import { FarewellPlaybackAttempts } from "./farewell-playback-attempts.js";

const fastPathFenceMs = 100;
const maximumContextTurns = 5;

interface FarewellBridgeDependencies {
  readonly configuration: LiveConversationConfiguration;
  readonly isMeetingFinishing: () => boolean;
  readonly logger: LiveRuntimeLogger;
  readonly meetingId: string;
}

interface PendingFastPath {
  readonly dueAtMs: number;
  readonly evidenceTurnIds: readonly string[];
  readonly locale: "en" | "ru";
  readonly reason: string;
  readonly revision: number;
}

/** Meeting-local farewell policy with a 100 ms continuation fence. */
export class FarewellBridge {
  private classificationPromise: Promise<void> | null = null;
  private closed = false;
  private readonly contextTurns: LiveFarewellTurn[] = [];
  private pendingFastPath: PendingFastPath | null = null;
  private readonly policy = new MeetingFarewellPolicy();
  private readonly playback: FarewellPlaybackAttempts;
  private readonly presentParticipantIds = new Set<string>();
  private queuedReview: LiveFarewellClassificationInput | null = null;
  private revision = 0;
  private readonly tasks = new Set<Promise<void>>();

  public constructor(private readonly dependencies: FarewellBridgeDependencies) {
    this.playback = new FarewellPlaybackAttempts({
      ...dependencies,
      isClosed: () => this.closed,
      policy: this.policy,
    });
  }

  public participantsPresent(participantIds: readonly string[]): void {
    for (const participantId of participantIds) {
      this.presentParticipantIds.add(participantId);
    }
  }

  public participantJoined(participantId: string): void {
    if (!this.closed && !this.presentParticipantIds.has(participantId)) {
      this.presentParticipantIds.add(participantId);
      this.bumpRevision();
    }
  }

  public participantLeft(participantId: string): void {
    // Leaving immediately after a farewell must not invalidate that farewell.
    // New speech and new arrivals still fence a pending decision.
    this.presentParticipantIds.delete(participantId);
  }

  /** Returns the context revision that belongs to this STT observation. */
  public observeSpeech(_event: LiveTranscriptionEvent): number {
    this.bumpRevision();
    return this.revision;
  }

  public observeFinalizedTurn(
    event: LiveTranscriptionEvent,
    turnId: string,
    observedRevision: number,
  ): void {
    if (this.closed || this.dependencies.isMeetingFinishing()) {
      return;
    }
    const turn = Object.freeze({
      endMs: event.endMs,
      speakerId: event.speakerId,
      startMs: event.startMs,
      text: event.text,
      turnId,
    });
    this.contextTurns.push(turn);
    while (this.contextTurns.length > maximumContextTurns) {
      this.contextTurns.shift();
    }
    const decision = this.policy.observe({
      endMs: event.endMs,
      presentParticipantCount: this.presentParticipantIds.size,
      speakerId: event.speakerId,
      text: event.text,
      turnId,
    });
    if (observedRevision !== this.revision) {
      return;
    }
    if (decision.status === "trigger") {
      this.pendingFastPath = {
        dueAtMs: this.nowMilliseconds() + fastPathFenceMs,
        evidenceTurnIds: decision.evidenceTurnIds,
        locale: decision.locale,
        reason: decision.reason,
        revision: observedRevision,
      };
      return;
    }
    if (
      decision.status === "review" &&
      this.dependencies.configuration.farewells?.classifier !== undefined
    ) {
      this.queueClassification(observedRevision);
    }
  }

  public advance(): void {
    const pending = this.pendingFastPath;
    if (
      pending === null ||
      pending.dueAtMs > this.nowMilliseconds() ||
      pending.revision !== this.revision
    ) {
      return;
    }
    this.pendingFastPath = null;
    this.track(this.playback.play(
      pending.locale,
      pending.reason,
      pending.evidenceTurnIds,
    ));
  }

  public close(): void {
    this.closed = true;
    this.pendingFastPath = null;
    this.queuedReview = null;
    this.presentParticipantIds.clear();
  }

  public async settle(): Promise<void> {
    while (this.classificationPromise !== null || this.tasks.size > 0) {
      await Promise.all([
        ...(this.classificationPromise === null ? [] : [this.classificationPromise]),
        ...this.tasks,
      ]);
    }
  }

  private bumpRevision(): void {
    if (this.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error("Farewell context revision exhausted");
    }
    this.revision += 1;
    this.pendingFastPath = null;
  }

  private queueClassification(revision: number): void {
    const farewells = this.dependencies.configuration.farewells;
    if (farewells?.classifier === undefined) {
      return;
    }
    const input: LiveFarewellClassificationInput = Object.freeze({
      meetingId: this.dependencies.meetingId,
      participantIds: Object.freeze([...this.presentParticipantIds].toSorted()),
      participantNames: farewells.participantNames,
      revision,
      turns: Object.freeze([...this.contextTurns]),
    });
    if (this.classificationPromise !== null) {
      this.queuedReview = input;
      return;
    }
    this.startClassification(input);
  }

  private startClassification(input: LiveFarewellClassificationInput): void {
    const classifier = this.dependencies.configuration.farewells?.classifier;
    if (classifier === undefined) {
      return;
    }
    let running!: Promise<void>;
    running = (async () => {
      let outcome: Awaited<ReturnType<typeof classifier.classify>>;
      try {
        outcome = await classifier.classify(input);
      } catch (error) {
        this.dependencies.logger.warn("Farewell classification failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          meetingId: this.dependencies.meetingId,
        });
        return;
      }
      if (
        outcome !== "reject" &&
        !this.closed &&
        !this.dependencies.isMeetingFinishing() &&
        input.revision === this.revision
      ) {
        await this.playback.play(
          outcome,
          "semantic",
          [input.turns.at(-1)?.turnId].filter(
            (turnId): turnId is string => turnId !== undefined,
          ),
        );
      }
    })().finally(() => {
      if (this.classificationPromise === running) {
        this.classificationPromise = null;
      }
      const queued = this.queuedReview;
      this.queuedReview = null;
      if (
        queued !== null &&
        queued.revision === this.revision &&
        !this.closed
      ) {
        this.startClassification(queued);
      }
    });
    this.classificationPromise = running;
  }

  private track(task: Promise<void>): void {
    let guarded!: Promise<void>;
    guarded = task.catch((error: unknown) => {
      this.dependencies.logger.warn("Meeting farewell task failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
        meetingId: this.dependencies.meetingId,
      });
    }).finally(() => {
      this.tasks.delete(guarded);
    });
    this.tasks.add(guarded);
  }

  private nowMilliseconds(): number {
    const value = Math.floor(this.dependencies.configuration.nowMilliseconds());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Farewell observation clock must be a non-negative integer");
    }
    return value;
  }
}
