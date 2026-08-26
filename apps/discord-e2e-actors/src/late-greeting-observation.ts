import { createHash } from "node:crypto";
import type { Readable } from "node:stream";

import { z } from "zod";

import type { ConversationVoiceAudibilityDecoder } from "./conversation-voice-audibility-decoder.js";
import { greetingLedgerQualificationV1Schema } from "./greeting-ledger-qualification.js";
import { readStablePrivateJsonText } from "./compile-hosted-campaign-plan.js";

const TWENTY_MINUTES_MS = 20 * 60_000;
const POST_RESTART_QUIET_MS = 60_000;
const workerIdentitySchema = z.object({
  containerId: z.string().regex(/^[a-f\d]{64}$/u),
  hostProcessId: z.number().int().positive(),
}).strict();

export async function waitForStableGreetingLedger(path: string, timeoutMilliseconds: number): Promise<string> {
  const deadline = Date.now() + timeoutMilliseconds;
  for (;;) {
    try { return await readStablePrivateJsonText(path); }
    catch (error: unknown) {
      if (Date.now() >= deadline) { throw error; }
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
}

export const lateGreetingObservationV1Schema = z.object({
  campaignId: z.string().trim().min(1),
  endedAt: z.iso.datetime(),
  greetingLedgerSha256: z.string().regex(/^[a-f\d]{64}$/u),
  kind: z.literal("late-greeting-negative-observation"),
  lateAudiblePacketCount: z.literal(0),
  meetingId: z.string().trim().min(1),
  method: z.literal("continuous-craig-opus-subscription"),
  postRestartQuietMilliseconds: z.number().int().min(POST_RESTART_QUIET_MS),
  restart: z.object({
    after: workerIdentitySchema,
    before: workerIdentitySchema,
    completedAt: z.iso.datetime(),
    requestedAt: z.iso.datetime(),
  }).strict(),
  runId: z.string().trim().min(1),
  schemaVersion: z.literal(1),
  settlementCompletedAt: z.iso.datetime(),
  subscriptionStartedAt: z.iso.datetime(),
}).strict().superRefine((proof, context) => {
  const settlementWindowEnd = Date.parse(proof.settlementCompletedAt) + TWENTY_MINUTES_MS;
  if (Date.parse(proof.subscriptionStartedAt) > Date.parse(proof.settlementCompletedAt) ||
    Date.parse(proof.endedAt) - Date.parse(proof.settlementCompletedAt) < TWENTY_MINUTES_MS ||
    Date.parse(proof.endedAt) - Date.parse(proof.restart.completedAt) <
      proof.postRestartQuietMilliseconds ||
    proof.restart.before.hostProcessId === proof.restart.after.hostProcessId ||
    Date.parse(proof.restart.requestedAt) < Date.parse(proof.subscriptionStartedAt) ||
    Date.parse(proof.restart.completedAt) < Date.parse(proof.restart.requestedAt) ||
    Date.parse(proof.restart.requestedAt) > settlementWindowEnd ||
    Date.parse(proof.restart.completedAt) > settlementWindowEnd) {
    context.addIssue({
      code: "custom",
      message: "Greeting audio subscription must continuously span settlement and twenty quiet minutes",
    });
  }
});

export async function observeNoLateGreeting(input: Readonly<{
  decoder: ConversationVoiceAudibilityDecoder;
  greetingLedgerBytes: string;
  sourceStream: Readable;
  subscriptionStartedAt: string;
}>, ports: Readonly<{
  now: () => number;
  restartMeetingPlatform: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
  workerIdentity: () => Promise<{ readonly containerId: string; readonly hostProcessId: number }>;
}>) {
  const ledger = greetingLedgerQualificationV1Schema.parse(JSON.parse(input.greetingLedgerBytes));
  const settlement = Date.parse(ledger.settlementObservedAt);
  let lateAudiblePacketCount = 0;
  const onData = (packet: Buffer): void => {
    if (input.decoder.isPacketAudible(packet)) { lateAudiblePacketCount += 1; }
  };
  const streamState = { ended: false };
  const onEnd = (): void => { streamState.ended = true; };
  input.sourceStream.on("data", onData);
  input.sourceStream.once("end", onEnd);
  input.sourceStream.once("close", onEnd);
  let restart: {
    readonly after: { readonly containerId: string; readonly hostProcessId: number };
    readonly before: { readonly containerId: string; readonly hostProcessId: number };
    readonly completedAt: string;
    readonly requestedAt: string;
  };
  try {
    const before = await ports.workerIdentity();
    const requestedAt = new Date(ports.now()).toISOString();
    await ports.restartMeetingPlatform();
    let after = await ports.workerIdentity();
    while (after.hostProcessId === before.hostProcessId) {
      await ports.wait(250);
      after = await ports.workerIdentity();
    }
    const completedAt = new Date(ports.now()).toISOString();
    restart = { after, before, completedAt, requestedAt };
    const remaining = Math.max(
      0,
      settlement + TWENTY_MINUTES_MS - ports.now(),
      Date.parse(completedAt) + POST_RESTART_QUIET_MS - ports.now(),
    );
    await ports.wait(remaining);
  } finally {
    input.sourceStream.off("data", onData);
    input.sourceStream.off("end", onEnd);
    input.sourceStream.off("close", onEnd);
  }
  if (streamState.ended || lateAudiblePacketCount !== 0) {
    throw new Error("Late greeting observation saw audio or lost its continuous Craig subscription");
  }
  return lateGreetingObservationV1Schema.parse({
    campaignId: ledger.campaignId,
    endedAt: new Date(ports.now()).toISOString(),
    greetingLedgerSha256: createHash("sha256").update(input.greetingLedgerBytes, "utf8").digest("hex"),
    kind: "late-greeting-negative-observation",
    lateAudiblePacketCount: 0,
    meetingId: ledger.meetingId,
    method: "continuous-craig-opus-subscription",
    postRestartQuietMilliseconds: POST_RESTART_QUIET_MS,
    restart,
    runId: ledger.runId,
    schemaVersion: 1,
    settlementCompletedAt: ledger.settlementObservedAt,
    subscriptionStartedAt: input.subscriptionStartedAt,
  });
}
