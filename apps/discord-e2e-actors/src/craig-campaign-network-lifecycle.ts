import { z } from "zod";

import { parseCraigFilterRulesForOwnership, proveCraigFirewallPolicy,
  type CraigParsedFirewallRule } from "./craig-network-policy-proof.js";
import { digestCraigCampaignStackCanonical as digestCanonical } from "./craig-campaign-stack-digest.js";
import type {
  CraigCampaignStackCommandRequest,
  CraigCampaignStackCommandResult,
  CraigCampaignStackInput,
} from "./craig-disposable-campaign-stack.js";

type ExecuteRequest = (request: CraigCampaignStackCommandRequest) => Promise<CraigCampaignStackCommandResult>;
type ExecuteDocker = (args: readonly string[]) => Promise<CraigCampaignStackCommandResult>;

const networkInspection = z.array(z.object({
  Driver: z.literal("bridge"), Id: z.string().regex(/^[a-f\d]{64}$/u),
  Labels: z.record(z.string(), z.string()), Name: z.string(),
  Options: z.record(z.string(), z.string()).nullable(),
}).loose()).length(1);
const containerInspection = z.array(z.object({
  Id: z.string().regex(/^[a-f\d]{64}$/u),
  NetworkSettings: z.object({ Networks: z.record(z.string(), z.object({
    IPAddress: z.string(), NetworkID: z.string().regex(/^[a-f\d]{64}$/u),
  }).loose()) }).loose(),
}).loose()).length(1);

export interface CraigInstalledNetworkPolicyV1 {
  readonly bridgeInterface: string; readonly chain: string; readonly containerIpv4: string;
  readonly containerId: string;
  readonly databaseContainerId: string;
  readonly databaseIpv4: string; readonly inputChain: string; readonly networkId: string; readonly networkName: string;
  readonly projectName: string; readonly semanticPolicySha256: string; readonly tcpDestinationPort: 443;
  readonly udpDestinationPorts: Readonly<{ end: number; start: number }>;
}

export async function installCraigCampaignFirewall(input: CraigCampaignStackInput, projectName: string,
  compose: readonly string[], executeRequest: ExecuteRequest,
  executeDocker: ExecuteDocker): Promise<CraigInstalledNetworkPolicyV1> {
  const networkId = await inspectNetwork(input, projectName, executeDocker);
  const databaseContainerId = await inspectContainerAttachment({ compose, executeDocker,
    expectedIpv4: input.networkPolicy.databaseIpv4,
    networkId, networkName: input.networkPolicy.name, service: input.database.service });
  const policy = hostedPolicy(input, projectName);
  const address = `${input.networkPolicy.botIpv4}/32`;
  const database = `${input.networkPolicy.databaseIpv4}/32`;
  const bridge = input.networkPolicy.bridgeInterface;
  const chain = input.networkPolicy.chain;
  const inputChain = input.networkPolicy.inputChain;
  const commands: readonly (readonly string[])[] = [
    ["-N", chain],
    ["-N", inputChain],
    ["-A", chain, "-i", bridge, "-s", address, "-d", database, "-p", "tcp", "-m", "conntrack",
      "--ctstate", "NEW,ESTABLISHED", "--dport", "5432", "-j", "ACCEPT"],
    ["-A", chain, "-i", bridge, "-s", address, "-p", "tcp", "-m", "conntrack", "--ctstate",
      "NEW,ESTABLISHED", "--dport", "443", "-j", "ACCEPT"],
    ["-A", chain, "-i", bridge, "-s", address, "-p", "udp", "-m", "conntrack", "--ctstate",
      "NEW,ESTABLISHED", "--dport", `${policy.udpDestinationPorts.start}:${policy.udpDestinationPorts.end}`,
      "-j", "ACCEPT"],
    ["-A", chain, "-o", bridge, "-d", address, "-m", "conntrack", "--ctstate",
      "ESTABLISHED,RELATED", "-j", "ACCEPT"],
    ["-A", chain, "-j", "DROP"],
    ["-A", inputChain, "-j", "DROP"],
    ["-I", "INPUT", "1", "-i", bridge, "-s", address, "-j", inputChain],
    ["-I", "FORWARD", "1", "-o", bridge, "-d", address, "-j", chain],
    ["-I", "FORWARD", "1", "-i", bridge, "-s", address, "-j", chain],
  ];
  for (const args of commands) { requireSuccess(await executeFirewall(executeRequest, "/usr/sbin/iptables", args),
    "Craig campaign firewall installation"); }
  return { ...await proveInstalledPolicy(input, projectName, networkId, executeRequest), databaseContainerId };
}

export async function proveInstalledCraigCampaignFirewall(value: Readonly<{
  compose: readonly string[]; executeDocker: ExecuteDocker; executeRequest: ExecuteRequest;
  databaseContainerId: string; expectedNetworkId: string; input: CraigCampaignStackInput; projectName: string;
}>): Promise<CraigInstalledNetworkPolicyV1> {
  const containerId = await inspectContainerAttachment({ compose: value.compose,
    executeDocker: value.executeDocker, expectedIpv4: value.input.networkPolicy.botIpv4,
    networkId: value.expectedNetworkId, networkName: value.input.networkPolicy.name,
    service: value.input.service });
  return { ...await proveInstalledPolicy(value.input, value.projectName, value.expectedNetworkId,
    value.executeRequest, containerId), databaseContainerId: value.databaseContainerId };
}

export async function removeCraigCampaignFirewall(input: CraigCampaignStackInput, executeRequest: ExecuteRequest,
  proof: Readonly<{ botStopped: boolean }>,
): Promise<void> {
  if (!proof.botStopped) { throw new Error("Craig firewall removal requires a proved-stopped bot"); }
  const address = `${input.networkPolicy.botIpv4}/32`;
  const bridge = input.networkPolicy.bridgeInterface;
  const chain = input.networkPolicy.chain;
  const inputChain = input.networkPolicy.inputChain;
  const savedBefore = await executeFirewall(executeRequest, "/usr/sbin/iptables-save", ["-c", "-t", "filter"]);
  requireSuccess(savedBefore, "Craig campaign firewall ownership inspection");
  assertOnlyOwnedPartialPolicy(savedBefore.stdout, input);
  for (const args of [
    ["-D", "INPUT", "-i", bridge, "-s", address, "-j", inputChain],
    ["-D", "FORWARD", "-i", bridge, "-s", address, "-j", chain],
    ["-D", "FORWARD", "-o", bridge, "-d", address, "-j", chain],
  ] as const) {
    const check = await executeFirewall(executeRequest, "/usr/sbin/iptables", ["-C", ...args.slice(1)]);
    if (check.exitCode === 0) {
      requireSuccess(await executeFirewall(executeRequest, "/usr/sbin/iptables", args),
        "Craig campaign firewall dispatch removal");
    } else if (check.exitCode !== 1) {
      throw new Error(`Craig campaign firewall dispatch inspection failed closed (exit ${check.exitCode})`);
    }
  }
  for (const ownedChain of [chain, inputChain]) {
    const check = await executeFirewall(executeRequest, "/usr/sbin/iptables", ["-S", ownedChain]);
    if (check.exitCode === 0) {
      requireSuccess(await executeFirewall(executeRequest, "/usr/sbin/iptables", ["-F", ownedChain]),
        "Craig campaign firewall chain flush");
      requireSuccess(await executeFirewall(executeRequest, "/usr/sbin/iptables", ["-X", ownedChain]),
        "Craig campaign firewall chain deletion");
    } else if (check.exitCode !== 1) {
      throw new Error(`Craig campaign firewall chain inspection failed closed (exit ${check.exitCode})`);
    }
  }
  const saved = await executeFirewall(executeRequest, "/usr/sbin/iptables-save", ["-c", "-t", "filter"]);
  requireSuccess(saved, "Craig campaign firewall removal proof");
  if (saved.stdout.split("\n").some((line) => line.includes(chain) || line.includes(inputChain))) {
    throw new Error("Craig campaign firewall chain or dispatch remains after removal");
  }
}

export async function proveCraigCampaignFirewallAbsent(
  input: CraigCampaignStackInput,
  executeRequest: ExecuteRequest,
): Promise<void> {
  const saved = await executeFirewall(executeRequest, "/usr/sbin/iptables-save", ["-c", "-t", "filter"]);
  requireSuccess(saved, "Craig campaign firewall idempotent absence proof");
  parseCraigFilterRulesForOwnership(saved.stdout);
  const { chain, inputChain } = input.networkPolicy;
  if (saved.stdout.split("\n").some((line) => line.includes(chain) || line.includes(inputChain))) {
    throw new Error("Craig campaign firewall is not fully absent after retained recovery");
  }
}

async function inspectNetwork(input: CraigCampaignStackInput, projectName: string,
  executeDocker: ExecuteDocker): Promise<string> {
  const result = await executeDocker(["network", "inspect", input.networkPolicy.name]);
  requireSuccess(result, "Craig campaign network identity inspection");
  const parsed = networkInspection.parse(parseJson(result.stdout, "Craig campaign network inspection"))[0]!;
  if (parsed.Name !== input.networkPolicy.name
    || parsed.Options?.["com.docker.network.bridge.name"] !== input.networkPolicy.bridgeInterface
    || parsed.Labels["com.docker.compose.project"] !== projectName) {
    throw new Error("Craig campaign network does not match its exact project/bridge identity");
  }
  return parsed.Id;
}

async function inspectContainerAttachment(input: Readonly<{
  compose: readonly string[]; executeDocker: ExecuteDocker; expectedIpv4: string;
  networkId: string; networkName: string; service: string;
}>): Promise<string> {
  const container = await input.executeDocker([...input.compose, "ps", "--quiet", input.service]);
  requireSuccess(container, "Craig campaign network container identity");
  const id = container.stdout.trim();
  if (!/^[a-f\d]{64}$/u.test(id)) { throw new Error("Craig campaign network container is not running"); }
  const inspection = await input.executeDocker(["inspect", id]);
  requireSuccess(inspection, "Craig campaign network attachment inspection");
  const parsed = containerInspection.parse(parseJson(inspection.stdout,
    "Craig campaign network attachment inspection"))[0]!;
  const attachment = parsed.NetworkSettings.Networks[input.networkName];
  if (parsed.Id !== id || attachment?.IPAddress !== input.expectedIpv4 || attachment.NetworkID !== input.networkId) {
    throw new Error("Craig campaign container has the wrong network/address identity");
  }
  return id;
}

async function proveInstalledPolicy(input: CraigCampaignStackInput, projectName: string, networkId: string,
  executeRequest: ExecuteRequest, containerId = "0".repeat(64)): Promise<CraigInstalledNetworkPolicyV1> {
  const saved = await executeFirewall(executeRequest, "/usr/sbin/iptables-save", ["-c", "-t", "filter"]);
  requireSuccess(saved, "Craig campaign firewall proof");
  return proveCraigFirewallPolicy({
    bridgeInterface: input.networkPolicy.bridgeInterface,
    containerId,
    containerIpv4: input.networkPolicy.botIpv4,
    firewall: saved.stdout,
    networkId,
    policy: hostedPolicy(input, projectName),
  }) as unknown as CraigInstalledNetworkPolicyV1;
}

function hostedPolicy(input: CraigCampaignStackInput, projectName: string) {
  return { bridgeInterface: input.networkPolicy.bridgeInterface, chain: input.networkPolicy.chain,
    databaseIpv4: input.networkPolicy.databaseIpv4, inputChain: input.networkPolicy.inputChain,
    networkName: input.networkPolicy.name, projectName,
    tcpDestinationPort: input.networkPolicy.tcpDestinationPort,
    udpDestinationPorts: input.networkPolicy.udpDestinationPorts } as const;
}

function assertOnlyOwnedPartialPolicy(saved: string, input: CraigCampaignStackInput): void {
  const policy = input.networkPolicy;
  const address = `${policy.botIpv4}/32`;
  const database = `${policy.databaseIpv4}/32`;
  const allowed: readonly CraigParsedFirewallRule[] = [
    { chain: "INPUT", input: policy.bridgeInterface, source: address, target: policy.inputChain },
    { chain: "FORWARD", input: policy.bridgeInterface, source: address, target: policy.chain },
    { chain: "FORWARD", destination: address, output: policy.bridgeInterface, target: policy.chain },
    { chain: policy.chain, destination: database, destinationPort: "5432", input: policy.bridgeInterface,
      protocol: "tcp", source: address, states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { chain: policy.chain, destinationPort: "443", input: policy.bridgeInterface, protocol: "tcp",
      source: address, states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { chain: policy.chain, destinationPort: `${policy.udpDestinationPorts.start}:${policy.udpDestinationPorts.end}`,
      input: policy.bridgeInterface, protocol: "udp", source: address,
      states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { chain: policy.chain, destination: address, output: policy.bridgeInterface,
      states: ["ESTABLISHED", "RELATED"], target: "ACCEPT" },
    { chain: policy.chain, target: "DROP" }, { chain: policy.inputChain, target: "DROP" },
  ];
  const rules = parseCraigFilterRulesForOwnership(saved).filter((rule) =>
    rule.chain === policy.chain || rule.chain === policy.inputChain
      || rule.target === policy.chain || rule.target === policy.inputChain);
  const allowedDigests = new Set(allowed.map((rule) => digestCanonical(rule)));
  const observedDigests = rules.map((rule) => digestCanonical(rule));
  const declarations = saved.split("\n").map((line) => line.trim()).filter((line) =>
    line.startsWith(`:${policy.chain} `) || line.startsWith(`:${policy.inputChain} `));
  const relevantLines = saved.split("\n").map((line) => line.trim()).filter((line) =>
    line.includes(policy.chain) || line.includes(policy.inputChain));
  const expectedDeclarations = new Set([`:${policy.chain} - [0:0]`, `:${policy.inputChain} - [0:0]`]);
  const fullyAbsent = rules.length === 0 && declarations.length === 0 && relevantLines.length === 0;
  const exactlyInstalled = rules.length === allowed.length && declarations.length === expectedDeclarations.size
    && relevantLines.length === allowed.length + expectedDeclarations.size
    && observedDigests.every((digest) => allowedDigests.has(digest))
    && new Set(observedDigests).size === observedDigests.length
    && declarations.every((line) => expectedDeclarations.has(line));
  if (!fullyAbsent && !exactlyInstalled) {
    throw new Error("Craig firewall ownership is not the complete exact installed policy or complete absence");
  }
}

function executeFirewall(executeRequest: ExecuteRequest, executable: string, args: readonly string[]) {
  return executeRequest({ args, environment: { HOME: "/var/empty", PATH: "/usr/sbin:/usr/bin:/bin" }, executable,
    timeoutMilliseconds: 30_000, workingDirectory: "/" });
}

function parseJson(text: string, label: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${label} is not JSON`); }
}

function requireSuccess(result: CraigCampaignStackCommandResult, label: string): void {
  if (result.exitCode !== 0) { throw new Error(`${label} failed closed (exit ${result.exitCode})`); }
}
