import { createHash } from "node:crypto";

import { z } from "zod";

import { conversationVoiceCampaignProofV1Schema } from "./conversation-voice-campaign-proof.js";
import { conversationVoiceEvidenceV3Schema } from "./conversation-retained-evidence-schema.js";
import { HOSTED_CAMPAIGN_TARGET } from "./hosted-campaign-target.js";

const sha256 = z.string().regex(/^[a-f\d]{64}$/u);
const identifier = z.string().trim().min(1).max(1_024);
export const OFFICIAL_GREETING_TEST_IDENTITIES = Object.freeze([
  HOSTED_CAMPAIGN_TARGET.observerApplicationId,
  HOSTED_CAMPAIGN_TARGET.speakerAApplicationId,
  HOSTED_CAMPAIGN_TARGET.speakerBApplicationId,
  HOSTED_CAMPAIGN_TARGET.speakerDApplicationId,
] as const);

export const greetingLedgerRowV1Schema = z.object({
  completedAt: z.iso.datetime(),
  cueKind: z.literal("greeting"),
  receiptId: sha256,
  state: z.literal("played"),
}).strict();

export const greetingLedgerQualificationV1Schema = z.object({
  campaignId: identifier,
  governedMaximumFirstAudioLatencyMilliseconds: z.literal(1_000),
  kind: z.literal("greeting-ledger-qualification"),
  meetingId: identifier,
  participants: z.array(z.object({
    capture: z.object({
      attemptId: identifier,
      firstAudioLatencyMilliseconds: z.number().int().min(0).max(1_000),
      firstPacketAtEpochMilliseconds: z.number().int().nonnegative(),
      packetCount: z.number().int().positive(),
      pcmSha256: sha256,
      turnId: identifier,
    }).strict(),
    dispatch: z.object({
      greetingLocale: z.enum(["en", "ru"]),
      observedAt: z.iso.datetime(),
      turnId: identifier,
    }).strict(),
    join: z.object({
      observedAt: z.iso.datetime(),
      occurredAt: z.iso.datetime(),
    }).strict(),
    ledger: greetingLedgerRowV1Schema,
    participantId: identifier,
  }).strict()).length(OFFICIAL_GREETING_TEST_IDENTITIES.length),
  runId: identifier,
  schemaVersion: z.literal(1),
  settlementObservedAt: z.iso.datetime(),
}).strict().superRefine((proof, context) => {
  const expected = [...OFFICIAL_GREETING_TEST_IDENTITIES];
  if (JSON.stringify(proof.participants.map(({ participantId }) => participantId)) !==
    JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "Greeting ledger proof must retain every official identity in capture order" });
  }
  if (JSON.stringify(proof.participants.map(({ dispatch }) => dispatch.greetingLocale)) !==
    JSON.stringify(["ru", "ru", "en", "ru"])) {
    context.addIssue({ code: "custom", message: "Greeting dispatches must retain the pinned RU/RU/EN/RU locale sequence" });
  }
  for (const [index, participant] of proof.participants.entries()) {
    const joinedAt = Date.parse(participant.join.occurredAt);
    const joinObservedAt = Date.parse(participant.join.observedAt);
    const dispatchedAt = Date.parse(participant.dispatch.observedAt);
    const firstPacketAt = participant.capture.firstPacketAtEpochMilliseconds;
    const previousFirstPacketAt = proof.participants[index - 1]?.capture.firstPacketAtEpochMilliseconds;
    if (participant.ledger.receiptId !== greetingReceiptId(proof.meetingId, participant.participantId) ||
      participant.capture.turnId !== `participant-greeting:${participant.participantId}` ||
      participant.dispatch.turnId !== participant.capture.turnId ||
      joinObservedAt < joinedAt || dispatchedAt < joinedAt || dispatchedAt > firstPacketAt ||
      firstPacketAt - joinedAt !== participant.capture.firstAudioLatencyMilliseconds ||
      (previousFirstPacketAt !== undefined && joinedAt <= previousFirstPacketAt) ||
      Date.parse(participant.ledger.completedAt) > Date.parse(proof.settlementObservedAt)) {
      context.addIssue({ code: "custom", message: "Greeting proof is not bound to one sequential join, dispatch, first audio, ledger row, and settlement" });
    }
  }
});

export type GreetingLedgerQualificationV1 = z.infer<typeof greetingLedgerQualificationV1Schema>;

export function greetingReceiptId(meetingId: string, participantId: string): string {
  return createHash("sha256").update(JSON.stringify({
    kind: "greeting",
    meetingId,
    schemaVersion: 1,
    subjectId: participantId,
  }), "utf8").digest("hex");
}

export function buildGreetingLedgerQualification(input: Readonly<{
  campaignId: string;
  campaignProof: unknown;
  captures: readonly unknown[];
  ledgerRows: readonly unknown[];
  lifecycle: unknown;
  settlementObservedAt: string;
}>): GreetingLedgerQualificationV1 {
  const campaignProof = conversationVoiceCampaignProofV1Schema.parse(input.campaignProof);
  const captures = input.captures.map((capture) => conversationVoiceEvidenceV3Schema.parse(capture));
  const ledgerRows = input.ledgerRows.map((row) => greetingLedgerRowV1Schema.parse(row));
  const lifecycle = z.object({
    events: z.array(z.object({
      greetingLocale: z.enum(["en", "ru"]), observedAt: z.iso.datetime(),
      participantId: identifier, turnId: identifier, type: z.literal("greeting"),
    }).loose()),
    participantLifecycleReceipts: z.array(z.object({
      eventType: z.enum(["participant.joined", "participant.left"]),
      observedAt: z.iso.datetime(), occurredAt: z.iso.datetime(),
      participantId: identifier, type: z.literal("participant-lifecycle"),
    }).strict()),
  }).loose().parse(input.lifecycle);
  const meetingId = campaignProof.observerReadyReceipt.meetingId;
  const runId = campaignProof.observerReadyReceipt.runId;
  const greetings = captures.filter(({ correlation }) => correlation.purpose === "greeting");
  if (greetings.length !== OFFICIAL_GREETING_TEST_IDENTITIES.length ||
    ledgerRows.length !== OFFICIAL_GREETING_TEST_IDENTITIES.length) {
    throw new Error("Greeting qualification requires four retained captures and four durable ledger rows");
  }
  const rows = new Map(ledgerRows.map((row) => [row.receiptId, row]));
  return greetingLedgerQualificationV1Schema.parse({
    campaignId: input.campaignId,
    governedMaximumFirstAudioLatencyMilliseconds: 1_000,
    kind: "greeting-ledger-qualification",
    meetingId,
    participants: OFFICIAL_GREETING_TEST_IDENTITIES.map((participantId, index) => {
      const capture = greetings[index]!;
      const ledger = rows.get(greetingReceiptId(meetingId, participantId));
      if (ledger === undefined) {
        throw new Error(`Greeting ledger has no played row for participant ${participantId}`);
      }
      const previousFirstPacketAt = greetings[index - 1]?.capture.firstPacketAt.epochMilliseconds ?? 0;
      const firstPacketAt = capture.capture.firstPacketAt.epochMilliseconds;
      const joins = lifecycle.participantLifecycleReceipts.filter(({ eventType, occurredAt, participantId: observedId }) =>
        eventType === "participant.joined" && observedId === participantId &&
        Date.parse(occurredAt) > previousFirstPacketAt && Date.parse(occurredAt) <= firstPacketAt);
      const dispatches = lifecycle.events.filter(({ participantId: observedId, turnId }) =>
        observedId === participantId && turnId === capture.correlation.turnId);
      if (joins.length !== 1 || dispatches.length !== 1) {
        throw new Error(`Greeting proof requires one sequential join and dispatch for participant ${participantId}`);
      }
      const joinedAt = Date.parse(joins[0]!.occurredAt);
      return {
        capture: {
          attemptId: capture.correlation.attemptId,
          firstAudioLatencyMilliseconds: firstPacketAt - joinedAt,
          firstPacketAtEpochMilliseconds: firstPacketAt,
          packetCount: capture.capture.acceptedPacketCount,
          pcmSha256: capture.capture.pcm.sha256,
          turnId: capture.correlation.turnId,
        },
        dispatch: {
          greetingLocale: dispatches[0]!.greetingLocale,
          observedAt: dispatches[0]!.observedAt,
          turnId: dispatches[0]!.turnId,
        },
        join: { observedAt: joins[0]!.observedAt, occurredAt: joins[0]!.occurredAt },
        ledger,
        participantId,
      };
    }),
    runId,
    schemaVersion: 1,
    settlementObservedAt: input.settlementObservedAt,
  });
}
