import { createHash } from "node:crypto";

/* Historical hostile cases intentionally share the canonical retained fixture below. */

import { describe, expect, it } from "vitest";

import { DiscordGroundedAnswerRenderer } from "@discord-meeting/discord-adapter";

import {
  awaitHistoricalAnswerSnapshot,
  descriptionFromHistoricalDiscordAnswerPayload,
} from
  "../src/discordjs-historical-reply-campaign-adapter.js";

import {
  historicalReplyCampaignEvidenceV1Schema,
  historicalReplyCampaignInputV1Schema,
  assertHistoricalReplyReadinessMatchesCampaign,
  createHistoricalReplyPostRestartMutationAdmissionV1,
  HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1,
  type HistoricalReplyCampaignEvidenceV1,
  type HistoricalReplyCampaignInputV1,
} from "../src/historical-reply-campaign-contract.js";
import { collectHistoricalReplyReadiness } from
  "../src/ssh-deployment-probe-historical-reply.js";
import { verifyHistoricalReplyCampaignEvidence } from
  "../src/historical-reply-campaign-verification.js";
import {
  assertHistoricalPostRestartMutationAdmission,
  citationTurnIdsFromDiscordAnswer,
  parseDiscordAnswerClaimEnvelope,
  runHistoricalReplyCampaign,
  type HistoricalReplyCampaignPort,
} from "../src/historical-reply-campaign.js";
import type { RetainedE2eEvidence } from "../src/e2e-evidence.js";
import { createObservedMeetingProjectionMarkers } from
  "../src/live-discord-projection-marker-contract.js";
import {
  historicalReplyQuestionOutcomeQuery,
  historicalReplyQuestionAdmissionQuery,
  historicalReplyRehydrationQuery,
} from "../src/ssh-deployment-probe-scripts.js";
import { currentV10Campaign } from "./e2e-evidence-v10-fixtures.js";
import { recordingReadyReceiptV2Schema, sealRecordingReadyProducerEvidenceV1 } from
  "../src/recording-ready-receipt.js";
import { assertGovernedObservationPolicyMatchesPlan,
  assertHistoricalLifecycleMatchesRecordingReady } from
  "../src/thin-remediation-proof.js";
import { governedCampaignObservationFingerprint } from
  "../src/governed-private-campaign-observation.js";
import type { GovernedCampaignObservationInput } from
  "../src/governed-private-campaign-observation.js";

const observerId = "1533867700575670282";
const sutId = "1533224474609057793";
const guildId = "1533228590643155034";
const channelId = "1533228891827736657";
const targetMessageId = "1535000000000000001";
const liveTargetMessageId = "1535000000000000007";
const supportedQuestionId = "1535000000000000002";
const supportedAnswerId = "1535000000000000003";
const unsupportedQuestionId = "1535000000000000004";
const unsupportedAnswerId = "1535000000000000005";
const threadId = "1535000000000000006";
const parentB = "1533228891827736658";

// oxlint-disable-next-line max-lines-per-function
describe("historical Discord reply campaign", { timeout: 30_000 }, () => {
  it.each(["final-summary", "live-transcript"] as const)(
    "retains same-transcript grounding and semantic abstention for %s",
    async (targetKind) => {
      const { input } = fixture(targetKind);
      const evidence = await runHistoricalReplyCampaign(input, new FakeHistoricalReplyPort(input),
        () => Date.parse("2026-08-24T00:04:00.000Z"));

      expect(evidence.exchanges.supported.citationTurnIds)
        .toEqual(input.questions.supported.expectedCitationTurnIds);
      expect(evidence.campaign.canonicalAuthority.meetingId)
        .toBe(evidence.campaign.target.meetingId);
      expect(evidence.campaign.canonicalAuthority.transcriptId)
        .toBe(evidence.campaign.target.transcriptId);
      expect(evidence.exchanges.unsupported.durableOutcome.outcome)
        .toBe("insufficient_evidence");
      expect(historicalReplyCampaignEvidenceV1Schema.parse(evidence)).toEqual(evidence);
    },
  );

  it("parses every stable authoritative turn citation from rendered Discord claims", () => {
    const renderer = new DiscordGroundedAnswerRenderer();
    const evidence = [
      { endMs: 3_000, evidenceId: "evidence-000001", speakerId: "speaker-a",
        startMs: 2_000, text: "Fact one", turnHash: "a".repeat(64), turnId: "turn_[a]" },
      { endMs: 3_724_000, evidenceId: "evidence-000002", speakerId: "speaker-b",
        startMs: 3_723_000, text: "Fact two", turnHash: "b".repeat(64), turnId: "turn-b" },
    ];
    const answer = {
      claims: [{ evidenceIds: ["evidence-000001", "evidence-000002"],
        support: "cited_turns", text: "Grounded fact." }],
      locale: "en",
      status: "answered",
    } as unknown as Parameters<DiscordGroundedAnswerRenderer["renderAnswer"]>[0]["answer"];
    const rendered = renderer.renderAnswer({ answer, evidence, maximumCharacters: 2_000 });
    expect(citationTurnIdsFromDiscordAnswer(rendered)).toEqual(["turn_[a]", "turn-b"]);
    expect(parseDiscordAnswerClaimEnvelope(rendered)).toEqual([{
      citationTurnIds: ["turn_[a]", "turn-b"], text: "Grounded fact.",
    }]);
  });

  it("admits one fresh post-restart extension and rejects wrong, stale, expired, or replayed use", () => {
    const campaign = fixture().input;
    const expected = {
      admissionReceiptSha256: "3".repeat(64),
      campaign,
      evidenceOutputPathSha256: "8".repeat(64),
      nowEpochMs: Date.parse("2026-08-24T00:04:00.000Z"),
      planSha256: "5".repeat(64),
    };
    const consumedAdmissionIds = new Set<string>();
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, consumedAdmissionIds,
    }); }).not.toThrow();
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, consumedAdmissionIds,
    }); }).toThrow(/replayed/u);
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, admissionReceiptSha256: "9".repeat(64),
    }); }).toThrow(/other campaign/u);
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, evidenceOutputPathSha256: "9".repeat(64),
    }); }).toThrow(/other campaign/u);
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, nowEpochMs: Date.parse("2026-08-24T00:03:34.000Z"),
    }); }).toThrow(/stale/u);
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      ...expected, nowEpochMs: Date.parse("2026-08-24T00:05:00.000Z"),
    }); }).toThrow(/stale/u);
  });

  it.each([
    ["campaign", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.scope.campaignId = "another-campaign";
    }],
    ["supported question", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.scope.supportedQuestionSha256 = "9".repeat(64);
    }],
    ["unsupported question", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.scope.unsupportedQuestionSha256 = "9".repeat(64);
    }],
    ["restart provenance", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.restart.after.containerId = "9".repeat(64);
    }],
    ["retrieval binding", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.rollout.retrievalBinding.profileFingerprint = "9".repeat(64);
    }],
    ["policy epoch", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.rollout.policyEpoch += 1;
    }],
    ["protocol epoch", (campaign: HistoricalReplyCampaignInputV1) => {
      const rollout = campaign.mutationAdmission.rollout as unknown as {
        workerProtocolEpoch: number;
      };
      rollout.workerProtocolEpoch += 1;
    }],
    ["protocol generation", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.rollout.workerProtocolGeneration += 1;
    }],
    ["job generation", (campaign: HistoricalReplyCampaignInputV1) => {
      campaign.mutationAdmission.rollout.jobGeneration += 1;
    }],
  ] as const)("rejects a tampered %s admission before mutation", (_name, mutate) => {
    const campaign = structuredClone(fixture().input);
    mutate(campaign);
    const consumedAdmissionIds = new Set<string>();
    expect(() => { assertHistoricalPostRestartMutationAdmission({
      admissionReceiptSha256: "3".repeat(64),
      campaign,
      consumedAdmissionIds,
      evidenceOutputPathSha256: "8".repeat(64),
      nowEpochMs: Date.parse("2026-08-24T00:04:00.000Z"),
      planSha256: "5".repeat(64),
    }); }).toThrow();
    expect(consumedAdmissionIds.size).toBe(0);
  });

  it.each([
    ["message content", (payload: MutablePayload) => { payload.content = "hidden prose"; }],
    ["no embed", (payload: MutablePayload) => { payload.embeds = []; }],
    ["an empty description", (payload: MutablePayload) => {
      payload.embeds[0]!.description = "";
    }],
    ["a second embed", (payload: MutablePayload) => { payload.embeds.push(payload.embeds[0]!); }],
    ["an embed title", (payload: MutablePayload) => { payload.embeds[0]!.title = "prose"; }],
    ["embed fields", (payload: MutablePayload) => {
      payload.embeds[0]!.fields = [{ name: "claim", value: "hidden prose" }];
    }],
    ["an embed footer", (payload: MutablePayload) => {
      payload.embeds[0]!.footer = { text: "prose" };
    }],
    ["an embed author", (payload: MutablePayload) => {
      payload.embeds[0]!.author = { name: "prose" };
    }],
    ["an unsupported embed URL", (payload: MutablePayload) => {
      payload.embeds[0]!.url = "https://example.invalid/arbitrary-prose";
    }],
    ["embed image", (payload: MutablePayload) => {
      payload.embeds[0]!.image = { url: "https://example.invalid/image" };
    }],
    ["embed thumbnail", (payload: MutablePayload) => {
      payload.embeds[0]!.thumbnail = { url: "https://example.invalid/thumbnail" };
    }],
    ["embed video", (payload: MutablePayload) => {
      payload.embeds[0]!.video = { url: "https://example.invalid/video" };
    }],
    ["embed provider", (payload: MutablePayload) => {
      payload.embeds[0]!.provider = { name: "hidden provider prose" };
    }],
    ["embed timestamp", (payload: MutablePayload) => {
      payload.embeds[0]!.timestamp = "2026-08-24T00:00:00.000Z";
    }],
    ["embed color", (payload: MutablePayload) => { payload.embeds[0]!.color = 16_711_680; }],
    ["unknown future embed surface", (payload: MutablePayload) => {
      payload.embeds[0]!.future_text = "hidden prose";
    }],
    ["components", (payload: MutablePayload) => { payload.componentCount = 1; }],
    ["attachments", (payload: MutablePayload) => { payload.attachmentCount = 1; }],
    ["stickers", (payload: MutablePayload) => { payload.stickerCount = 1; }],
    ["message snapshots", (payload: MutablePayload) => { payload.messageSnapshotCount = 1; }],
    ["an activity", (payload: MutablePayload) => { payload.hasActivity = true; }],
    ["a call", (payload: MutablePayload) => { payload.hasCall = true; }],
    ["an interaction", (payload: MutablePayload) => { payload.hasInteraction = true; }],
    ["a poll", (payload: MutablePayload) => { payload.hasPoll = true; }],
    ["role subscription data", (payload: MutablePayload) => {
      payload.hasRoleSubscriptionData = true;
    }],
    ["a thread", (payload: MutablePayload) => { payload.hasThread = true; }],
  ])("rejects answer payload text or side surfaces in %s", (_name, mutate) => {
    const payload = completeAnswerPayload();
    mutate(payload);
    expect(() => { descriptionFromHistoricalDiscordAnswerPayload(payload); }).toThrow(/surface/u);
  });

  it("parses the sole description from the complete supported Discord payload", () => {
    const payload = completeAnswerPayload();
    expect(descriptionFromHistoricalDiscordAnswerPayload(payload))
      .toBe(payload.embeds[0]!.description);
  });

  it("rejects a duplicate that arrives after the first quiet-window fetch", async () => {
    let clock = Date.parse("2026-08-24T00:00:00.000Z");
    let fetchCount = 0;
    const answer = {
      authorApplicationId: sutId, channelId, createdAt: new Date(clock).toISOString(),
      description: "Fact\n-# S1 · 00:00 · turn-1", messageId: supportedAnswerId,
      replyToMessageId: supportedQuestionId,
    };
    await expect(awaitHistoricalAnswerSnapshot({
      afterMessageId: supportedQuestionId,
      answerTimeoutMilliseconds: 10_000,
      fetchMatchingAnswers: () => {
        fetchCount += 1;
        return Promise.resolve(fetchCount === 1 ? [answer]
          : fetchCount === 2 ? []
            : [{ ...answer, messageId: unsupportedAnswerId }]);
      },
      now: () => clock,
      pollIntervalMilliseconds: 1_000,
      quietWindowMilliseconds: 2_000,
      wait: (milliseconds) => { clock += milliseconds; return Promise.resolve(); },
    })).rejects.toThrow(/duplicate/u);
  });

  it.each([
    ["wrong target", (port: FakeHistoricalReplyPort) => { port.targetMessageId = "1535000000000000099"; }],
    ["wrong projection kind", (port: FakeHistoricalReplyPort) => {
      port.targetProjectionKind = port.inputTargetKind === "final-summary"
        ? "live-transcript"
        : "final-summary";
    }],
    ["early question", (port: FakeHistoricalReplyPort) => {
      port.supportedQuestionAt = "2026-08-24T00:02:30.000Z";
    }],
    ["wrong answer reply", (port: FakeHistoricalReplyPort) => {
      port.supportedAnswerReplyTo = "1535000000000000099";
    }],
    ["missing citation", (port: FakeHistoricalReplyPort) => {
      port.supportedDescription = "Meeting Platform was discussed without a citation.";
    }],
    ["uncited additional sentence", (port: FakeHistoricalReplyPort) => {
      port.supportedDescription = `${port.supportedDescription} Invented additional fact.`;
    }],
    ["additional cited claim absent from the pinned envelope", (port: FakeHistoricalReplyPort) => {
      port.supportedDescription += "\n\nInvented additional fact.\n-# S1 · 00:00 · turn-1";
    }],
    ["unsupported claim", (port: FakeHistoricalReplyPort) => {
      port.unsupportedOutcome = "answered";
    }],
    ["late duplicate answer", (port: FakeHistoricalReplyPort) => {
      port.lateDuplicate = true;
    }],
    ["changed restarted runtime", (port: FakeHistoricalReplyPort) => {
      port.runtimeReady = false;
    }],
    ["policy epoch changes between questions", (port: FakeHistoricalReplyPort) => {
      port.unsupportedPolicyEpoch = 4;
    }],
    ["worker generation changes between questions", (port: FakeHistoricalReplyPort) => {
      port.unsupportedWorkerGeneration = 8;
    }],
    ["worker protocol changes between questions", (port: FakeHistoricalReplyPort) => {
      port.unsupportedWorkerProtocolEpoch = 4;
    }],
    ["retrieval binding changes between questions", (port: FakeHistoricalReplyPort) => {
      port.unsupportedProfileFingerprint = "d".repeat(64);
    }],
  ])("fails closed on %s", async (_name, mutate) => {
    const { input } = fixture();
    const port = new FakeHistoricalReplyPort(input);
    mutate(port);
    await expect(runHistoricalReplyCampaign(input, port,
      () => Date.parse("2026-08-24T00:04:00.000Z"))).rejects.toThrow();
  }, 30_000);

  it("rejects a mutation outside the compiled private guild and SUT", async () => {
    const outside = structuredClone(fixture().input);
    outside.guildId = "1535000000000000099";
    await expect(runHistoricalReplyCampaign(outside, new FakeHistoricalReplyPort(outside),
      () => Date.parse("2026-08-24T00:04:00.000Z"))).rejects.toThrow();
  });

  it("treats admission expiry as an exclusive pre-mutation bound", async () => {
    const { input } = fixture();
    const port = new FakeHistoricalReplyPort(input);
    await expect(runHistoricalReplyCampaign(input, port,
      () => Date.parse(input.mutationAdmission.expiresAt))).rejects.toThrow(/expired/u);
    expect(port.sentQuestionCount).toBe(0);
  });

  it("rejects a rehydration receipt for the wrong release or generation", () => {
    const wrongRelease = structuredClone(fixture().input);
    wrongRelease.rehydration.historicalReleaseId = "another-release";
    expect(historicalReplyCampaignInputV1Schema.safeParse(wrongRelease).success).toBe(false);

    const wrongGeneration = structuredClone(fixture().input);
    wrongGeneration.rehydration.appliedIndexGeneration = "generation-5";
    expect(historicalReplyCampaignInputV1Schema.safeParse(wrongGeneration).success).toBe(false);
  });

  it.each([2, 4])("rejects SUT lifecycle generation %i against authoritative generation 3", (
    lifecycleGeneration,
  ) => {
    const campaign = structuredClone(fixture().input);
    campaign.rehydration.trustedLifecycle.lifecycleGeneration = lifecycleGeneration;
    expect(historicalReplyCampaignInputV1Schema.safeParse(campaign).success).toBe(false);
  });

  it("supports distinct supported and unsupported parents inside the canonical allowlist", async () => {
    const base = fixture();
    const multiParent = structuredClone(base.input);
    multiParent.unsupportedTarget.channelId = parentB;
    multiParent.unsupportedTarget.parentChannelId = parentB;
    multiParent.observationScope.parentChannelIds = [channelId, parentB];
    const input = historicalReplyCampaignInputV1Schema.parse(multiParent);
    const evidence = await runHistoricalReplyCampaign(input, new FakeHistoricalReplyPort(input),
      () => Date.parse(input.observationScope.endedAt));

    expect(evidence.privateScopeAnswers.scope.parentChannelIds).toEqual([channelId, parentB]);
    expect(verificationCodes(evidence, base.runs)).toEqual([]);
  });

  it("rejects missing, reordered, extra, or target-omitting governed parents", () => {
    const mutations = [
      [] as string[],
      [parentB, channelId],
      [parentB],
    ];
    for (const parentChannelIds of mutations) {
      const campaign = structuredClone(fixture().input);
      campaign.observationScope.parentChannelIds = parentChannelIds;
      expect(historicalReplyCampaignInputV1Schema.safeParse(campaign).success).toBe(false);
    }
    const compiled = fixture().input.observationScope;
    expect(() => { assertGovernedObservationPolicyMatchesPlan({
      ...compiled, parentChannelIds: [...compiled.parentChannelIds, parentB],
    }, { historicalReplyObservationPolicy: compiled }); }).toThrow();
  });

  it("rejects substituted or missing Craig completion identity even when stale evidence is resealed", () => {
    const campaign = fixture().input;
    const ready = recordingReadyFor(campaign);
    const { canonicalSealSha256: _seal, ...body } = campaign.producerEvidence;
    const substitutions = [
      { ...body, authoritativeLifecycleCompletion: {
        ...body.authoritativeLifecycleCompletion, eventId: "ready-stale-recording",
      } },
      { ...body, authoritativeLifecycleCompletion: {
        ...body.authoritativeLifecycleCompletion, occurredAt: "2026-08-23T23:59:00.000Z",
      } },
      { ...body, craigDeployment: { ...body.craigDeployment, sourceRevision: "9".repeat(40) },
        identityProvenance: { ...body.identityProvenance, producerRevision: "9".repeat(40) } },
    ];
    for (const staleBody of substitutions) {
      const stale = sealRecordingReadyProducerEvidenceV1(staleBody);
      expect(() => { assertHistoricalLifecycleMatchesRecordingReady(stale, ready); }).toThrow();
    }
    expect(() => sealRecordingReadyProducerEvidenceV1({
      ...body, authoritativeLifecycleCompletion: {
        ...body.authoritativeLifecycleCompletion, eventType: "meeting.ended",
      },
    })).toThrow();
    const missing = structuredClone(body) as unknown as Record<string, unknown>;
    delete (missing.authoritativeLifecycleCompletion as Record<string, unknown>).eventId;
    expect(() => sealRecordingReadyProducerEvidenceV1(missing)).toThrow();
  });

  it("derives retrieval binding and applied index profile from durable columns", () => {
    expect(historicalReplyRehydrationQuery).toContain("applied_index_profile_id");
    expect(historicalReplyRehydrationQuery).toContain("profile_rebuild_requested");
    expect(historicalReplyRehydrationQuery).toContain(
      "'retrievalPath', 'infinity_locator_v2'",
    );
    expect(historicalReplyQuestionAdmissionQuery).toContain(
      "binding -> 'retrievalBinding'",
    );
    expect(historicalReplyQuestionOutcomeQuery).not.toContain("retrievalBinding");
    expect(historicalReplyRehydrationQuery).toContain("'appliedIndexGeneration', applied_index_generation");
    expect(historicalReplyRehydrationQuery).not.toContain("'appliedGeneration', desired_generation");
  });

  it("passes the exact strict probe shape through preparation and observer readiness", async () => {
    const campaign = fixture().input;
    const { serviceContainerId: _serviceContainerId, ...rehydrationOutput } = campaign.rehydration;
    const service = campaign.restart.after;
    const readiness = await collectHistoricalReplyReadiness({
      collectService: () => Promise.resolve({
        composeConfigHash: service.composeConfigHash,
        composeProject: service.composeProject,
        composeService: service.composeService,
        containerId: service.containerId,
        containerStartedAt: service.startedAt,
        imageId: service.imageId,
        repositoryDigest: service.repositoryDigest,
        sourceRevision: service.sourceRevision,
      }),
      collectWorkerProcess: () => Promise.resolve({
        containerId: service.containerId, hostProcessId: service.hostProcessId,
      }),
      dockerExecPostgres: () => Promise.resolve(JSON.stringify(rehydrationOutput)),
    }, campaign.canonicalAuthority.meetingId);

    expect(() => { assertHistoricalReplyReadinessMatchesCampaign(campaign, readiness); })
      .not.toThrow();
  });

  it("rejects missing or rebuilding applied index profiles", () => {
    const missing = structuredClone(fixture().input);
    missing.rehydration.appliedIndexProfileId = "";
    expect(historicalReplyCampaignInputV1Schema.safeParse(missing).success).toBe(false);
    const rebuilding = structuredClone(fixture().input) as unknown as {
      rehydration: { profileRebuildRequested: boolean };
    };
    rebuilding.rehydration.profileRebuildRequested = true;
    expect(historicalReplyCampaignInputV1Schema.safeParse(rebuilding).success).toBe(false);
  });

  it("rejects restart provenance that changes repository or Compose identity", () => {
    const repository = structuredClone(fixture().input);
    repository.restart.after.repositoryDigest = `registry.example/other@sha256:${"7".repeat(64)}`;
    expect(historicalReplyCampaignInputV1Schema.safeParse(repository).success).toBe(false);
    const compose = structuredClone(fixture().input) as unknown as {
      restart: { after: { composeService: string } };
    };
    compose.restart.after.composeService = "other-service";
    expect(historicalReplyCampaignInputV1Schema.safeParse(compose).success).toBe(false);
  });

  it("rejects a different source meeting or transcript before observation", () => {
    const wrongMeeting = structuredClone(fixture().input);
    wrongMeeting.canonicalAuthority.meetingId = "different-meeting";
    expect(historicalReplyCampaignInputV1Schema.safeParse(wrongMeeting).success).toBe(false);

    const wrongTranscript = structuredClone(fixture().input);
    wrongTranscript.canonicalAuthority.transcriptId = "different-transcript";
    expect(historicalReplyCampaignInputV1Schema.safeParse(wrongTranscript).success).toBe(false);
  });

  it("rejects a post-restart admission replayed for different question bytes", () => {
    const wrongQuestion = structuredClone(fixture().input);
    wrongQuestion.questions.unsupported.text = "A different unsupported question";
    expect(historicalReplyCampaignInputV1Schema.safeParse(wrongQuestion).success).toBe(false);
  });

  it("keeps projection target branches structurally disjoint", () => {
    const finalWithoutSummary = structuredClone(fixture("final-summary").input) as Record<
      string,
      unknown
    >;
    delete (finalWithoutSummary.target as Record<string, unknown>).summaryId;
    expect(historicalReplyCampaignInputV1Schema.safeParse(finalWithoutSummary).success).toBe(false);

    const liveWithSummary = structuredClone(fixture("live-transcript").input) as Record<
      string,
      unknown
    >;
    (liveWithSummary.target as Record<string, unknown>).summaryId = "forbidden-summary";
    expect(historicalReplyCampaignInputV1Schema.safeParse(liveWithSummary).success).toBe(false);
  });

  it("rejects arbitrary unsupported prose despite a durable semantic abstention", async () => {
    const { input } = fixture();
    const port = new FakeHistoricalReplyPort(input);
    port.unsupportedDescription = "Localized renderer prose changed.";
    await expect(runHistoricalReplyCampaign(input, port,
      () => Date.parse("2026-08-24T00:04:00.000Z"))).rejects.toThrow(/abstention/u);
  });

  it.each(["final-summary", "live-transcript"] as const)(
    "verifies the %s proof against the exact V10 meeting evidence",
    async (targetKind) => {
    const { input, runs } = fixture(targetKind);
    const evidence = await runHistoricalReplyCampaign(input, new FakeHistoricalReplyPort(input),
      () => Date.parse("2026-08-24T00:04:00.000Z"));
    expect(verificationCodes(evidence, runs)).toEqual([]);
  });

  it.each([
    ["wrong target meeting", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.target.meetingId = "wrong-meeting";
    }, "HISTORICAL_REPLY_TARGET_MISMATCH"],
    ["wrong release", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.release.releaseId = "wrong-release";
    }, "HISTORICAL_REPLY_RELEASE_MISMATCH"],
    ["wrong cited turn", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.citationTurnIds[0] = "wrong-turn";
    }, "HISTORICAL_REPLY_GROUNDING_INVALID"],
    ["answer before rehydration", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.answer.createdAt = "2026-08-24T00:02:30.000Z";
    }, "HISTORICAL_REPLY_BEFORE_REHYDRATION"],
    ["wrong replied-to message", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.unsupported.question.replyToMessageId = "1535000000000000099";
    }, "HISTORICAL_REPLY_MESSAGE_BINDING_INVALID"],
    ["fabricated unsupported answer", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.unsupported.durableOutcome.outcome = "answered";
    }, "HISTORICAL_REPLY_ABSTENTION_INVALID"],
    ["literal retrieval path replacement", (proof: HistoricalReplyCampaignEvidenceV1) => {
      (proof.exchanges.supported.durableAdmission.retrievalBinding as unknown as {
        retrievalPath: string;
      }).retrievalPath = "legacy_downstream_v1";
    }, "HISTORICAL_REPLY_DURABLE_OUTCOME_MISMATCH"],
    ["late duplicate", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.quietWindow.matchingAnswerMessageIds.push(unsupportedAnswerId);
    }, "HISTORICAL_REPLY_DUPLICATE_OR_UNBOUNDED"],
    ["truncated quiet window", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.quietWindow.endedAt = "2026-08-24T00:03:47.000Z";
    }, "HISTORICAL_REPLY_DUPLICATE_OR_UNBOUNDED"],
    ["unsupported expected claim", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.questions.supported.expectedClaims[0]!.text = "invented retained claim";
      proof.exchanges.supported.answer.description += " invented retained claim";
    }, "HISTORICAL_REPLY_GROUNDING_INVALID"],
    ["unpinned additional cited claim", (proof: HistoricalReplyCampaignEvidenceV1) => {
      const turnId = proof.campaign.questions.supported.expectedCitationTurnIds[0]!;
      proof.exchanges.supported.answer.description +=
        `\n\nInvented additional fact.\n-# S1 · 00:00 · ${turnId}`;
    }, "HISTORICAL_REPLY_GROUNDING_INVALID"],
    ["changed policy epoch", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.unsupported.durableAdmission.policyEpoch += 1;
    }, "HISTORICAL_REPLY_ROLLOUT_CONTINUITY_MISMATCH"],
    ["changed worker generation", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.unsupported.durableAdmission.jobGeneration += 1;
      proof.exchanges.unsupported.durableAdmission.workerProtocolGeneration += 1;
    }, "HISTORICAL_REPLY_ROLLOUT_CONTINUITY_MISMATCH"],
    ["changed worker protocol", (proof: HistoricalReplyCampaignEvidenceV1) => {
      const admission = proof.exchanges.unsupported.durableAdmission as unknown as {
        workerProtocolEpoch: number;
      };
      admission.workerProtocolEpoch = 4;
    }, "HISTORICAL_REPLY_ROLLOUT_CONTINUITY_MISMATCH"],
    ["changed retrieval binding", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.unsupported.durableAdmission.retrievalBinding.profileFingerprint =
        "d".repeat(64);
    }, "HISTORICAL_REPLY_ROLLOUT_CONTINUITY_MISMATCH"],
    ["changed reconciled provider attempt", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.durableSettlement.attemptId = "substituted-attempt";
    }, "HISTORICAL_REPLY_RECONCILIATION_IDENTITY_MISMATCH"],
    ["changed reconciled Discord receipt", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.durableSettlement.externalReceipt = unsupportedAnswerId;
    }, "HISTORICAL_REPLY_RECONCILIATION_IDENTITY_MISMATCH"],
    ["changed canonical grounding plan", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.durableSettlement.groundingPlanSha256 = "9".repeat(64);
    }, "HISTORICAL_REPLY_RECONCILIATION_IDENTITY_MISMATCH"],
    ["fabricated crash effect", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.crashReceipts[0]!.effectId = "meeting-knowledge-answer:v1:fabricated";
    }, "HISTORICAL_REPLY_CRASH_RECEIPT_INVALID"],
    ["crash without a replacement process", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.exchanges.supported.durableSettlement.serviceHostProcessId =
        proof.crashReceipts[0]!.crashedHostProcessId;
    }, "HISTORICAL_REPLY_CRASH_RECEIPT_INVALID"],
    ["an out-of-scope SUT answer", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.privateScopeAnswers.receipts.push({
        channelId, messageId: "1535000000000000098", replyToMessageId: supportedQuestionId,
      });
    }, "HISTORICAL_REPLY_PRIVATE_SCOPE_ANSWER_MISMATCH"],
    ["non-human lifecycle provenance", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.rehydration.trustedLifecycle.actors[0]!.kind = "unknown";
    }, "HISTORICAL_REPLY_TRUSTED_ROSTER_INVALID"],
    ["stale Craig roster evidence", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.producerEvidence.actors = proof.campaign.producerEvidence.actors.slice(1);
    }, "HISTORICAL_REPLY_TRUSTED_ROSTER_INVALID"],
    ["changed compose configuration", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.restart.before.composeConfigHash = "9".repeat(64);
    }, "HISTORICAL_REPLY_RESTART_MISMATCH"],
    ["fabricated projection receipt", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.target.projectionMarker = `meeting-projection:${"9".repeat(20)}`;
    }, "HISTORICAL_REPLY_TARGET_MISMATCH"],
    ["expired mutation admission", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.mutationAdmission.expiresAt = "2026-08-24T00:03:44.000Z";
    }, "HISTORICAL_REPLY_MUTATION_ADMISSION_INVALID"],
    ["unreviewed guild", (proof: HistoricalReplyCampaignEvidenceV1) => {
      proof.campaign.guildId = "1535000000000000099";
    }, "HISTORICAL_REPLY_COMPILED_TARGET_MISMATCH"],
  ])("verifier rejects %s", async (_name, mutate, expectedCode) => {
    const { input, runs } = fixture();
    const evidence = await runHistoricalReplyCampaign(input, new FakeHistoricalReplyPort(input),
      () => Date.parse("2026-08-24T00:04:00.000Z"));
    mutate(evidence);
    expect(verificationCodes(evidence, runs)).toContain(expectedCode);
  });

  it("verifies delivery in a public thread while retaining the parent projection identity", async () => {
    const { input, runs } = fixture("final-summary", true);
    const evidence = await runHistoricalReplyCampaign(input, new FakeHistoricalReplyPort(input),
      () => Date.parse("2026-08-24T00:04:00.000Z"));
    expect(evidence.campaign.target.channelId).toBe(threadId);
    expect(evidence.campaign.target.parentChannelId).toBe(channelId);
    expect(verificationCodes(evidence, runs)).toEqual([]);
  });
});

function fixture(
  targetKind: "final-summary" | "live-transcript" = "final-summary",
  thread = false,
): {
  readonly input: HistoricalReplyCampaignInputV1;
  readonly runs: RetainedE2eEvidence[];
} {
  const runs = currentV10Campaign();
  const target = runs[2]!;
  if (target.schemaVersion !== 10 || target.qualificationKind !== "voice") {
    throw new Error("historical reply fixture requires the V10 reconnect voice run");
  }
  const sourceTurn = target.transcript.turns[0]!;
  target.publication.messageId = targetMessageId;
  target.replay.messageId = targetMessageId;
  target.publication.container = thread
    ? { kind: "thread", parentChannelId: channelId, threadId }
    : { kind: "channel-message", parentChannelId: channelId };
  target.replay.container = target.publication.container;
  const supportedQuestion = "What did this meeting say about Meeting Platform?";
  const unsupportedQuestion = "Did the meeting approve a lunar launch on Friday?";
  const restartAfter = {
    composeConfigHash: target.deployment.meetingPlatform.composeConfigHash,
    composeProject: "discord-meeting-assistant",
    composeService: "meeting-platform",
    containerId: "f".repeat(64),
    hostProcessId: 441,
    imageId: target.deployment.meetingPlatform.imageId,
    repositoryDigest: target.deployment.meetingPlatform.repositoryDigest ??
      `registry.example/meeting-platform@sha256:${"1".repeat(64)}`,
    sourceRevision: target.deployment.meetingPlatform.sourceRevision,
    startedAt: "2026-08-24T00:02:00.000Z",
  } as const;
  const intendedActors = [
    ...[...new Set(target.transcript.turns.map(({ speakerId }) => speakerId))]
      .filter((actorId) => actorId !== target.conversation.botSpeakerId)
      .map((actorId) => ({ actorId, kind: "human" as const })),
    { actorId: target.conversation.botSpeakerId, kind: "automation" as const },
  ].toSorted((left, right) => left.actorId.localeCompare(right.actorId) ||
    left.kind.localeCompare(right.kind));
  const producerEvidence = producerEvidenceFor(target, intendedActors);
  const input = historicalReplyCampaignInputV1Schema.parse({
    answerQuietWindowMilliseconds: 2_000,
    campaignId: "historical-reply-campaign-1",
    guildId,
    mutationAdmission: createHistoricalReplyPostRestartMutationAdmissionV1({
      admissionId: "historical-reply-admission-1",
      expiresAt: "2026-08-24T00:05:00.000Z",
      freshDiscordIdentity: {
        expiresAt: "2026-08-24T00:05:00.000Z",
        generatedAt: "2026-08-24T00:03:34.000Z",
        receiptSha256: "6".repeat(64),
      },
      issuedAt: "2026-08-24T00:03:35.000Z",
      kind: "historical-reply-post-restart-mutation-admission",
      originalCampaign: {
        admissionReceiptSha256: "3".repeat(64),
        planSha256: "5".repeat(64),
        release: target.release,
      },
      restart: {
        after: restartAfter,
        before: {
          composeConfigHash: target.deployment.meetingPlatform.composeConfigHash,
          composeProject: "discord-meeting-assistant",
          composeService: "meeting-platform",
          containerId: target.deployment.meetingPlatform.containerId,
          hostProcessId: 440,
          imageId: target.deployment.meetingPlatform.imageId,
          repositoryDigest: target.deployment.meetingPlatform.repositoryDigest ??
            `registry.example/meeting-platform@sha256:${"1".repeat(64)}`,
          sourceRevision: target.deployment.meetingPlatform.sourceRevision,
          startedAt: target.deployment.meetingPlatform.containerStartedAt,
        },
      },
      rollout: {
        appliedIndexGeneration: "generation-4",
        appliedIndexProfileId: "meeting-knowledge.source-profile.v1",
        desiredSourceGeneration: 4,
        jobGeneration: 7,
        policyEpoch: 3,
        retrievalBinding: {
          cutoverEpoch: "historical-qualification-r1",
          profileFingerprint: "e".repeat(64),
          request: retrievalV2Request(),
          retrievalPath: "infinity_locator_v2",
        },
        workerProtocolEpoch: 3,
        workerProtocolGeneration: 7,
      },
      schemaVersion: 1,
      scope: {
        campaignId: "historical-reply-campaign-1",
        channelId: thread ? threadId : channelId,
        evidenceOutputPathSha256: "8".repeat(64),
        guildId,
        historicalRunId: "historical-reply-1",
        meetingId: target.meetingId,
        messageId: targetKind === "final-summary" ? targetMessageId : liveTargetMessageId,
        parentChannelId: channelId,
        supportedQuestionSha256: sha256(supportedQuestion),
        targetRunId: target.actorRun.runId,
        transcriptId: target.transcript.transcriptId,
        unsupportedMessageId: targetKind === "final-summary"
          ? liveTargetMessageId : targetMessageId,
        unsupportedQuestionSha256: sha256(unsupportedQuestion),
      },
    }),
    canonicalAuthority: {
      generation: 4,
      historicalReleaseId: "historical-release-4",
      meetingId: target.meetingId,
      runId: target.actorRun.runId,
      transcriptId: target.transcript.transcriptId,
      transcriptVersion: 1,
      turns: [{
        endMs: sourceTurn.endMs,
        speakerId: sourceTurn.speakerId,
        startMs: sourceTurn.startMs,
        textSha256: sha256(sourceTurn.text),
        turnId: sourceTurn.turnId,
      }],
    },
    botActorId: target.conversation.botSpeakerId,
    intendedActors,
    observerApplicationId: observerId,
    observationScope: {
      archivedThreadVisibilities: ["public", "private"],
      endedAt: "2026-08-24T00:04:00.000Z",
      guildId,
      maximumArchivePagesPerParent: 100,
      maximumMessagePagesPerSurface: 100,
      parentChannelIds: [channelId],
      startedAt: "2026-08-24T00:03:35.000Z",
    },
    privateTestGuildConfirmed: true,
    questions: {
      supported: {
        expectedLocale: "ru",
        expectedClaims: [{
          citationTurnIds: [sourceTurn.turnId],
          requiredTerms: ["Meeting Platform"],
          text: sourceTurn.text,
        }],
        expectedAnswerTerms: ["Meeting Platform"],
        expectedCitationTurnIds: [sourceTurn.turnId],
        text: supportedQuestion,
      },
      unsupported: {
        expectedLocale: "en",
        expectedResponse: HISTORICAL_REPLY_UNSUPPORTED_RESPONSE_V1,
        text: unsupportedQuestion,
      },
    },
    producerEvidence,
    rehydration: {
      appliedIndexGeneration: "generation-4",
      appliedIndexProfileId: "meeting-knowledge.source-profile.v1",
      appliedReleaseRef: "historical-release-ref-4",
      canonicalTurnIds: [sourceTurn.turnId],
      desiredSourceGeneration: 4,
      documentMappings: [{
        canonicalTurnIds: [sourceTurn.turnId],
        documentExternalId: "historical-document-4",
        plannedIndexGeneration: "generation-4",
        plannedProfileId: "meeting-knowledge.source-profile.v1",
        remoteDocumentId: "remote-document-4",
      }],
      infinityDocumentCount: 1,
      observedAt: "2026-08-24T00:03:00.000Z",
      historicalReleaseId: "historical-release-4",
      plannedDocumentCount: 1,
      plannedGeneration: "generation-4",
      plannedProfileIds: ["meeting-knowledge.source-profile.v1"],
      plannedRoomId: "meeting-space",
      plannedScopeId: "guild-memory",
      profileRebuildRequested: false,
      retrievalPath: "infinity_locator_v2",
      roomId: "meeting-space",
      scopeId: "guild-memory",
      serviceContainerId: "f".repeat(64),
      sourceMeetingId: target.meetingId,
      state: "applied",
      transcriptId: target.transcript.transcriptId,
      transcriptVersion: 1,
      trustedLifecycle: {
        actorObservationState: "consistent",
        actorSemanticsVersion: 1,
        actors: intendedActors,
        lifecycleGeneration: 3,
        producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
        producerRevision: target.deployment.craig.sourceRevision,
        rosterState: "sealed",
      },
    },
    release: target.release,
    restart: {
      after: restartAfter,
      before: {
        composeConfigHash: target.deployment.meetingPlatform.composeConfigHash,
        composeProject: "discord-meeting-assistant",
        composeService: "meeting-platform",
        containerId: target.deployment.meetingPlatform.containerId,
        hostProcessId: 440,
        imageId: target.deployment.meetingPlatform.imageId,
        repositoryDigest: target.deployment.meetingPlatform.repositoryDigest ??
          `registry.example/meeting-platform@sha256:${"1".repeat(64)}`,
        sourceRevision: target.deployment.meetingPlatform.sourceRevision,
        startedAt: target.deployment.meetingPlatform.containerStartedAt,
      },
      readyAt: "2026-08-24T00:03:30.000Z",
      requestedAt: "2026-08-24T00:01:00.000Z",
    },
    runId: "historical-reply-1",
    sutApplicationId: sutId,
    target: {
      channelId: thread ? threadId : channelId,
      kind: targetKind,
      meetingId: target.meetingId,
      messageId: targetKind === "final-summary" ? targetMessageId : liveTargetMessageId,
      parentChannelId: channelId,
      runId: target.actorRun.runId,
      ...(targetKind === "final-summary" ? { summaryId: target.summary.summaryId } : {}),
      transcriptId: target.transcript.transcriptId,
    },
    unsupportedTarget: {
      channelId: thread ? threadId : channelId,
      kind: targetKind === "final-summary" ? "live-transcript" : "final-summary",
      meetingId: target.meetingId,
      messageId: targetKind === "final-summary" ? liveTargetMessageId : targetMessageId,
      parentChannelId: channelId,
      runId: target.actorRun.runId,
      ...(targetKind === "live-transcript" ? { summaryId: target.summary.summaryId } : {}),
      transcriptId: target.transcript.transcriptId,
    },
  });
  return { input, runs };
}

class FakeHistoricalReplyPort implements HistoricalReplyCampaignPort {
  public supportedAnswerReplyTo = supportedQuestionId;
  public supportedDescription: string;
  public supportedQuestionAt = "2026-08-24T00:03:40.000Z";
  public lateDuplicate = false;
  public runtimeReady = true;
  public targetMessageId = targetMessageId;
  public targetProjectionKind: "final-summary" | "live-transcript";
  public unsupportedDescription: string;
  public unsupportedOutcome: "answered" | "insufficient_evidence" = "insufficient_evidence";
  public unsupportedPolicyEpoch = 3;
  public unsupportedProfileFingerprint = "e".repeat(64);
  public unsupportedWorkerProtocolEpoch = 3;
  public unsupportedWorkerGeneration = 7;
  #questionCount = 0;

  public get sentQuestionCount(): number { return this.#questionCount; }

  public constructor(private readonly input: HistoricalReplyCampaignInputV1) {
    this.targetMessageId = input.target.messageId;
    this.targetProjectionKind = input.target.kind;
    this.supportedDescription = `${input.questions.supported.expectedClaims[0]!.text}\n-# S1 · 00:00 · ${
      input.questions.supported.expectedCitationTurnIds[0]}`;
    this.unsupportedDescription = "There is not enough confirmed meeting evidence to answer that.";
  }

  public authenticatedApplicationId(): string { return observerId; }
  public assertRuntimeReady(): Promise<void> {
    return this.runtimeReady
      ? Promise.resolve()
      : Promise.reject(new Error("runtime changed"));
  }
  public get inputTargetKind(): "final-summary" | "live-transcript" { return this.input.target.kind; }

  public inspectTarget(input: HistoricalReplyCampaignInputV1["target"]) {
    const primary = input.kind === this.input.target.kind;
    const projectionKind = primary ? this.targetProjectionKind : input.kind;
    const markerIndex = projectionKind === "live-transcript" ? 0 : 1;
    return Promise.resolve({
      authorApplicationId: sutId, channelId: input.channelId, guildId,
      messageId: primary ? this.targetMessageId : input.messageId,
      observedAt: "2026-08-24T00:03:35.000Z",
      projectionMarker: createObservedMeetingProjectionMarkers(
        this.input.target.meetingId,
        input.parentChannelId,
      )[markerIndex],
      projectionKind,
    });
  }

  public sendQuestion(input: { readonly replyToMessageId: string }) {
    this.#questionCount += 1;
    const supported = this.#questionCount === 1;
    return Promise.resolve({
      authorApplicationId: observerId,
      channelId: input.replyToMessageId === this.input.target.messageId
        ? this.input.target.channelId : this.input.unsupportedTarget.channelId,
      createdAt: supported ? this.supportedQuestionAt : "2026-08-24T00:03:50.000Z",
      messageId: supported ? supportedQuestionId : unsupportedQuestionId,
      replyToMessageId: input.replyToMessageId,
    });
  }

  public awaitAnswer(input: { readonly replyToQuestionMessageId: string }) {
    const supported = input.replyToQuestionMessageId === supportedQuestionId;
    const answer = {
      authorApplicationId: sutId,
      channelId: supported ? this.input.target.channelId : this.input.unsupportedTarget.channelId,
      createdAt: supported ? "2026-08-24T00:03:45.000Z" : "2026-08-24T00:03:55.000Z",
      description: supported ? this.supportedDescription : this.unsupportedDescription,
      messageId: supported ? supportedAnswerId : unsupportedAnswerId,
      replyToMessageId: supported ? this.supportedAnswerReplyTo : unsupportedQuestionId,
    };
    return Promise.resolve({ answer, quietWindow: {
      endedAt: supported ? "2026-08-24T00:03:48.000Z" : "2026-08-24T00:03:58.000Z",
      matchingAnswerMessageIds: this.lateDuplicate
        ? [answer.messageId, "1535000000000000099"]
        : [answer.messageId],
      startedAt: supported ? "2026-08-24T00:03:46.000Z" : "2026-08-24T00:03:56.000Z",
    } });
  }

  public observeDurableOutcome(questionId: string) {
    const supported = questionId === supportedQuestionId;
    return Promise.resolve({
      observedAt: supported ? "2026-08-24T00:03:49.000Z" : "2026-08-24T00:03:59.000Z",
      outcome: supported ? "answered" as const : this.unsupportedOutcome,
      questionId,
      serviceContainerId: "f".repeat(64),
      state: "terminal" as const,
    });
  }

  public observeDurableAdmission(questionId: string) {
    const supported = questionId === supportedQuestionId;
    const workerGeneration = supported ? 7 : this.unsupportedWorkerGeneration;
    return Promise.resolve({
      attemptId: `attempt-${questionId}`,
      effectId: `meeting-knowledge-answer:v1:${questionId}`,
      groundingPlanSha256: "b".repeat(64),
      jobGeneration: workerGeneration,
      jobId: questionId,
      observedAt: supported ? "2026-08-24T00:03:42.000Z" : "2026-08-24T00:03:52.000Z",
      policyEpoch: supported ? 3 : this.unsupportedPolicyEpoch,
      questionId,
      retrievalBinding: {
        cutoverEpoch: "historical-qualification-r1",
        profileFingerprint: supported ? "e".repeat(64) : this.unsupportedProfileFingerprint,
        request: this.input.mutationAdmission.rollout.retrievalBinding.request,
        retrievalPath: "infinity_locator_v2" as const,
      },
      serviceContainerId: "f".repeat(64),
      state: "ready" as const,
      workerProtocolEpoch: (supported ? 3 : this.unsupportedWorkerProtocolEpoch) as 3,
      workerProtocolGeneration: workerGeneration,
    });
  }

  public observeDurableSettlement(questionId: string) {
    const supported = questionId === supportedQuestionId;
    return Promise.resolve({
      attemptId: `attempt-${questionId}`,
      effectId: `meeting-knowledge-answer:v1:${questionId}`,
      externalReceipt: supported ? supportedAnswerId : unsupportedAnswerId,
      groundingPlanSha256: "b".repeat(64),
      jobId: questionId,
      observedAt: supported ? "2026-08-24T00:03:49.000Z" : "2026-08-24T00:03:59.000Z",
      serviceContainerId: "f".repeat(64),
      serviceHostProcessId: 442,
    });
  }

  public observeCrashReceipts() {
    return Promise.resolve([{
      campaignId: this.input.campaignId,
      crashAfterPublicReplyEffect: true as const,
      crashedHostProcessId: 441,
      crashedWorkerId: "historical_reply_worker_before_crash",
      effectId: `meeting-knowledge-answer:v1:${supportedQuestionId}`,
      externalReceipt: supportedAnswerId,
      injectionId: `public-reply-crash:${this.input.runId}`,
      schemaVersion: 1 as const,
      triggeredAt: "2026-08-24T00:03:45.500Z",
    }]);
  }

  public observePrivateScopeAnswers(input: GovernedCampaignObservationInput) {
    const scope = {
      archivedThreadVisibilities: ["public", "private"] as const,
      endedAt: input.endedAt,
      guildId: input.guildId,
      maximumArchivePagesPerParent: input.maximumArchivePagesPerParent,
      maximumMessagePagesPerSurface: input.maximumMessagePagesPerSurface,
      parentChannelIds: [...input.parentChannelIds],
      startedAt: input.startedAt,
    };
    const parents = input.parentChannelIds.map((parentChannelId) => ({
      archivedAt: null, channelId: parentChannelId, guildId: input.guildId,
      kind: "parent" as const, messageCountInWindow: input.expectedAnswerReceipts.filter(
        ({ channelId: observedChannelId }) => observedChannelId === parentChannelId).length,
      messagePagesRead: 1, parentChannelId, threadVisibility: null,
    }));
    const targetByChannel = new Map([this.input.target, this.input.unsupportedTarget]
      .filter(({ channelId: targetChannelId, parentChannelId }) =>
        targetChannelId !== parentChannelId)
      .map((target) => [target.channelId, target]));
    const activeThreads = [...targetByChannel.values()].map((target) => ({
      archivedAt: null, channelId: target.channelId, guildId: input.guildId,
      kind: "active-thread" as const, messageCountInWindow: input.expectedAnswerReceipts.filter(
        ({ channelId: observedChannelId }) => observedChannelId === target.channelId).length,
      messagePagesRead: 1, parentChannelId: target.parentChannelId,
      threadVisibility: "public" as const,
    }));
    const inventory = [...parents, ...activeThreads]
      .toSorted((left, right) => left.channelId.localeCompare(right.channelId));
    const pagination = {
      activeThreads: { channelIds: activeThreads.map(({ channelId: observedChannelId }) =>
        observedChannelId).toSorted(), complete: true as const },
      archivedThreads: input.parentChannelIds.flatMap((parentChannelId) =>
        input.archivedThreadVisibilities.map((visibility) => ({
          pages: [{ before: null, channelIds: [], hasMore: false, nextBefore: null,
            pageNumber: 1, termination: "no-more" as const }], parentChannelId, visibility,
        }))),
      messages: inventory.map(({ channelId: inventoryChannelId }) => ({
        channelId: inventoryChannelId,
        pages: [{ beforeMessageId: "1536000000000000000",
          messageIds: input.expectedAnswerReceipts.filter(({ channelId: receiptChannelId }) =>
            receiptChannelId === inventoryChannelId).map(({ messageId }) => messageId),
          pageNumber: 1, termination: "short-page" as const }],
        retainedMessageIds: input.expectedAnswerReceipts.filter(({ channelId: receiptChannelId }) =>
          receiptChannelId === inventoryChannelId).map(({ messageId }) => messageId),
      })),
    };
    return Promise.resolve({
      canonicalInventorySha256: governedCampaignObservationFingerprint({ inventory, pagination, scope }),
      inventory,
      pagination,
      receipts: [
        { channelId: this.input.target.channelId, messageId: supportedAnswerId,
          replyToMessageId: supportedQuestionId },
        { channelId: this.input.unsupportedTarget.channelId, messageId: unsupportedAnswerId,
          replyToMessageId: unsupportedQuestionId },
      ],
      scope,
    });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function producerEvidenceFor(
  target: RetainedE2eEvidence,
  intendedActors: readonly { readonly actorId: string;
    readonly kind: "automation" | "human" | "unknown" }[],
) {
  return sealRecordingReadyProducerEvidenceV1({
    actors: intendedActors,
    authoritativeLifecycleCompletion: {
      eventDigestSha256: "e".repeat(64), eventId: `ready-${target.meetingId}`,
      eventType: "recording.authoritative_ready", lifecycleGeneration: 3,
      occurredAt: "2026-08-24T00:00:40.000Z",
      receiptKind: "meeting-platform-completion-receipt-v4",
    },
    craigDeployment: target.deployment.craig,
    identityProvenance: {
      actorObservationState: "consistent", actorSemanticsVersion: 1,
      producerCapabilityId: "meeting.lifecycle.sealed-actor-roster.v1",
      producerRevision: target.deployment.craig.sourceRevision, rosterState: "sealed",
    },
    lifecycleGeneration: 3,
    meetingIdentity: { channelId: "1533228823045214398", guildId,
      meetingId: target.meetingId, recordingId: target.recording.recordingId },
  });
}

function recordingReadyFor(campaign: HistoricalReplyCampaignInputV1) {
  const completion = campaign.producerEvidence.authoritativeLifecycleCompletion;
  return recordingReadyReceiptV2Schema.parse({
    authoritativeSource: {
      eventDigestSha256: completion.eventDigestSha256,
      eventId: completion.eventId,
      eventType: completion.eventType,
      kind: completion.receiptKind,
      lifecycleGeneration: completion.lifecycleGeneration,
      occurredAt: completion.occurredAt,
    },
    meetingId: campaign.producerEvidence.meetingIdentity.meetingId,
    observedAt: "2026-08-24T00:01:00.000Z",
    pinnedTestTarget: {
      guildId,
      provenanceDigestSha256: "7".repeat(64),
      voiceChannelId: "1533228823045214398",
    },
    producerEvidence: campaign.producerEvidence,
    recordingId: campaign.producerEvidence.meetingIdentity.recordingId,
    runId: campaign.runId,
    schemaVersion: 2,
  });
}

function retrievalV2Request() {
  return {
    binding: {
      capabilityFingerprint: "a".repeat(64),
      contractVersion: "context-retrieval.v2" as const,
      indexProfileDigest: "b".repeat(64),
      profileId: "meeting-knowledge.source-profile.v1",
      rankingPolicy: "weighted_rrf_canonical_preferences.v1" as const,
      requiredProviderLanes: ["lexical", "semantic"],
      serviceRevision: "infinity-context-0.2.0",
    },
    budgets: {
      candidateLimit: 100, deadlineMs: 1_000, evidenceByteLimit: 16_000,
      neighborRadius: 0 as const, responseByteLimit: 16_384, resultLimit: 10,
    },
    filters: {
      actorKeys: [], category: null, documentKeys: [], excludedSourceKeys: [],
      kinds: ["record_block"], relativeTimeInterval: null,
      sourceGenerations: [{
        projectionGeneration: "generation-4",
        sourceKey: "historical-release-ref-4",
      }],
      tagsAll: [], tagsAny: [], tagsNone: [], timeInterval: null,
    },
    queries: [{
      query: "What did this meeting say about Meeting Platform?",
      queryId: "question-01", weightMicros: 1_000_000,
    }],
    schemaVersion: 2 as const,
    scope: { memoryScopeId: "guild-memory", spaceId: "meeting-space", threadId: null },
    softPreferences: {
      actorPreferences: [], relativeTimeInterval: null, sourcePreferences: [],
      timeInterval: null, timeWeightMicros: null,
    },
  };
}

function verificationCodes(
  evidence: HistoricalReplyCampaignEvidenceV1,
  runs: readonly RetainedE2eEvidence[],
): string[] {
  const codes: string[] = [];
  verifyHistoricalReplyCampaignEvidence(evidence, runs, (code) => { codes.push(code); });
  return codes;
}

type MutablePayload = {
  attachmentCount: number;
  componentCount: number;
  content: string;
  embeds: Array<Record<string, unknown> & {
    description: string | null;
    url: string | null;
  }>;
  expectedMarkerUrl: string;
  hasActivity: boolean;
  hasCall: boolean;
  hasInteraction: boolean;
  hasPoll: boolean;
  hasRoleSubscriptionData: boolean;
  hasThread: boolean;
  messageSnapshotCount: number;
  stickerCount: number;
};

function completeAnswerPayload(): MutablePayload {
  const expectedMarkerUrl =
    `https://discord-meeting.invalid/knowledge-answer/${"a".repeat(64)}`;
  return {
    attachmentCount: 0,
    componentCount: 0,
    content: "",
    embeds: [{
      description: "Grounded fact.\n-# S1 · 00:00 · turn-1",
      url: expectedMarkerUrl,
    }],
    expectedMarkerUrl,
    hasActivity: false,
    hasCall: false,
    hasInteraction: false,
    hasPoll: false,
    hasRoleSubscriptionData: false,
    hasThread: false,
    messageSnapshotCount: 0,
    stickerCount: 0,
  };
}
