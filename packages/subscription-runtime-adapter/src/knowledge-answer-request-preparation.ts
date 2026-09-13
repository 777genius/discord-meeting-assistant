import { stableSubscriptionRuntimeId } from "./stable-id.js";
import { buildSubscriptionRuntimeKnowledgeAnswerRequest } from
  "./knowledge-answer-request-mapper.js";

export const knowledgeAnswerMaximumModelInputBytes = 16_000;

export interface KnowledgeAnswerExactInputMeasurement {
  readonly maximumModelInputBytes: number;
  readonly original: KnowledgeAnswerModelInputSurfaceMeasurement;
  readonly repair: KnowledgeAnswerModelInputSurfaceMeasurement;
}

export interface KnowledgeAnswerModelInputSurfaceMeasurement {
  /** Exact UTF-8 bytes of systemPrompt + LF + prompt + LF + output schema JSON. */
  readonly fullInputBytes: number;
  readonly outputSchemaBytes: number;
  readonly systemPromptBytes: number;
  readonly userPromptBytes: number;
}

type KnowledgeAnswerRuntimeRequest = ReturnType<
  typeof buildSubscriptionRuntimeKnowledgeAnswerRequest
>;

export function providerOutputRepairRequest(
  request: KnowledgeAnswerRuntimeRequest,
): KnowledgeAnswerRuntimeRequest {
  const runId = stableSubscriptionRuntimeId(
    "knowledge-answer-provider-output-repair",
    request.runId,
  );
  return {
    ...request,
    context: { ...request.context, correlationId: runId },
    runId,
    task: {
      ...request.task,
      systemPrompt: [
        request.task.systemPrompt,
        "A previous generation failed strict output validation. Regenerate once from the original supplied question and evidence and obey every schema bound exactly.",
        "In particular, claims=[] with status=answered is forbidden. Decide answerability before emitting claims: for an answerable question populate claims with at least one concise supported claim and its direct evidenceIds, then emit status=answered; otherwise keep claims=[] and emit insufficient_evidence or not_a_question.",
      ].join(" "),
    },
  };
}

export function knowledgeAnswerInputSurface(request: KnowledgeAnswerRuntimeRequest): string {
  return [
    request.task.systemPrompt,
    request.task.prompt,
    JSON.stringify(request.task.controls.outputSchema),
  ].join("\n");
}

export function measureKnowledgeAnswerModelInputs(
  request: KnowledgeAnswerRuntimeRequest,
): KnowledgeAnswerExactInputMeasurement {
  const original = measureInputSurface(request);
  const repair = measureInputSurface(providerOutputRepairRequest(request));
  return Object.freeze({
    maximumModelInputBytes: Math.max(original.fullInputBytes, repair.fullInputBytes),
    original,
    repair,
  });
}

export function assertKnowledgeAnswerInputBound(
  measurement: KnowledgeAnswerExactInputMeasurement,
): void {
  if (
    measurement.original.fullInputBytes > knowledgeAnswerMaximumModelInputBytes ||
    measurement.repair.fullInputBytes > knowledgeAnswerMaximumModelInputBytes
  ) {
    throw new Error("knowledge answer model input exceeds the qualified 16000-byte bound");
  }
}

function measureInputSurface(
  request: KnowledgeAnswerRuntimeRequest,
): KnowledgeAnswerModelInputSurfaceMeasurement {
  const encoder = new TextEncoder();
  const outputSchema = JSON.stringify(request.task.controls.outputSchema);
  return Object.freeze({
    fullInputBytes: encoder.encode(knowledgeAnswerInputSurface(request)).byteLength,
    outputSchemaBytes: encoder.encode(outputSchema).byteLength,
    systemPromptBytes: encoder.encode(request.task.systemPrompt).byteLength,
    userPromptBytes: encoder.encode(request.task.prompt).byteLength,
  });
}
