import { GroundedAnswer } from "../domain/grounded-answer.js";
import {
  admitGroundingRequest,
  exhaustiveCoverageProvesAbsence,
} from "../domain/grounding-plan.js";
import type {
  GroundedAnswerGenerationRequest,
  GroundedAnswerGenerator,
  GroundedAnswerMeasurement,
} from "./ports/final-reply.js";
import type { GroundingSafetyLimits } from "../domain/grounding-plan.js";

export type GroundedMeetingAnswerCheckpoint =
  | "continue"
  | "stale_authorization"
  | "stale_binding"
  | "stale_generation";

export type GroundedMeetingAnswerResult =
  | {
      readonly answer: GroundedAnswer;
      readonly measurement: GroundedAnswerMeasurement;
      readonly status: "completed";
    }
  | {
      readonly checkpoint: Exclude<GroundedMeetingAnswerCheckpoint, "continue">;
      readonly measurement: GroundedAnswerMeasurement;
      readonly status: "stopped";
    }
  | {
      readonly measurement: GroundedAnswerMeasurement;
      readonly status: "unsupported_size";
    }
  | {
      readonly code: string;
      readonly retryable: boolean;
      readonly status: "failed";
    }
  | { readonly status: "cancelled" }
  | { readonly status: "rejected" };

/**
 * The single provider-neutral generation use case shared by durable Discord
 * replies and live voice. Consumers prepare and authorize canonical evidence;
 * this class owns size admission, provider execution, cancellation fencing and
 * the final citation/quote validator.
 */
export class GroundedMeetingAnswer {
  public constructor(
    private readonly generator: GroundedAnswerGenerator,
    private readonly limits: GroundingSafetyLimits,
  ) {}

  public async execute(
    request: GroundedAnswerGenerationRequest,
    options: {
      readonly beforeGenerate?: (
        measurement: GroundedAnswerMeasurement,
      ) => Promise<GroundedMeetingAnswerCheckpoint>;
      readonly onMeasured?: (
        measurement: GroundedAnswerMeasurement,
      ) => Promise<GroundedMeetingAnswerCheckpoint>;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<GroundedMeetingAnswerResult> {
    if (signalWasAborted(options.signal)) {
      return { status: "cancelled" };
    }
    let measurement: GroundedAnswerMeasurement;
    try {
      measurement = await this.generator.measure(
        request,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      if (signalWasAborted(options.signal)) {
        return { status: "cancelled" };
      }
      return { code: "measurement_failed", retryable: false, status: "failed" };
    }
    if (options.onMeasured !== undefined) {
      const checkpoint = await options.onMeasured(measurement);
      if (checkpoint !== "continue") {
        return { checkpoint, measurement, status: "stopped" };
      }
    }
    if (admitGroundingRequest(measurement, this.limits).status === "unsupported_size") {
      return { measurement, status: "unsupported_size" };
    }
    if (request.plan.mode === "exhaustive_coverage" && options.beforeGenerate === undefined) {
      return { status: "rejected" };
    }
    if (options.beforeGenerate !== undefined) {
      const checkpoint = await options.beforeGenerate(measurement);
      if (checkpoint !== "continue") {
        return { checkpoint, measurement, status: "stopped" };
      }
    }
    if (signalWasAborted(options.signal)) {
      return { status: "cancelled" };
    }
    let generated;
    try {
      generated = await this.generator.generate(
        request,
        options.signal === undefined ? {} : { signal: options.signal },
      );
    } catch {
      if (signalWasAborted(options.signal)) {
        return { status: "cancelled" };
      }
      return { code: "generation_failed", retryable: true, status: "failed" };
    }
    if (signalWasAborted(options.signal)) {
      return { status: "cancelled" };
    }
    if (generated.status === "failed") {
      return generated;
    }
    try {
      return {
        answer: GroundedAnswer.create({
          candidate: generated.answer,
          evidence: request.plan.evidence,
          expectedLocale: request.locale,
          exhaustiveAbsenceProven: exhaustiveCoverageProvesAbsence(request.plan),
          groundingMode: request.plan.mode,
          question: request.question,
        }),
        measurement,
        status: "completed",
      };
    } catch {
      return { status: "rejected" };
    }
  }
}

function signalWasAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
