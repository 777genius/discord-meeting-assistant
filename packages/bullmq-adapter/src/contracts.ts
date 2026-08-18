import { createHash } from "node:crypto";
import { z } from "zod";

// V2 isolates binding-aware workers from pre-binding V1 consumers during a
// rolling deployment. Durable outbox reconciliation safely re-enqueues any
// unfinished V1 work into this queue.
export const POST_CALL_QUEUE_NAME = "meeting-post-call-v2";
export const POST_CALL_JOB_NAME = "process-post-call-v2";
export const POST_CALL_JOB_ID_NAMESPACE = "post-call-job-v2";
export const POST_CALL_JOB_ID_PREFIX = "post-call-v2-";
export const POST_CALL_DEAD_LETTER_QUEUE_NAME = "meeting-post-call-dead-letter-v1";
export const POST_CALL_DEAD_LETTER_JOB_NAME = "record-post-call-dead-letter-v1";

const meetingIdSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim(), {
    message: "meetingId must not have leading or trailing whitespace",
  });

export const postCallJobPayloadSchema = z
  .object({
    meetingId: meetingIdSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .readonly();

export type PostCallJobPayload = z.infer<typeof postCallJobPayloadSchema>;

const postCallEnqueueRequestSchema = z.object({
  meetingId: meetingIdSchema,
  recoveryGeneration: z.number().int().nonnegative(),
  schemaVersion: z.literal(1),
}).strict().readonly();

export type PostCallEnqueueRequest = z.infer<typeof postCallEnqueueRequestSchema>;

const failureCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/u);

export const postCallDeadLetterRecordSchema = z
  .object({
    attemptsMade: z.number().int().positive(),
    failureCode: failureCodeSchema,
    meetingId: meetingIdSchema.nullable(),
    retryable: z.boolean(),
    schemaVersion: z.literal(1),
    sourceJobRef: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict()
  .readonly();

export type PostCallDeadLetterRecord = z.infer<
  typeof postCallDeadLetterRecordSchema
>;

export function parsePostCallJobPayload(value: unknown): PostCallJobPayload {
  return postCallJobPayloadSchema.parse(value);
}

export function parsePostCallEnqueueRequest(value: unknown): PostCallEnqueueRequest {
  const initialRequest = postCallJobPayloadSchema.safeParse(value);
  if (initialRequest.success) {
    return Object.freeze({
      ...initialRequest.data,
      recoveryGeneration: 0,
    });
  }
  return postCallEnqueueRequestSchema.parse(value);
}

export function parsePostCallDeadLetterRecord(
  value: unknown,
): PostCallDeadLetterRecord {
  return postCallDeadLetterRecordSchema.parse(value);
}

export function parsePostCallFailureCode(value: unknown): string {
  return failureCodeSchema.parse(value);
}

function namespacedDigest(namespace: string, value: string): string {
  return createHash("sha256")
    .update(namespace, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function postCallJobId(meetingId: string, recoveryGeneration = 0): string {
  const validatedMeetingId = meetingIdSchema.parse(meetingId);
  const validatedGeneration = z.number().int().nonnegative().parse(
    recoveryGeneration,
  );
  if (validatedGeneration > 0) {
    return `post-call-v2-${namespacedDigest(
      "post-call-recovery-job-v2",
      `${validatedGeneration}\0${validatedMeetingId}`,
    )}`;
  }
  return `${POST_CALL_JOB_ID_PREFIX}${namespacedDigest(
    POST_CALL_JOB_ID_NAMESPACE,
    validatedMeetingId,
  )}`;
}

export function postCallJobReference(jobId: string | undefined): string {
  return namespacedDigest("post-call-job-reference-v1", jobId ?? "missing");
}

export function postCallDeadLetterJobId(sourceJobRef: string): string {
  const validatedReference = z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(sourceJobRef);
  return `post-call-dead-v1-${namespacedDigest(
    "post-call-dead-letter-v1",
    validatedReference,
  )}`;
}
