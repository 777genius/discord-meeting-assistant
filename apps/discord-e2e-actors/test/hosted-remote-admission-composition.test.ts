import { describe, expect, it, vi } from "vitest";

import {
  createHostedCampaignRemoteAdmissionProbe,
  createHostedDeploymentSafetyRevalidator,
  type HostedRemoteAdmissionCompositionConfig,
} from "../src/hosted-remote-admission-composition.js";
import {
  createHostedDeploymentSafetyReceiptV1,
  type HostedDeploymentSafetyExpectationV1,
} from "../src/hosted-deployment-safety-receipt.js";
import { digestVoicetextCanaryExpectationV1 } from "../src/hosted-voicetext-semantic-canary-producer.js";
import { evaluateHostedRemoteAdmission } from "../src/hosted-campaign-remote-admission.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-target.js";

const now = Date.parse("2026-08-13T09:01:00.000Z");
const campaignId = "campaign-1";
const planSha256 = "6".repeat(64);
const revision = "b".repeat(40);
const imageDigestSha256 = "7".repeat(64);
const containerId = "2".repeat(64);
const secret = `never-retain-${"x".repeat(60)}`;
const expectedSegments = [{ endMs: 1_000, startMs: 0, text: "hello Botik" }] as const;

describe("hosted remote admission composition", () => {
  it("runs fresh full producers in safe order and admits their exact receipts", async () => {
    const calls: string[] = [];
    const config = composition(calls);
    const probe = createHostedCampaignRemoteAdmissionProbe(config);
    const result = await evaluateHostedRemoteAdmission(probe, {
      campaignId, meetingPlatformRevision: revision, planSha256,
    }, now);

    expect(result.missingSections).toEqual([]);
    expect(result.readiness).toMatchObject({ campaignId, planSha256 });
    expect(calls).toEqual([
      "deployment", "discord:botikPlayback", "discord:localObserver", "discord:localSpeakerA",
      "discord:localSpeakerB", "discord:localSpeakerD", "discord:localSut", "voicetext", "clock",
      "deployment",
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("fails closed when any producer fails and does not continue to admission", async () => {
    const calls: string[] = [];
    const config = composition(calls);
    const failing = {
      ...config,
      voicetext: { ...config.voicetext, runner: { run: async () => { throw new Error(`provider failed ${secret}`); } } },
    };
    const probe = createHostedCampaignRemoteAdmissionProbe(failing);
    await expect(evaluateHostedRemoteAdmission(probe, {
      campaignId, meetingPlatformRevision: revision, planSha256,
    }, now)).rejects.toThrow("provider failed");
    expect(calls).not.toContain("clock");
  });

  it.each([
    ["WER/CER", [{ endMs: 1_000, startMs: 0, text: "completely wrong Botik transcript" }]],
    ["required terms", [{ endMs: 1_000, startMs: 0, text: "hello assistant" }]],
    ["timeline", [{ endMs: 1_251, startMs: 251, text: "hello Botik" }]],
  ] as const)("blocks a canary that violates pinned %s thresholds", async (_label, segments) => {
    const config = composition([]);
    const probe = createHostedCampaignRemoteAdmissionProbe({
      ...config,
      voicetext: {
        ...config.voicetext,
        runner: { run: async () => voicetextResult(segments) },
      },
    });
    await expect(evaluateHostedRemoteAdmission(probe, {
      campaignId, meetingPlatformRevision: revision, planSha256,
    }, now)).rejects.toThrow("quality thresholds");
  });

  it("rejects an arbitrary request or configuration instead of treating it as authorization", async () => {
    const config = composition([]);
    const probe = createHostedCampaignRemoteAdmissionProbe(config);
    await expect(probe.inspect({ campaignId: "operator-substitute", meetingPlatformRevision: revision, planSha256 }))
      .rejects.toThrow("trusted runtime binding");
    expect(() => createHostedCampaignRemoteAdmissionProbe({
      ...config, planSha256: "8".repeat(64),
    })).toThrow("exact private deployment and plan");
    expect(() => createHostedCampaignRemoteAdmissionProbe({
      ...config,
      voicetext: { ...config.voicetext,
        fixtureExpectation: { ...config.voicetext.fixtureExpectation, maximumWordErrorRate: 1 } },
    })).toThrow();
  });

  it("blocks without a constructed trusted producer", async () => {
    await expect(evaluateHostedRemoteAdmission(undefined, {
      campaignId, meetingPlatformRevision: revision, planSha256,
    }, now)).resolves.toEqual({
      missingSections: ["deploymentSafety", "discordIdentity", "voicetextCanary", "clockPreflight"],
    });
  });

  it("freshly revalidates deployment fingerprint immediately before campaign start", async () => {
    const expectation = deploymentExpectation();
    const collect = vi.fn(async () => deploymentReceipt(expectation));
    const revalidate = createHostedDeploymentSafetyRevalidator({ collect });
    const admitted = deploymentReceipt(expectation);
    const baseline = JSON.parse(JSON.stringify({
      campaignId: admitted.campaignId,
      deploymentFingerprint: admitted.deploymentFingerprint,
      expectationSha256: admitted.expectationSha256,
      kind: "hosted-deployment-revalidation-baseline",
      schemaVersion: 1,
    })) as Parameters<typeof revalidate>[0];
    await expect(revalidate(baseline)).resolves.toBeUndefined();
    expect(collect).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(revalidate(baseline, controller.signal)).rejects.toThrow("cancelled");
    expect(collect).toHaveBeenCalledOnce();
  });
});

function composition(calls: string[]): HostedRemoteAdmissionCompositionConfig {
  const expectation = deploymentExpectation();
  const ids = {
    botikPlayback: [HOSTED_CAMPAIGN_TARGET.botikApplicationId, tokenFile("botik-playback", true)],
    localObserver: [HOSTED_CAMPAIGN_TARGET.observerApplicationId, tokenFile("conversation-observer")],
    localSpeakerA: [HOSTED_CAMPAIGN_TARGET.speakerAApplicationId, tokenFile("speaker-a")],
    localSpeakerB: [HOSTED_CAMPAIGN_TARGET.speakerBApplicationId, tokenFile("speaker-b")],
    localSpeakerD: [HOSTED_CAMPAIGN_TARGET.speakerDApplicationId, tokenFile("speaker-d")],
    localSut: [HOSTED_CAMPAIGN_TARGET.sutApplicationId, tokenFile("sut")],
  } as const;
  const roles = Object.fromEntries(Object.entries(ids).map(([name, [applicationId, file]]) => [name, {
    expectation: { applicationId, tokenFile: file },
    probe: { probe: async () => {
      calls.push(`discord:${name}`);
      return { applicationId, authenticatedUserId: applicationId, bot: true as const,
        tokenFile: { ...file, generationId: `generation-${name}`, mode: 0o600 as const },
        verificationSource: "discord-current-application-and-user" as const };
    } },
  }])) as unknown as HostedRemoteAdmissionCompositionConfig["discord"]["roles"];
  const binding = { campaignId, containerId, host: HOSTED_CAMPAIGN_TARGET.host,
    imageDigestSha256, planSha256, sourceRevision: revision } as const;
  return {
    campaignId,
    clock: { collectClockPreflight: async () => { calls.push("clock"); return clockExchange(); } },
    deployment: {
      expectation,
      producer: { collect: async () => { calls.push("deployment"); return deploymentReceipt(expectation); } },
    },
    discord: {
      binding, expiresAtEpochMs: now + 30_000, generatedAtEpochMs: now, roles,
      target: { deploymentScope: HOSTED_CAMPAIGN_TARGET.deploymentScope,
        environment: HOSTED_CAMPAIGN_TARGET.environment, guildId: HOSTED_CAMPAIGN_TARGET.guildId,
        mutationTarget: HOSTED_CAMPAIGN_TARGET.mutationTarget,
        publicationChannelId: HOSTED_CAMPAIGN_TARGET.publicationChannelId,
        voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId },
    },
    meetingPlatformRevision: revision,
    planSha256,
    voicetext: {
      fixtureExpectation: {
        maximumCharacterErrorRate: 0.15,
        maximumTimelineDeltaMs: 250,
        maximumWordErrorRate: 0.2,
      },
      input: {
        binding: { ...binding, fixtureSha256: "5".repeat(64),
          transcriptExpectationSha256: digestVoicetextCanaryExpectationV1(expectedSegments) },
        endpoint: { batch: { origin: "https://voicetext.test", path: "/v2/listen" },
          live: { origin: "wss://voicetext.test", path: "/v1/listen" } },
        expectedSegments, fixturePath: "/fixtures/canary.ogg", generatedAtEpochMs: now,
        requiredTerms: ["Botik"], timeoutMs: 30_000, ttlMs: 30_000,
      },
      runner: { run: async () => { calls.push("voicetext"); return voicetextResult(); } },
    },
  };
}

function tokenFile(
  account: "botik-playback" | "conversation-observer" | "speaker-a" | "speaker-b" | "speaker-d" | "sut",
  remote = false,
) {
  return { account, ownerUid: 10_001, path: `/run/test-tokens/${account}`,
    scope: remote ? "remote-deployment-secret" as const : "local-campaign-secret" as const };
}

function deploymentExpectation(): HostedDeploymentSafetyExpectationV1 {
  const service = (component: "craig" | "meetingPlatform" | "pipecat" | "subscriptionRuntime", digit: string, serviceName: string) => ({
    component, composeProject: component === "craig" ? "craig-meeting-e2e" : "discord-meeting-assistant",
    composeService: serviceName, imageId: `sha256:${digit.repeat(64)}`,
    repositoryDigest: `registry.test/${component}@sha256:${imageDigestSha256}`,
    sourceRevision: component === "meetingPlatform" ? revision : digit.repeat(40),
  });
  return {
    allowedNetworks: ["discord-meeting-e2e"], campaignId, campaignRoot: "/srv/e2e/campaigns",
    deployRoot: "/srv/e2e", sourceRoot: "/srv/e2e/source",
    greeting: {
      campaignSiblingPath: "/srv/e2e/campaigns/.greeting-mounts/campaign-2/run-3",
      destinationPath: "/var/lib/discord-meeting/e2e-playback-readiness/campaign-1/run-3",
      environmentRoot: "/var/lib/discord-meeting/e2e-playback-readiness/campaign-1/run-3/greeting-handshakes",
      observerRoot: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3/greeting-handshakes",
      runRoot: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3",
      runSiblingPath: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-2",
      sourcePath: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3",
    },
    services: [service("craig", "1", "bot"), service("meetingPlatform", "2", "meeting-platform"),
      service("pipecat", "3", "pipecat-runtime"), service("subscriptionRuntime", "4", "subscription-runtime-sidecar")],
  };
}

function deploymentReceipt(expectation: HostedDeploymentSafetyExpectationV1) {
  const services = expectation.services.map((value) => ({
    commandSha256: "9".repeat(64), ...value, composeConfigHash: "8".repeat(64),
    containerId: value.component === "meetingPlatform" ? containerId : value.imageId.slice(7),
    containerStartedAt: "2026-08-13T09:00:00.000Z", networks: ["discord-meeting-e2e"],
    publishedPorts: [], testOnly: "true" as const,
  }));
  const greetingMount = { containerGid: 10_001 as const, containerUid: 10_001 as const,
    destinationPath: expectation.greeting.destinationPath, destinationSymbolicLink: false as const,
    environmentRoot: expectation.greeting.environmentRoot, observerRoot: expectation.greeting.observerRoot,
    readOnly: false as const, runRoot: expectation.greeting.runRoot, sourcePath: expectation.greeting.sourcePath,
    sourceSymbolicLink: false as const };
  const mountIsolation = { campaignSiblingAccessible: false as const, campaignSiblingMounted: false as const,
    campaignSiblingPath: expectation.greeting.campaignSiblingPath, runSiblingAccessible: false as const,
    runSiblingMounted: false as const, runSiblingPath: expectation.greeting.runSiblingPath };
  const roots = { deploy: { kind: "directory" as const, requestedPath: expectation.deployRoot, resolvedPath: expectation.deployRoot, symbolicLink: false as const },
    source: { kind: "directory" as const, requestedPath: expectation.sourceRoot, resolvedPath: expectation.sourceRoot, symbolicLink: false as const } };
  return createHostedDeploymentSafetyReceiptV1({ expectation, generatedAt: new Date(now).toISOString(), evidence: {
    greetingMount, greetingMountAfter: greetingMount, mountIsolation, mountIsolationAfter: mountIsolation,
    roots, rootsAfter: roots, servicesBefore: services, servicesAfter: services,
    roundTrip: { containerObservedHostNonce: "host-nonce", containerWrittenNonce: "container-nonce",
      hostObservedContainerNonce: "container-nonce", hostWrittenNonce: "host-nonce",
      probeRoot: `${expectation.greeting.sourcePath}/.admission-probes` },
  } });
}

function clockExchange() {
  return { observer: { before: { bootId: "observer", epochMs: now - 10, monotonicNs: "1000000000" },
    after: { bootId: "observer", epochMs: now, monotonicNs: "1010000000" } }, observerClockId: "observer-clock",
  source: { before: { bootId: "source", epochMs: now - 5, monotonicNs: "1005000000" },
    sample: { bootId: "source", epochMs: now - 3, monotonicNs: "1007000000" },
    after: { bootId: "source", epochMs: now - 2, monotonicNs: "1008000000" } }, sourceClockId: "source-clock",
  target: { environment: HOSTED_CAMPAIGN_TARGET.environment, host: HOSTED_CAMPAIGN_TARGET.host,
    project: HOSTED_CAMPAIGN_TARGET.project } };
}

function voicetextResult(
  segments: readonly { readonly endMs: number; readonly startMs: number; readonly text: string }[] = expectedSegments,
) {
  const digest = digestVoicetextCanaryExpectationV1(segments);
  return { batch: { firstSubmission: { jobId: "job", resultId: "result", resultSha256: digest },
    idempotentReplay: { jobId: "job", resultId: "result", resultSha256: digest }, segments, utteranceCount: 1 },
  live: { audioAcknowledgements: { expected: 1, received: 1 }, finalizeComplete: true, protocolReady: true,
    segments }, schemaVersion: 1,
  tokenFile: { generationId: "generation-voicetext", mode: 0o600, ownerUid: 10_001,
    path: "/run/secrets/voicetext" } };
}
