import { createHash } from "node:crypto";
import { z } from "zod";
import { digest, id, revision, time } from "./oss-campaign-profile.js";
import { requireEvidence as check } from "./oss-campaign-artifacts.js";
const base = { index: time.positive(), atMs: time };
const startSchema = z.object({ ...base, type: z.literal("capture_start"),
  kind: z.literal("oss-native-post-call-v1"), revision }).strict();
const sealSchema = z.object({ ...base, type: z.literal("capture_seal"), priorSha256: digest }).strict();
const eventSchema = z.object({ ...base, type: z.enum(["started", "succeeded", "failed", "threw"]),
  stage: z.enum(["transcription", "summary", "publication"]), meetingId: id, attempt: time.positive() }).strict();

/** Native port invocation collection, retaining every attempt, never replaying it. */
export function collectNativePostCall(bytes: Buffer, expectedRevision: string) {
  check(bytes.length > 0 && bytes.length <= 1024 * 1024 && bytes.at(-1) === 10,
    "Missing, oversized or truncated native post-call journal");
  const lines = bytes.toString("utf8").split("\n"); lines.pop();
  check(lines.length >= 2, "Native post-call header/seal missing");
  const parse = (line: string) => {
    check(Buffer.byteLength(line) <= 4096, "Native post-call row oversized");
    return JSON.parse(line) as unknown;
  };
  const start = startSchema.parse(parse(lines[0]!));
  const seal = sealSchema.parse(parse(lines.at(-1)!));
  check(start.index === 1 && start.revision === expectedRevision && seal.index === lines.length,
    "Native post-call identity mismatch");
  check(createHash("sha256").update(bytes.subarray(0,
    bytes.length - Buffer.byteLength(lines.at(-1)!) - 1)).digest("hex") === seal.priorSha256,
  "Native post-call integrity mismatch");
  let atMs = start.atMs;
  const events = lines.slice(1, -1).map((line, index) => {
    const event = eventSchema.parse(parse(line));
    check(event.index === index + 2 && event.atMs >= atMs && event.atMs <= seal.atMs,
      "Native post-call sequence/time gap");
    atMs = event.atMs;
    return event;
  });
  check(seal.atMs >= atMs, "Native post-call seal precedes events");
  return { start, seal, events };
}

export function qualifyNativePostCall(
  capture: ReturnType<typeof collectNativePostCall>, meetingId: string,
) {
  const events = capture.events.filter((event) => event.meetingId === meetingId);
  check(events.length === 6, "Native post-call requires exactly one complete attempt per stage");
  return (["transcription", "summary", "publication"] as const).map((stage, index) => {
    const start = events[index * 2]!, end = events[index * 2 + 1]!;
    check(start.stage === stage && end.stage === stage && start.type === "started" &&
      end.type === "succeeded" && start.attempt === end.attempt && end.atMs >= start.atMs &&
      (index === 0 || start.attempt > events[(index - 1) * 2]!.attempt),
    "Native post-call failed, reused, or unordered stage");
    return { stage, status: "succeeded" as const, startedAtMs: start.atMs, completedAtMs: end.atMs };
  });
}
