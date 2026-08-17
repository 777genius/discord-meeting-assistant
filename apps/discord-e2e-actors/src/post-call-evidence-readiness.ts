import { z } from "zod";

import type { DatabaseObservation } from "./e2e-retained-evidence-contracts.js";

const identifier = z.string().trim().min(1);
const failure = z.object({
  code: identifier,
  message: identifier,
  retryable: z.boolean(),
}).strict();
const stage = z.discriminatedUnion("status", [
  z.object({ attempts: z.literal(0), status: z.literal("pending") }).strict(),
  z.object({ attempts: z.number().int().positive(), status: z.literal("running") }).strict(),
  z.object({
    attempts: z.number().int().positive(),
    failure,
    status: z.literal("failed"),
  }).strict(),
  z.object({ attempts: z.number().int().positive(), status: z.literal("succeeded") }).strict(),
]);
const readinessSnapshot = z.object({
  meetingId: identifier,
  publicationStage: stage,
  recording: z.object({ recordingId: identifier }).loose(),
  summaryStage: stage,
  transcriptionStage: stage,
}).loose();

const defaultMaximumAttempts = 241;
const defaultRetryDelayMilliseconds = 5_000;

export interface PostCallEvidenceReadinessOptions {
  readonly maximumAttempts?: number;
  readonly retryDelayMilliseconds?: number;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export async function awaitTerminalPostCallEvidence(
  collect: () => Promise<DatabaseObservation>,
  expectedRecordingId: string,
  options: PostCallEvidenceReadinessOptions = {},
): Promise<DatabaseObservation> {
  const maximumAttempts = positiveInteger(
    options.maximumAttempts ?? defaultMaximumAttempts,
    "maximumAttempts",
  );
  const retryDelayMilliseconds = positiveInteger(
    options.retryDelayMilliseconds ?? defaultRetryDelayMilliseconds,
    "retryDelayMilliseconds",
  );
  const wait = options.wait ?? waitFor;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const observation = await collect();
    assertUnambiguousIdentity(observation);
    const snapshot = readinessSnapshot.parse(observation.snapshot);
    if (snapshot.recording.recordingId !== expectedRecordingId) {
      throw new Error("Post-call readiness snapshot is correlated to a different recording");
    }
    assertValidStageOrder(snapshot);
    const stages = [
      ["transcription", snapshot.transcriptionStage],
      ["summary", snapshot.summaryStage],
      ["publication", snapshot.publicationStage],
    ] as const;
    for (const [name, value] of stages) {
      if (value.status === "failed" && !value.failure.retryable) {
        throw new Error("Post-call " + name + " failed terminally: " + value.failure.code);
      }
    }
    if (stages.every(([, value]) => value.status === "succeeded")) {
      return observation;
    }
    if (attempt < maximumAttempts) {
      await wait(retryDelayMilliseconds);
    }
  }
  throw new Error("Post-call evidence did not become terminal within the bounded readiness window");
}

function assertUnambiguousIdentity(observation: DatabaseObservation): void {
  if (
    observation.matchingMeetingCount !== 1 ||
    observation.matchingRecordingCount !== 1 ||
    observation.matchingSummaryCount > 1 ||
    observation.matchingTranscriptCount > 1
  ) {
    throw new Error("Post-call readiness requires one unambiguous meeting and recording");
  }
}

function assertValidStageOrder(snapshot: z.infer<typeof readinessSnapshot>): void {
  if (
    snapshot.transcriptionStage.status !== "succeeded" &&
    snapshot.summaryStage.status !== "pending"
  ) {
    throw new Error("Post-call readiness observed summary before successful transcription");
  }
  if (
    snapshot.summaryStage.status !== "succeeded" &&
    snapshot.publicationStage.status !== "pending"
  ) {
    throw new Error("Post-call readiness observed publication before successful summary");
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(name + " must be a positive safe integer");
  }
  return value;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
