import { createHash } from "node:crypto";
import { z } from "zod";

export const POST_CALL_QUEUE_NAME = "meeting-post-call-v1";
export const POST_CALL_JOB_NAME = "process-post-call-v1";
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

export function postCallJobId(meetingId: string): string {
  const validatedMeetingId = meetingIdSchema.parse(meetingId);
  return `post-call-v1-${namespacedDigest("post-call-job-v1", validatedMeetingId)}`;
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
