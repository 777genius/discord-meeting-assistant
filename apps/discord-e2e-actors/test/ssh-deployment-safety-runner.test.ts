import { describe, expect, it } from "vitest";

import { proveCraigFirewallPolicy } from "../src/craig-network-policy-proof.js";
import type { HostedDeploymentSafetyExpectationV1 } from "../src/hosted-deployment-safety-receipt.js";
import { createConcreteSshDeploymentSafetyProbe } from "../src/ssh-deployment-safety-probe-factory.js";
import {
  ConcreteSshDeploymentSafetyProbeRunner,
} from "../src/ssh-deployment-safety-runner.js";
import type { SshDeploymentProbeOptions } from "../src/ssh-deployment-probe-validation.js";

const hex = (value: string): string => value.repeat(64);
const image = (value: string): string => `sha256:${hex(value)}`;
const revision = (value: string): string => value.repeat(40);
const digest = `registry.test/service@sha256:${hex("7")}`;

const expectation: HostedDeploymentSafetyExpectationV1 = {
  allowedNetworks: ["discord-meeting-e2e"],
  campaignId: "campaign-1",
  campaignRoot: "/srv/e2e/campaigns",
  campaignRootOwnerGid: 10_001,
  campaignRootOwnerUid: 10_001,
  craigNetworkPolicy: { bridgeInterface: "br-craige2e", chain: "CRAIG_E2E",
    databaseIpv4: "172.28.0.3", networkName: "discord-meeting-e2e", projectName: "craig-meeting-e2e",
    tcpDestinationPort: 443,
    udpDestinationPorts: { end: 65_535, start: 1_024 } },
  deployRoot: "/srv/e2e",
  greeting: {
    campaignSiblingPath: "/srv/e2e/campaigns-sibling",
    destinationPath: "/run/e2e-campaign",
    environmentRoot: "/run/e2e-campaign/campaign-1/run-3/greeting-handshakes",
    observerRoot: "/srv/e2e/campaigns/campaign-1/run-3/greeting-handshakes",
    runRoot: "/srv/e2e/campaigns/campaign-1/run-3",
    runSiblingPath: "/srv/e2e/campaigns/campaign-1/run-2",
    sourcePath: "/srv/e2e/campaigns",
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
    containerId: hex(digit),
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
      Networks: { "discord-meeting-e2e": {
        IPAddress: service.component === "craig" ? "172.28.0.2" : "172.28.0.3",
        NetworkID: hex("a"),
      } },
      Ports: {},
    },
    State: { StartedAt: "2026-08-13T09:00:00.000Z" },
  };
}

class SyntheticRemote {
  public readonly calls: string[][] = [];
  public campaignEntries: readonly string[] = [expectation.campaignId];
  public firewall = firewallRules();
  readonly #containers = new Map(expectation.services.map((service) => [service.imageId, dockerContainer(service)]));

  public readonly runRemote = async (_settings: unknown, args: readonly string[]): Promise<string> => {
    this.calls.push([...args]);
    switch (args[0]) {
      case "sh": return this.#runShell(args);
      case "docker": return this.#runDocker(args);
      case "iptables-save": return this.firewall;
      case undefined:
      default: throw new Error(`unexpected synthetic command: ${args.join(" ")}`);
    }
  };

  #runShell(args: readonly string[]): string {
    const script = args[2] ?? "";
    if (script.includes("campaign_id=$2")) {
      const entries = Buffer.from(`${this.campaignEntries.join("\0")}\0`).toString("base64");
      return `10001|10001|700|3|${expectation.campaignRoot}\n${entries}\n`;
    }
    if (script.includes("readlink -e")) {
      return `${args.at(-1) ?? ""}\n`;
    }
    if (script.includes("resolved=$(readlink")) {
      return "false";
    }
    if (script.includes("host-nonce") || script.includes("container-nonce")) {
      return `${args.at(-1) ?? ""}\n`;
    }
    throw new Error(`unexpected synthetic shell command: ${args.join(" ")}`);
  }

  #runDocker(args: readonly string[]): string {
    switch (args[1]) {
      case "ps": return this.#dockerPs(args);
      case "inspect": return this.#dockerInspect(args);
      case "network": return JSON.stringify([{
        Driver: "bridge",
        Id: hex("a"),
        Internal: false,
        Name: "discord-meeting-e2e",
        Options: { "com.docker.network.bridge.name": "br-craige2e" },
      }]);
      case "image": return this.#dockerImage(args);
      case "exec": return "10001|10001|false\n";
      case undefined:
      default: throw new Error(`unexpected synthetic docker command: ${args.join(" ")}`);
    }
  }

  #dockerPs(args: readonly string[]): string {
    const serviceLabel = args.find((value) => value.startsWith("label=com.docker.compose.service="));
    const serviceName = serviceLabel?.split("=").at(-1);
    const service = expectation.services.find(({ composeService }) => composeService === serviceName);
    if (service === undefined) {
      throw new Error("unknown synthetic service");
    }
    return `${hex(service.imageId.slice(7, 8))}\n`;
  }

  #dockerInspect(args: readonly string[]): string {
    const id = args.at(-1);
    const container = [...this.#containers.values()].find(({ Id }) => Id === id);
    return JSON.stringify([container]);
  }

  #dockerImage(args: readonly string[]): string {
    const imageId = args.at(-1);
    const service = expectation.services.find(({ imageId: expected }) => expected === imageId);
    return JSON.stringify([{
      Config: { Labels: { "org.opencontainers.image.revision": service?.sourceRevision } },
      Id: imageId,
      RepoDigests: [digest],
    }]);
  }

  public exposeCampaignSibling(): void {
    const meeting = this.#containers.get(image("2"));
    meeting?.Mounts.push({
      Destination: "/broad",
      RW: true,
      Source: "/srv/e2e",
      Type: "bind",
    });
  }

  public exposeHostRoot(): void {
    const meeting = this.#containers.get(image("2"));
    meeting?.Mounts.push({
      Destination: "/host-root",
      RW: true,
      Source: "/",
      Type: "bind",
    });
  }
}

function firewallRules(earlierForward = "", laterForward = ""): string {
  return `# Generated by iptables-save v1.8\n*filter
:FORWARD DROP [4:400]
:CRAIG_E2E - [0:0]
${earlierForward}-A FORWARD -i br-craige2e -s 172.28.0.2/32 -j CRAIG_E2E
[9:900] -A FORWARD -o br-craige2e -d 172.28.0.2/32 -j CRAIG_E2E
${laterForward}-A CRAIG_E2E -s 172.28.0.2/32 -i br-craige2e -p tcp -m conntrack --ctstate NEW,ESTABLISHED --dport 443 -j ACCEPT
-A CRAIG_E2E -s 172.28.0.2/32 -d 172.28.0.3/32 -i br-craige2e -p tcp -m conntrack --ctstate NEW,ESTABLISHED --dport 5432 -j ACCEPT
-A CRAIG_E2E -i br-craige2e -s 172.28.0.2/32 -p udp -m conntrack --ctstate ESTABLISHED,NEW --dport 1024:65535 -j ACCEPT
-A CRAIG_E2E -o br-craige2e -d 172.28.0.2/32 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
-A CRAIG_E2E -j DROP
COMMIT
`;
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
      schemaVersion: 2,
    });
    expect(remote.calls.some((args) => args[0] === "docker" && args[1] === "inspect" && args[2] === "--type"))
      .toBe(true);
    expect(remote.calls.some((args) => args[0] === "sh" && args[2]?.includes("campaign_id=$2") === true))
      .toBe(true);
    expect(remote.calls.some((args) => args.join(" ") === "iptables-save -c -t filter")).toBe(true);
    const nonceCalls = remote.calls.filter((args) => args[0] === "sh" && args[1] === "-ceu"
      && args[2]?.includes("nonce") === true);
    expect(nonceCalls).toHaveLength(2);
    expect(nonceCalls.every((args) =>
      args[2]?.includes("trap cleanup EXIT HUP INT TERM") === true)).toBe(true);
    expect(nonceCalls.every((args) => args.includes(expectation.greeting.runRoot + "/.admission-probes"))).toBe(true);
  });

  it("canonicalizes counter and harmless order noise but changes on semantic policy", () => {
    const base = { bridgeInterface: "br-craige2e", containerId: hex("1"), containerIpv4: "172.28.0.2",
      networkId: hex("a"), policy: expectation.craigNetworkPolicy };
    const first = proveCraigFirewallPolicy({ ...base, firewall: firewallRules(
      "[1:10] -A FORWARD -i br-craige2e -s 203.0.113.8/32 -j DROP\n",
    ) });
    const second = proveCraigFirewallPolicy({ ...base, firewall: firewallRules(
      "[999:9999] -A FORWARD -i br-craige2e -s 198.51.100.7/32 -j REJECT\n",
    ).replace("[9:900]", "[100:10000]") });
    expect(first.semanticPolicySha256).toBe(second.semanticPolicySha256);
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules().replace(
      "--dport 443", "--dport 8443",
    ) })).toThrow("exact TCP 443");
  });

  it("rejects wrong source, earlier shadowing, broad bypass, and a rule swap", () => {
    const base = { bridgeInterface: "br-craige2e", containerId: hex("1"), containerIpv4: "172.28.0.2",
      networkId: hex("a"), policy: expectation.craigNetworkPolicy };
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules().replace(
      /172\.28\.0\.2\/32/gu, "172.28.0.9/32",
    ) })).toThrow();
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules(
      "-A FORWARD -i br-craige2e -s 172.28.0.2/32 -j DROP\n",
    ) })).toThrow("shadowed");
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules().replace(
      "-A CRAIG_E2E -j DROP", "-A CRAIG_E2E -j ACCEPT\n-A CRAIG_E2E -j DROP",
    ) })).toThrow("exact TCP 443");
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules().replace(
      "-o br-craige2e -d 172.28.0.2/32", "-o br-craige2e -d 172.28.0.3/32",
    ) })).toThrow();
    expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules().replace(
      "-A CRAIG_E2E -s", "-A CRAIG_E2E -j DROP\n-A CRAIG_E2E -s",
    ).replace("\n-A CRAIG_E2E -j DROP\nCOMMIT", "\nCOMMIT") })).toThrow("terminal unconditional drop");
  });

  it.each(["ACCEPT", "BROAD_EGRESS"])(
    "rejects terminal RETURN before a later broad FORWARD %s",
    (laterTarget) => {
      const base = { bridgeInterface: "br-craige2e", containerId: hex("1"), containerIpv4: "172.28.0.2",
        networkId: hex("a"), policy: expectation.craigNetworkPolicy };
      const laterForward = `-A FORWARD -i br-craige2e -s 172.28.0.2/32 -j ${laterTarget}\n`;
      expect(() => proveCraigFirewallPolicy({ ...base, firewall: firewallRules("", laterForward).replace(
        "-A CRAIG_E2E -j DROP", "-A CRAIG_E2E -j RETURN",
      ) })).toThrow("unreviewed semantic rule");
    },
  );

  it("accepts terminal DROP when a later broad FORWARD accept is unreachable", () => {
    const base = { bridgeInterface: "br-craige2e", containerId: hex("1"), containerIpv4: "172.28.0.2",
      networkId: hex("a"), policy: expectation.craigNetworkPolicy };
    const laterForward = "-A FORWARD -i br-craige2e -s 172.28.0.2/32 -j ACCEPT\n";
    expect(() => proveCraigFirewallPolicy({
      ...base,
      firewall: firewallRules("", laterForward),
    })).not.toThrow();
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
    const probe = createConcreteSshDeploymentSafetyProbe({
      containerNonce: "container-nonce", expectation,
      generatedAt: () => "2026-08-13T09:01:00.000Z", hostNonce: "host-nonce", ssh,
    }, remote);
    await expect(probe.collect()).rejects.toThrow();
  });

  it("reports sibling access through a filesystem-root mount", async () => {
    const remote = new SyntheticRemote();
    remote.exposeHostRoot();
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
    const probe = createConcreteSshDeploymentSafetyProbe({
      containerNonce: "container-nonce", expectation,
      generatedAt: () => "2026-08-13T09:01:00.000Z", hostNonce: "host-nonce", ssh,
    }, remote);
    await expect(probe.collect()).rejects.toThrow();
  });

  it("rejects a sibling whose newline cannot hide in the encoded entry framing", async () => {
    const remote = new SyntheticRemote();
    remote.campaignEntries = [expectation.campaignId, "\n"];
    const probe = createConcreteSshDeploymentSafetyProbe({
      containerNonce: "container-nonce", expectation,
      generatedAt: () => "2026-08-13T09:01:00.000Z", hostNonce: "host-nonce", ssh,
    }, remote);
    await expect(probe.collect()).rejects.toThrow();
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
