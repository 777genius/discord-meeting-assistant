import { describe, expect, it } from "vitest";

import type { HostedDeploymentSafetyExpectationV1 } from "../src/hosted-deployment-safety-receipt.js";
import { createConcreteSshDeploymentSafetyProbe } from "../src/ssh-deployment-safety-probe-factory.js";
import { ConcreteSshDeploymentSafetyProbeRunner } from "../src/ssh-deployment-safety-runner.js";
import type { SshDeploymentProbeOptions } from "../src/ssh-deployment-probe-validation.js";

const hex = (value: string): string => value.repeat(64);
const image = (value: string): string => `sha256:${hex(value)}`;
const revision = (value: string): string => value.repeat(40);
const digest = `registry.test/service@sha256:${hex("7")}`;

const expectation: HostedDeploymentSafetyExpectationV1 = {
  allowedNetworks: ["discord-meeting-e2e"],
  campaignId: "campaign-1",
  campaignRoot: "/srv/e2e/campaigns",
  deployRoot: "/srv/e2e",
  greeting: {
    campaignSiblingPath: "/srv/e2e/campaigns/.greeting-mounts/campaign-2/run-3",
    destinationPath: "/var/lib/discord-meeting/e2e-playback-readiness/campaign-1/run-3",
    environmentRoot: "/var/lib/discord-meeting/e2e-playback-readiness/campaign-1/run-3/greeting-handshakes",
    observerRoot: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3/greeting-handshakes",
    runRoot: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3",
    runSiblingPath: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-2",
    sourcePath: "/srv/e2e/campaigns/.greeting-mounts/campaign-1/run-3",
  },
  services: [
    serviceExpectation("craig", "craig-meeting-e2e", "bot", "1", "a"),
    serviceExpectation("meetingPlatform", "discord-meeting-assistant", "meeting-platform", "2", "b"),
    serviceExpectation("pipecat", "discord-meeting-assistant", "pipecat-runtime", "3", "c"),
    serviceExpectation("subscriptionRuntime", "discord-meeting-assistant", "subscription-runtime-sidecar", "4", "d"),
  ],
  sourceRoot: "/srv/e2e/source",
};

const ssh: SshDeploymentProbeOptions = {
  composeFile: "/srv/e2e/compose.yaml",
  craigProjectName: "craig-meeting-e2e",
  craigServiceName: "bot",
  envFile: "/srv/e2e/.env",
  host: "private-test-host",
  mutationTarget: "test-only",
  projectName: "discord-meeting-assistant",
  sourceRoot: "/srv/e2e/source",
  timeoutMs: 5_000,
};

function serviceExpectation(
  component: HostedDeploymentSafetyExpectationV1["services"][number]["component"],
  composeProject: string,
  composeService: string,
  digit: string,
  revisionDigit: string,
) {
  return {
    component,
    composeProject,
    composeService,
    imageId: image(digit),
    repositoryDigest: digest,
    sourceRevision: revision(revisionDigit),
  };
}

function dockerContainer(service: HostedDeploymentSafetyExpectationV1["services"][number]) {
  return {
    Config: {
      Cmd: ["node", "dist/main.js"],
      Entrypoint: ["/sbin/tini", "--"],
      Env: [
        "DISCORD_E2E_TEST_ONLY=true",
        `CONVERSATION_E2E_GREETING_PLAYBACK_READINESS_ROOT=${expectation.greeting.environmentRoot}`,
      ],
      Labels: {
        "com.docker.compose.config-hash": hex("8"),
        "com.docker.compose.project": service.composeProject,
        "com.docker.compose.service": service.composeService,
        "e2e.test-only": "true",
      },
    },
    Id: hex(service.imageId.slice(7, 8)),
    Image: service.imageId,
    Mounts: service.component === "meetingPlatform" ? [{
      Destination: expectation.greeting.destinationPath,
      RW: true,
      Source: expectation.greeting.sourcePath,
      Type: "bind",
    }] : [],
    NetworkSettings: {
      Networks: { "discord-meeting-e2e": {} },
      Ports: {},
    },
    State: { StartedAt: "2026-08-13T09:00:00.000Z" },
  };
}

class SyntheticRemote {
  public readonly calls: string[][] = [];
  readonly #containers = new Map(expectation.services.map((service) => [service.imageId, dockerContainer(service)]));

  public readonly runRemote = async (_settings: unknown, args: readonly string[]): Promise<string> => {
    this.calls.push([...args]);
    if (args[0] === "sh" && args[2]?.includes("readlink -e")) {
      return `${args.at(-1) ?? ""}\n`;
    }
    if (args[0] === "sh" && args[2]?.includes("resolved=$(readlink")) {
      return "false";
    }
    if (args[0] === "docker" && args[1] === "ps") {
      const serviceLabel = args.find((value) => value.startsWith("label=com.docker.compose.service="));
      const serviceName = serviceLabel?.split("=").at(-1);
      const service = expectation.services.find(({ composeService }) => composeService === serviceName);
      if (service === undefined) {throw new Error("unknown synthetic service");}
      return `${hex(service.imageId.slice(7, 8))}\n`;
    }
    if (args[0] === "docker" && args[1] === "inspect") {
      const id = args.at(-1);
      const container = [...this.#containers.values()].find(({ Id }) => Id === id);
      return JSON.stringify([container]);
    }
    if (args[0] === "docker" && args[1] === "image") {
      const imageId = args.at(-1);
      const service = expectation.services.find(({ imageId: expected }) => expected === imageId);
      return JSON.stringify([{ Config: { Labels: { "org.opencontainers.image.revision": service?.sourceRevision } }, Id: imageId, RepoDigests: [digest] }]);
    }
    if (args[0] === "docker" && args[1] === "exec") {
      return "10001|10001|false\n";
    }
    if (args[0] === "sh" && args[2]?.includes("host-nonce")) {
      return `${args.at(-1) ?? ""}\n`;
    }
    if (args[0] === "sh" && args[2]?.includes("container-nonce")) {
      return `${args.at(-1) ?? ""}\n`;
    }
    throw new Error(`unexpected synthetic command: ${args.join(" ")}`);
  };

  public exposeCampaignSibling(): void {
    const meeting = this.#containers.get(image("2"));
    meeting?.Mounts.push({
      Destination: "/broad",
      RW: true,
      Source: "/srv/e2e/campaigns/.greeting-mounts",
      Type: "bind",
    });
  }
}

describe("concrete SSH deployment safety runner", () => {
  it("builds a verified receipt using fixed argv commands and scoped nonce cleanup scripts", async () => {
    const remote = new SyntheticRemote();
    const probe = createConcreteSshDeploymentSafetyProbe({
      containerNonce: "container-nonce",
      expectation,
      generatedAt: () => "2026-08-13T09:01:00.000Z",
      hostNonce: "host-nonce",
      ssh,
    }, remote);

    await expect(probe.collect()).resolves.toMatchObject({
      campaignId: "campaign-1",
      kind: "hosted-deployment-safety",
      schemaVersion: 1,
    });
    expect(remote.calls.some((args) => args[0] === "docker" && args[1] === "inspect" && args[2] === "--type"))
      .toBe(true);
    const nonceCalls = remote.calls.filter((args) => args[0] === "sh" && args[1] === "-ceu"
      && args[2]?.includes("nonce"));
    expect(nonceCalls).toHaveLength(2);
    expect(nonceCalls.every((args) => args[2]?.includes("trap cleanup EXIT HUP INT TERM"))).toBe(true);
    expect(nonceCalls.every((args) => args.includes(expectation.greeting.sourcePath + "/.admission-probes"))).toBe(true);
  });

  it("reports sibling access instead of authorizing a broad mount", async () => {
    const remote = new SyntheticRemote();
    remote.exposeCampaignSibling();
    const runner = new ConcreteSshDeploymentSafetyProbeRunner(ssh, expectation, remote);
    await expect(runner.inspectMountIsolation(
      expectation.greeting.sourcePath,
      expectation.greeting.campaignSiblingPath,
      expectation.greeting.runSiblingPath,
    )).resolves.toMatchObject({
      campaignSiblingAccessible: true,
      campaignSiblingMounted: false,
      runSiblingAccessible: true,
    });
  });

  it("rejects shell-shaped host configuration before any command runs", () => {
    const remote = new SyntheticRemote();
    expect(() => new ConcreteSshDeploymentSafetyProbeRunner(
      { ...ssh, host: "test-host;touch /tmp/owned" },
      expectation,
      remote,
    )).toThrow();
    expect(remote.calls).toHaveLength(0);
  });
});
