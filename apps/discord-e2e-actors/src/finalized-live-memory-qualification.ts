import { z } from "zod";

import { liveMemoryRowsOutputSchema } from "./ssh-deployment-probe-validation.js";

const coordinateSchema = z.object({
  endMs: z.number().int().positive(), meetingId: z.string().trim().min(1),
  observedAt: z.iso.datetime(), speakerId: z.string().trim().min(1),
  startMs: z.number().int().nonnegative(),
}).strict().refine(({ endMs, startMs }) => endMs > startMs);
const processSchema = z.object({
  containerId: z.string().trim().min(1), hostProcessId: z.number().int().positive(),
}).strict();

export const finalizedLiveMemoryQualificationV1Schema = z.object({
  backfill: z.object({ process: processSchema, rows: liveMemoryRowsOutputSchema }).strict(),
  botActorId: z.string().trim().min(1),
  campaignId: z.string().trim().min(1),
  final: z.object({ event: coordinateSchema, rows: liveMemoryRowsOutputSchema }).strict(),
  finalizedTurnId: z.string().trim().min(1),
  trustedHumanSpeakerId: z.string().trim().min(1),
  kind: z.literal("finalized-live-memory-qualification"),
  partial: z.object({ event: coordinateSchema, rows: liveMemoryRowsOutputSchema }).strict(),
  processBeforeRestart: processSchema,
  runId: z.string().trim().min(1),
  schemaVersion: z.literal(1),
}).strict().superRefine((proof, context) => {
  const fail = (message: string): void => {
    context.addIssue({ code: "custom", message });
  };
  if (JSON.stringify({ ...proof.partial.event, observedAt: undefined }) !==
    JSON.stringify({ ...proof.final.event, observedAt: undefined })) {
    fail("Partial and final memory observations must bind the same transcript coordinates");
  }
  const partialIds = proof.partial.rows.canonicalTurns.map(({ turnId }) => turnId);
  const finalIds = proof.final.rows.canonicalTurns.map(({ turnId }) => turnId);
  const added = finalIds.filter((turnId) => !partialIds.includes(turnId));
  const partialExcluded = [
    ...proof.partial.rows.canonicalTurns,
    ...proof.partial.rows.hotTail,
    ...proof.partial.rows.outbox,
  ].every(({ turnId }) => turnId !== proof.finalizedTurnId);
  if (Date.parse(proof.partial.rows.observedAt) < Date.parse(proof.partial.event.observedAt) ||
    Date.parse(proof.partial.rows.observedAt) >= Date.parse(proof.final.event.observedAt) ||
    added.length !== 1 || added[0] !== proof.finalizedTurnId || !partialExcluded) {
    fail("Partial query must exclude the later finalized turn from canonical, hot-tail, and outbox state");
  }
  const lifecycle = proof.final.rows.trustedLifecycle;
  const actorKinds = new Map(lifecycle.actors.map(({ actorId, kind }) => [actorId, kind]));
  const allRows = [proof.partial.rows, proof.final.rows, proof.backfill.rows];
  const allSurfaceTurns = allRows.flatMap((rows) => [
    ...rows.canonicalTurns, ...rows.hotTail, ...rows.outbox,
  ]);
  if (proof.final.event.speakerId !== proof.trustedHumanSpeakerId ||
    proof.partial.event.speakerId !== proof.trustedHumanSpeakerId ||
    actorKinds.get(proof.trustedHumanSpeakerId) !== "human" ||
    actorKinds.get(proof.botActorId) !== "automation" ||
    allRows.some((rows) => JSON.stringify(rows.trustedLifecycle) !== JSON.stringify(lifecycle)) ||
    allSurfaceTurns.some(({ speakerId }) =>
      speakerId === proof.botActorId ||
      actorKinds.get(speakerId) !== "human")) {
    fail("Finalized live-memory turn must belong to the retained trusted human roster");
  }
  const finalObserved = Date.parse(proof.final.rows.observedAt);
  if (finalObserved < Date.parse(proof.final.event.observedAt) ||
    finalObserved - Date.parse(proof.final.event.observedAt) > 5_000 ||
    !proof.final.rows.hotTail.some(({ turnId }) => turnId === proof.finalizedTurnId) ||
    !proof.final.rows.outbox.some(({ state, turnId }) => turnId === proof.finalizedTurnId && state === "applied")) {
    fail("Finalized turn must reach canonical, applied outbox, and hot tail within five seconds");
  }
  const before = proof.processBeforeRestart;
  const after = proof.backfill.process;
  if (before.hostProcessId === after.hostProcessId ||
    (before.containerId === after.containerId && before.hostProcessId === after.hostProcessId) ||
    !proof.backfill.rows.canonicalTurns.some(({ turnId }) => turnId === proof.finalizedTurnId) ||
    !proof.backfill.rows.hotTail.some(({ turnId }) => turnId === proof.finalizedTurnId)) {
    fail("Restart backfill must retain the same finalized canonical and hot-tail turn on a new worker");
  }
  const finalHot = proof.final.rows.hotTail.find(({ turnId }) => turnId === proof.finalizedTurnId);
  const backfillHot = proof.backfill.rows.hotTail.find(({ turnId }) => turnId === proof.finalizedTurnId);
  if (finalHot === undefined || backfillHot === undefined ||
    finalHot.turnHash !== backfillHot.turnHash ||
    finalHot.sourceGeneration !== backfillHot.sourceGeneration ||
    finalHot.identityGeneration !== backfillHot.identityGeneration ||
    finalHot.identityGeneration !== lifecycle.lifecycleGeneration) {
    fail("Restart backfill changed the finalized live-memory identity");
  }
});
