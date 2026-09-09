import { expect, it } from "vitest";
import { runSchema, turnSchema, wireSchema } from "../src/oss-campaign-profile.js";

const authoritativeFields = [
  runSchema.shape.transcript.shape.transcriptId,
  runSchema.shape.transcript.shape.turns.element.shape.turnId,
  runSchema.shape.summary.shape.transcriptId,
  runSchema.shape.settled.element.shape.transcriptIds.element,
];

it.each([1, 256, 257, 598, 601, 4097])("preserves authoritative identities of length %s", (length) => {
  const value = "x".repeat(length);
  for (const field of authoritativeFields) { expect(field.parse(value)).toBe(value); }
});

it("rejects empty and non-string authoritative identities without transforming accepted bytes", () => {
  for (const field of authoritativeFields) {
    for (const value of ["", null, undefined, 598, {}]) {
      expect(field.safeParse(value).success).toBe(false);
    }
    expect(field.parse(" opaque:identity ")).toBe(" opaque:identity ");
  }
});

it("retains generic and live ID boundaries, including native snapshots and wire events", () => {
  const genericFields = [
    runSchema.shape.meetingId, runSchema.shape.recordingId,
    runSchema.shape.transcript.shape.version,
    runSchema.shape.transcript.shape.turns.element.shape.speakerId,
    runSchema.shape.liveTurns.element.shape.turnId, turnSchema.shape.turnId,
  ];
  for (const field of genericFields) {
    expect(field.safeParse("x".repeat(256)).success).toBe(true);
    expect(field.safeParse("x".repeat(257)).success).toBe(false);
  }
  const eventSchema = wireSchema.shape.events.element;
  for (const type of ["partial", "final"]) {
    const event = { type, atMs: 0, turn: {
      turnId: "x".repeat(256), speakerId: "speaker", startMs: 0, endMs: 1, text: "text",
    } };
    expect(eventSchema.safeParse(event).success).toBe(true);
    event.turn.turnId += "x";
    expect(eventSchema.safeParse(event).success).toBe(false);
  }
});
