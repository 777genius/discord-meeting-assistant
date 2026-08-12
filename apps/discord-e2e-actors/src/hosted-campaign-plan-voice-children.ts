import {
  HOSTED_CAMPAIGN_TARGET,
  type HostedCampaignActionReference,
  type HostedCampaignExecutableSpec,
} from "./hosted-campaign-coordinator.js";
import {
  type FixedHostedCampaignRun,
  type HostedCampaignChildContext,
  produced,
  reference,
} from "./hosted-campaign-plan-child-context.js";

export function makeConversationObserver(context: HostedCampaignChildContext): HostedCampaignExecutableSpec {
  const {
    answerFirstPacket, answerIntent, answerObserverReady, barrierPath, captures, conversationCompleted,
    definition, observerSubscribed, paths, reconnect, runVerified, voicePaths,
  } = context;
  return {
    arguments: { kind: "environment" }, childId: "conversation-observer", entrypoint: "conversation-observer",
    completion: { action: conversationCompleted.action, kind: "conversation-observer", outputPaths: voicePaths, runId: reconnect.runId },
    completionAfter: captures[5]!,
    environment: {
      DISCORD_E2E_CONVERSATION_VOICE_ADDITIONAL_CAPTURES_JSON: JSON.stringify([
        { attemptId: `${reconnect.runId}:capture-2`, expectedDuration: { maximumMilliseconds: 2_500, minimumMilliseconds: 2_000 }, outputPath: voicePaths[1], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerAApplicationId}` },
        { attemptId: `${reconnect.runId}:capture-3`, expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 }, outputPath: voicePaths[2], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerBApplicationId}` },
        { attemptId: `${reconnect.runId}:capture-4`, expectedDuration: { maximumMilliseconds: 4_500, minimumMilliseconds: 4_000 }, outputPath: voicePaths[3], purpose: "greeting", turnId: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.speakerDApplicationId}` },
        { expectedDuration: { maximumMilliseconds: 3_500, minimumMilliseconds: 3_000 }, outputPath: voicePaths[4], playbackHandshakeRoot: paths.run(3, "answer-handshakes"), purpose: "addressed-answer" },
        { attemptId: `${reconnect.runId}:capture-6`, expectedDuration: { maximumMilliseconds: 6_500, minimumMilliseconds: 6_000 }, outputPath: voicePaths[5], purpose: "farewell", turnId: "meeting-farewell:v1" },
      ]),
      DISCORD_E2E_CONVERSATION_VOICE_ATTEMPT_ID: `${reconnect.runId}:capture-1`,
      DISCORD_E2E_CONVERSATION_VOICE_CAPTURE_TIMEOUT_MS: "60000",
      DISCORD_E2E_CONVERSATION_VOICE_CAMPAIGN_PROOF_OUTPUT: paths.campaignProof,
      DISCORD_E2E_CONVERSATION_VOICE_CRAIG_BOT_ID: HOSTED_CAMPAIGN_TARGET.botikApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_EXPECTED_DURATION_MS: "1000",
      DISCORD_E2E_CONVERSATION_VOICE_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
      DISCORD_E2E_CONVERSATION_VOICE_GREETING_HANDSHAKE_ROOT: paths.run(3, "greeting-handshakes"),
      DISCORD_E2E_CONVERSATION_VOICE_OBSERVER_APPLICATION_ID: HOSTED_CAMPAIGN_TARGET.observerApplicationId,
      DISCORD_E2E_CONVERSATION_VOICE_OUTPUT: voicePaths[0],
      DISCORD_E2E_CONVERSATION_VOICE_PRIVATE_TEST_GUILD: "private-test-guild",
      DISCORD_E2E_CONVERSATION_VOICE_PURPOSE: "greeting",
      DISCORD_E2E_CONVERSATION_VOICE_RUN_ID: reconnect.runId,
      DISCORD_E2E_CONVERSATION_VOICE_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_CONVERSATION_VOICE_TURN_ID: `participant-greeting:${HOSTED_CAMPAIGN_TARGET.observerApplicationId}`,
      DISCORD_E2E_CONVERSATION_VOICE_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
      DISCORD_E2E_HOSTED_CAMPAIGN_ID: definition.campaignId,
    }, produces: [
      produced(reconnect, observerSubscribed.action, barrierPath("observer-subscribed")),
      ...captures.map((item) => produced(reconnect, item.action, barrierPath(`capture-${item.action.ordinal}`))),
      produced(reconnect, answerIntent.action, barrierPath("answer-intent")),
      produced(reconnect, answerObserverReady.action, barrierPath("answer-observer-ready")),
      produced(reconnect, answerFirstPacket.action, barrierPath("answer-first-packet")),
      produced(reconnect, conversationCompleted.action, barrierPath("conversation-observer-completed")),
    ], requires: [runVerified[1]!], startBefore: { ...observerSubscribed, kind: "barrier" },
  };
}

export function makeActor(
  context: HostedCampaignChildContext,
  run: FixedHostedCampaignRun<1 | 2 | 3>,
  release: HostedCampaignActionReference,
  completionAfter: HostedCampaignActionReference = release,
): HostedCampaignExecutableSpec {
  const { actorPlaybackCompleted, barrierPath, captures, conversationCompleted, definition, paths, reconnectLeft, reconnectReady } = context;
  const completed = reference(run, { kind: "actor-completed", ordinal: run.ordinal, runId: run.runId });
  const gate = (name: string) => ({ armed: paths.run(run.ordinal, `actor-${name}-armed.json`), path: paths.run(run.ordinal, `actor-${name}.json`) });
  const releaseGate = gate("release");
  const playbackGate = gate("playback");
  const endGate = gate("end");
  const speakerBGate = gate("speaker-b");
  return {
    arguments: { kind: "environment" }, childId: `actor-${run.ordinal}`,
    completion: { action: completed.action, kind: "actor", outputPath: paths.run(run.ordinal, "actor.json"), runId: run.runId, scenario: run.scenario },
    completionAfter, entrypoint: "actor", environment: {
      DISCORD_E2E_ACTOR_RUN_OUTPUT: paths.run(run.ordinal, "actor.json"),
      DISCORD_E2E_FIXTURE_MANIFEST: definition.fixtureManifestPath,
      DISCORD_E2E_GUILD_ID: HOSTED_CAMPAIGN_TARGET.guildId,
      DISCORD_E2E_HOSTED_RELEASE_GATE_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_HOSTED_RELEASE_GATE_ARMED_PATH: releaseGate.armed,
      DISCORD_E2E_HOSTED_RELEASE_GATE_PATH: releaseGate.path,
      DISCORD_E2E_HOSTED_RELEASE_GATE_TIMEOUT_MS: "600000",
      ...(run.ordinal === 3 ? {
        DISCORD_E2E_HOSTED_PLAYBACK_GATE_PATH: playbackGate.path,
        DISCORD_E2E_HOSTED_PLAYBACK_GATE_ARMED_PATH: playbackGate.armed,
        DISCORD_E2E_HOSTED_END_GATE_PATH: endGate.path,
        DISCORD_E2E_HOSTED_END_GATE_ARMED_PATH: endGate.armed,
        DISCORD_E2E_HOSTED_SPEAKER_B_GATE_PATH: speakerBGate.path,
        DISCORD_E2E_HOSTED_SPEAKER_B_GATE_ARMED_PATH: speakerBGate.armed,
      } : {}),
      DISCORD_E2E_PLAYBACK_TIMEOUT_MS: "120000", DISCORD_E2E_READY_TIMEOUT_MS: "120000",
      DISCORD_E2E_RECORDER_BOT_ID: HOSTED_CAMPAIGN_TARGET.sutApplicationId,
      DISCORD_E2E_RUN_ID: run.runId, DISCORD_E2E_SCENARIO: run.scenario,
      DISCORD_E2E_SECRET_DIRECTORY: definition.secretDirectory,
      DISCORD_E2E_SPEAKER_A_FIXTURE: definition.speakerFixtures.a,
      DISCORD_E2E_SPEAKER_B_FIXTURE: definition.speakerFixtures.b,
      DISCORD_E2E_VOICE_CHANNEL_ID: HOSTED_CAMPAIGN_TARGET.voiceChannelId,
    }, produces: [
      produced(run, completed.action, barrierPath(`actor-${run.ordinal}-completed`)),
      ...(run.ordinal === 3 ? [produced(run, reconnectLeft.action, barrierPath("reconnect-left")), produced(run, reconnectReady.action, barrierPath("reconnect-ready"))] : []),
      ...(run.ordinal === 3 ? [produced(run, actorPlaybackCompleted.action, barrierPath("actor-playback-completed"))] : []),
    ], releaseGate: { action: release.action, armedPath: releaseGate.armed, ordinal: release.ordinal, path: releaseGate.path, runId: release.runId },
    ...(run.ordinal === 3 ? { actorGates: {
      speakerB: { armedPath: speakerBGate.armed, path: speakerBGate.path, trigger: captures[1]! },
      playback: { armedPath: playbackGate.armed, path: playbackGate.path, trigger: captures[3]! },
      end: { armedPath: endGate.armed, path: endGate.path, trigger: conversationCompleted },
    } } : {}),
    requires: [], startBefore: { ...release, kind: "barrier" },
  };
}

export function makeSupplementalPlayer(context: HostedCampaignChildContext): HostedCampaignExecutableSpec {
  const { actorPlaybackCompleted, barrierPath, captures, conversationCompleted, definition, observerSubscribed, paths, reconnect, runVerified, supplementalCompleted } = context;
  return {
    arguments: { kind: "environment" }, childId: "supplemental-player",
    completion: { action: supplementalCompleted.action, kind: "supplemental-player", outputPath: paths.run(3, "supplemental.json"), runId: reconnect.runId },
    completionAfter: conversationCompleted, entrypoint: "supplemental-player", environment: {
      DISCORD_E2E_SUPPLEMENTAL_CAMPAIGN_ID: definition.campaignId,
      DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_PATH: paths.run(3, "supplemental-connect.gate"),
      DISCORD_E2E_SUPPLEMENTAL_CONNECTION_GATE_ARMED_PATH: paths.run(3, "supplemental-connect.armed.json"),
      DISCORD_E2E_SUPPLEMENTAL_EVIDENCE_OUTPUT: paths.run(3, "supplemental.json"),
      DISCORD_E2E_SUPPLEMENTAL_GATE_TIMEOUT_MS: "120000",
      DISCORD_E2E_SUPPLEMENTAL_MANIFEST: definition.supplementalManifestPath,
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_PATH: paths.run(3, "supplemental-play.gate"),
      DISCORD_E2E_SUPPLEMENTAL_PLAYBACK_GATE_ARMED_PATH: paths.run(3, "supplemental-play.armed.json"),
      DISCORD_E2E_SUPPLEMENTAL_PRIVATE_TEST_GUILD: "private-test-guild",
      DISCORD_E2E_SUPPLEMENTAL_RUN_ID: reconnect.runId,
      DISCORD_E2E_SUPPLEMENTAL_SECRET_DIRECTORY: definition.secretDirectory,
    }, produces: [produced(reconnect, supplementalCompleted.action, barrierPath("supplemental-completed"))],
    requires: [runVerified[1]!], startBefore: { ...observerSubscribed, kind: "barrier" },
    supplementalGates: {
      connection: { armedPath: paths.run(3, "supplemental-connect.armed.json"), path: paths.run(3, "supplemental-connect.gate"), trigger: captures[2]! },
      playback: { armedPath: paths.run(3, "supplemental-play.armed.json"), path: paths.run(3, "supplemental-play.gate"), trigger: actorPlaybackCompleted },
    },
  };
}
