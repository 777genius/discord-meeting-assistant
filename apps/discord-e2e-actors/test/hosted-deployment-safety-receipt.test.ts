import { describe, expect, it } from "vitest";

import {
  assertHostedDeploymentSafetyRevalidatedV1,
  createHostedDeploymentSafetyReceiptV1,
  type HostedDeploymentSafetyExpectationV1,
} from "../src/hosted-deployment-safety-receipt.js";
import { SshDeploymentSafetyProbe } from "../src/ssh-deployment-safety-probe.js";

const hex = (value: string): string => value.repeat(64);
const image = (value: string): string => `sha256:${hex(value)}`;
const revision = (value: string): string => value.repeat(40);

const expectation: HostedDeploymentSafetyExpectationV1 = {
  allowedNetworks: ["discord-meeting-e2e"],
  campaignId: "campaign-1",
  campaignRoot: "/srv/e2e/campaigns",
  deployRoot: "/srv/e2e",
  greeting: {
    destinationPath: "/var/lib/discord-meeting/e2e-playback-readiness",
    environmentRoot: "/var/lib/discord-meeting/e2e-playback-readiness/campaign-1",
    observerRoot: "/srv/e2e/campaigns/campaign-1/run-3/observer",
    runRoot: "/srv/e2e/campaigns/campaign-1/run-3",
    sourcePath: "/srv/e2e/campaigns",
  },
  services: [
    { component: "craig", composeProject: "craig-meeting-e2e", composeService: "bot", sourceRevision: revision("a") },
    { component: "meetingPlatform", composeProject: "discord-meeting-assistant", composeService: "meeting-platform", sourceRevision: revision("b") },
    { component: "pipecat", composeProject: "discord-meeting-assistant", composeService: "pipecat-runtime", sourceRevision: revision("c") },
    { component: "subscriptionRuntime", composeProject: "discord-meeting-assistant", composeService: "subscription-runtime-sidecar", sourceRevision: revision("d") },
  ],
  sourceRoot: "/srv/e2e/source",
};

function service(
  component: "craig" | "meetingPlatform" | "pipecat" | "subscriptionRuntime",
  index: number,
) {
  const expected = expectation.services.find((candidate) => candidate.component === component);
  if (expected === undefined) {throw new Error("test service not found");}
  const digit = String(index);
  return {
    commandSha256: hex("9"),
    component,
    composeConfigHash: hex("8"),
    composeProject: expected.composeProject,
    composeService: expected.composeService,
    containerId: hex(digit),
    containerStartedAt: "2026-08-13T09:00:00.000Z",
    imageId: image(digit),
    networks: ["discord-meeting-e2e"],
    publishedPorts: [],
    repositoryDigest: `registry.test/${component}@sha256:${hex("7")}`,
    sourceRevision: expected.sourceRevision,
    testOnly: "true",
  };
}

function snapshot() {
  return {
    greetingMount: {
      containerGid: 10_001,
      containerUid: 10_001,
      destinationPath: expectation.greeting.destinationPath,
      destinationSymbolicLink: false,
      environmentRoot: expectation.greeting.environmentRoot,
      observerRoot: expectation.greeting.observerRoot,
      readOnly: false,
      runRoot: expectation.greeting.runRoot,
      sourcePath: expectation.greeting.sourcePath,
      sourceSymbolicLink: false,
    },
    roots: {
      deploy: { kind: "directory", requestedPath: expectation.deployRoot, resolvedPath: expectation.deployRoot, symbolicLink: false },
      source: { kind: "directory", requestedPath: expectation.sourceRoot, resolvedPath: expectation.sourceRoot, symbolicLink: false },
    },
    services: [service("craig", 1), service("meetingPlatform", 2), service("pipecat", 3), service("subscriptionRuntime", 4)],
  };
}

function receipt(overrides: {
  readonly after?: ReturnType<typeof snapshot>;
  readonly before?: ReturnType<typeof snapshot>;
  readonly containerObservedHostNonce?: string;
  readonly hostObservedContainerNonce?: string;
} = {}) {
  const before = overrides.before ?? snapshot();
  const after = overrides.after ?? structuredClone(before);
  return createHostedDeploymentSafetyReceiptV1({
    evidence: {
      greetingMount: before.greetingMount,
      greetingMountAfter: after.greetingMount,
      roots: before.roots,
      rootsAfter: after.roots,
      roundTrip: {
        containerObservedHostNonce: overrides.containerObservedHostNonce ?? "host-nonce",
        containerWrittenNonce: "container-nonce",
        hostObservedContainerNonce: overrides.hostObservedContainerNonce ?? "container-nonce",
        hostWrittenNonce: "host-nonce",
        probeRoot: "/srv/e2e/campaigns/.admission-probes/campaign-1",
      },
      servicesAfter: after.services,
      servicesBefore: before.services,
    },
    expectation,
    generatedAt: "2026-08-13T09:01:00.000Z",
  });
}

describe("hosted deployment safety receipt", () => {
  it("accepts exact stable test deployment and bidirectional greeting mount evidence", () => {
    expect(receipt()).toMatchObject({ campaignId: "campaign-1", kind: "hosted-deployment-safety", schemaVersion: 1 });
  });

  it("rejects a service restart between snapshots", () => {
    const after = snapshot();
    after.services[1] = { ...after.services[1]!, containerId: hex("5"), containerStartedAt: "2026-08-13T09:00:30.000Z" };
    expect(() => receipt({ after })).toThrow("deployment changed");
  });

  it.each([
    ["wrong source", (value: ReturnType<typeof snapshot>) => { value.greetingMount.sourcePath = "/srv/e2e/other"; }],
    ["read-only", (value: ReturnType<typeof snapshot>) => { Object.assign(value.greetingMount, { readOnly: true }); }],
    ["symlink", (value: ReturnType<typeof snapshot>) => { Object.assign(value.greetingMount, { sourceSymbolicLink: true }); }],
    ["destination symlink", (value: ReturnType<typeof snapshot>) => { Object.assign(value.greetingMount, { destinationSymbolicLink: true }); }],
    ["uid remap", (value: ReturnType<typeof snapshot>) => { Object.assign(value.greetingMount, { containerUid: 1_000 }); }],
  ])("rejects unsafe greeting mount: %s", (_name, mutate) => {
    const before = snapshot();
    mutate(before);
    expect(() => receipt({ before })).toThrow();
  });

  it("rejects environment-root drift between snapshots", () => {
    const after = snapshot();
    after.greetingMount.environmentRoot = `${after.greetingMount.environmentRoot}-changed`;
    expect(() => receipt({ after })).toThrow("greeting mount changed");
  });

  it("rejects a published port or network outside the allowlist", () => {
    const withPort = snapshot();
    withPort.services[0] = { ...withPort.services[0]!, publishedPorts: [443] as never[] };
    expect(() => receipt({ before: withPort })).toThrow();
    const wrongNetwork = snapshot();
    wrongNetwork.services[0] = { ...wrongNetwork.services[0]!, networks: ["public"] };
    expect(() => receipt({ before: wrongNetwork })).toThrow("network outside");
  });

  it("rejects failed bidirectional nonce observation", () => {
    expect(() => receipt({ containerObservedHostNonce: "stale" })).toThrow("nonce round-trip");
    expect(() => receipt({ hostObservedContainerNonce: "stale" })).toThrow("nonce round-trip");
  });

  it("revalidates the exact deployment fingerprint before child spawn", () => {
    const admitted = receipt();
    expect(assertHostedDeploymentSafetyRevalidatedV1(admitted, receipt())).toEqual(admitted);
    const restarted = snapshot();
    restarted.services[1] = { ...restarted.services[1]!, containerId: hex("5"), containerStartedAt: "2026-08-13T09:02:00.000Z" };
    const revalidated = receipt({ after: structuredClone(restarted), before: restarted });
    expect(() => assertHostedDeploymentSafetyRevalidatedV1(admitted, revalidated))
      .toThrow("changed after safety admission");
  });
});

describe("SshDeploymentSafetyProbe synthetic runner", () => {
  it("brackets the nonce round-trip with two snapshots", async () => {
    const calls: string[] = [];
    const value = snapshot();
    const probe = new SshDeploymentSafetyProbe({
      containerNonce: "container-nonce",
      expectation,
      generatedAt: () => "2026-08-13T09:01:00.000Z",
      hostNonce: "host-nonce",
    }, {
      inspectDeployment: async () => { calls.push("inspect"); return structuredClone(value); },
      observeContainerNonceOnHost: async (root, nonce) => { calls.push(`container:${root}:${nonce}`); return nonce; },
      observeHostNonceInContainer: async (root, nonce) => { calls.push(`host:${root}:${nonce}`); return nonce; },
    });

    await expect(probe.collect()).resolves.toMatchObject({ campaignId: "campaign-1" });
    expect(calls).toEqual([
      "inspect",
      "host:/srv/e2e/campaigns/.admission-probes/campaign-1:host-nonce",
      "container:/srv/e2e/campaigns/.admission-probes/campaign-1:container-nonce",
      "inspect",
    ]);
  });
});
