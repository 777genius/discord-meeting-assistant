import { createHash } from "node:crypto";

import { z } from "zod";

import type { HostedDeploymentSafetyExpectationV1 } from "./hosted-deployment-safety-receipt.js";
import type { SshDeploymentProbeSettings } from "./ssh-deployment-probe-validation.js";

const dockerNetworkSchema = z.object({
  Driver: z.literal("bridge"),
  Id: z.string().regex(/^[a-f\d]{64}$/u),
  Internal: z.literal(false),
  Name: z.string(),
  Options: z.record(z.string(), z.string()).nullable(),
}).loose();

interface CraigContainerNetworkSnapshot {
  readonly Id: string;
  readonly NetworkSettings: {
    readonly Networks: Readonly<Record<string, {
      readonly IPAddress: string;
      readonly NetworkID: string;
    }>>;
  };
}

interface CraigNetworkProbeCommands {
  readonly runRemote: (
    settings: SshDeploymentProbeSettings,
    args: readonly string[],
    signal?: AbortSignal,
  ) => Promise<string>;
}

export async function inspectCraigNetworkPolicy(input: Readonly<{
  commands: CraigNetworkProbeCommands;
  container: CraigContainerNetworkSnapshot;
  expectedContainerId: string;
  policy: HostedDeploymentSafetyExpectationV1["craigNetworkPolicy"];
  settings: SshDeploymentProbeSettings;
  signal?: AbortSignal;
}>): Promise<Readonly<Record<string, unknown>>> {
  if (input.container.Id !== input.expectedContainerId) {
    throw new Error("Craig network proof selected the wrong container");
  }
  const attachment = input.container.NetworkSettings.Networks[input.policy.networkName];
  if (attachment === undefined || !/^[a-f\d]{64}$/u.test(attachment.NetworkID)) {
    throw new Error("Craig is not attached to the compiled network policy");
  }
  const network = parseExactDockerInspection(dockerNetworkSchema, JSON.parse(
    await input.commands.runRemote(input.settings, [
      "docker", "network", "inspect", attachment.NetworkID,
    ], input.signal),
  ));
  const bridgeInterface = network.Options?.["com.docker.network.bridge.name"]
    ?? `br-${network.Id.slice(0, 12)}`;
  if (network.Id !== attachment.NetworkID || network.Name !== input.policy.networkName
    || bridgeInterface !== input.policy.bridgeInterface) {
    throw new Error("Craig bridge identity does not match the compiled network policy");
  }
  const firewall = await input.commands.runRemote(input.settings, [
    "iptables-save", "-c", "-t", "filter",
  ], input.signal);
  return proveCraigFirewallPolicy({
    bridgeInterface,
    containerId: input.container.Id,
    containerIpv4: attachment.IPAddress,
    firewall,
    networkId: network.Id,
    policy: input.policy,
  });
}

interface FirewallRule {
  readonly chain: string;
  readonly destination?: string;
  readonly destinationPort?: string;
  readonly input?: string;
  readonly output?: string;
  readonly protocol?: string;
  readonly source?: string;
  readonly states?: readonly string[];
  readonly target?: string;
  readonly unsupported?: readonly string[];
}

export function proveCraigFirewallPolicy(input: Readonly<{
  bridgeInterface: string;
  containerId: string;
  containerIpv4: string;
  firewall: string;
  networkId: string;
  policy: HostedDeploymentSafetyExpectationV1["craigNetworkPolicy"];
}>): Readonly<Record<string, unknown>> {
  const address = canonicalIpv4(input.containerIpv4);
  if (input.bridgeInterface !== input.policy.bridgeInterface) {
    throw new Error("Craig firewall proof selected the wrong bridge");
  }
  const rules = parseFilterRules(input.firewall);
  const policyRules = rules.filter(({ chain }) => chain === input.policy.chain);
  if (policyRules.some(({ unsupported }) => unsupported !== undefined && unsupported.length > 0)) {
    throw new Error("Craig firewall policy chain contains an unsupported match");
  }
  const required = [
    { input: input.bridgeInterface, protocol: "tcp", source: `${address}/32`,
      destinationPort: String(input.policy.tcpDestinationPort), states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { input: input.bridgeInterface, protocol: "udp", source: `${address}/32`,
      destinationPort: `${input.policy.udpDestinationPorts.start}:${input.policy.udpDestinationPorts.end}`,
      states: ["ESTABLISHED", "NEW"], target: "ACCEPT" },
    { destination: `${address}/32`, output: input.bridgeInterface,
      states: ["ESTABLISHED", "RELATED"], target: "ACCEPT" },
  ] as const;
  const accepted = policyRules.filter(({ target }) => target === "ACCEPT");
  if (accepted.length !== required.length || required.some((expected) =>
    !accepted.some((actual) => sameMatch(actual, expected)))) {
    throw new Error("Craig firewall policy lacks the exact TCP 443, UDP, or established return rule");
  }
  if (policyRules.some((rule) => rule.target !== "ACCEPT" && rule.target !== "RETURN")) {
    throw new Error("Craig firewall policy chain contains an unreviewed semantic rule");
  }
  const returns = policyRules.filter(({ target }) => target === "RETURN");
  const returnIndex = returns.length === 1 ? policyRules.indexOf(returns[0]!) : -1;
  if (returns.length !== 1 || Object.keys(withoutUndefined(returns[0]!)).length !== 2
    || returnIndex < Math.max(...accepted.map((rule) => policyRules.indexOf(rule)))) {
    throw new Error("Craig firewall policy chain must have one terminal unconditional return");
  }
  const forward = rules.filter(({ chain }) => chain === "FORWARD");
  for (const direction of [
    { input: input.bridgeInterface, source: `${address}/32`, target: input.policy.chain },
    { destination: `${address}/32`, output: input.bridgeInterface, target: input.policy.chain },
  ] as const) {
    const dispatchIndex = forward.findIndex((rule) => sameMatch(rule, direction));
    if (dispatchIndex < 0) {
      throw new Error("Craig firewall policy is not reachable from the effective FORWARD chain");
    }
    const earlierEffectiveRule = forward.slice(0, dispatchIndex).find((rule) =>
      rule.target !== undefined && rule.target !== "LOG" && overlaps(rule, direction));
    if (earlierEffectiveRule?.target === "DROP" || earlierEffectiveRule?.target === "REJECT") {
      throw new Error("Craig firewall policy is shadowed by an earlier DROP or REJECT");
    }
    if (earlierEffectiveRule !== undefined) {
      throw new Error("Craig firewall policy is bypassed by an earlier effective rule");
    }
  }
  const semantics = required.map((rule) => withoutUndefined({ chain: input.policy.chain, ...rule }))
    .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const proof = {
    ...input.policy,
    containerId: input.containerId,
    containerIpv4: address,
    networkId: input.networkId,
  };
  return Object.freeze({
    ...proof,
    semanticPolicySha256: digest({ proof, semantics }),
  });
}

function parseFilterRules(value: string): readonly FirewallRule[] {
  if (!value.split("\n").some((line) => line.trim() === "*filter")
    || !value.split("\n").some((line) => line.trim() === "COMMIT")) {
    throw new Error("iptables-save did not return one complete filter table");
  }
  return value.split("\n").map((line) => line.trim()).filter((line) =>
    /^\[\d+:\d+\]\s+-A\s/u.test(line) || line.startsWith("-A ")).map((line) => {
    const tokens = shellTokens(line.replace(/^\[\d+:\d+\]\s+/u, ""));
    const chain = argument(tokens, "-A");
    if (chain === undefined) { throw new Error("iptables-save returned a rule without a chain"); }
    const states = argument(tokens, "--ctstate")?.split(",").toSorted();
    const supported = new Set(["-A", "-d", "--destination", "--destination-port", "--dport",
      "-i", "--in-interface", "-j", "--jump", "-m", "-o", "--out-interface", "-p",
      "--protocol", "-s", "--source", "--ctstate", "--comment"]);
    const unsupported = tokens.filter((token, index) => (token.startsWith("-")
      && !supported.has(token) && tokens[index - 1] !== "--comment") || token === "!");
    const modules = tokens.flatMap((token, index) => token === "-m" && tokens[index + 1] !== undefined
      ? [tokens[index + 1]!] : []);
    unsupported.push(...modules.filter((module) =>
      !["comment", "conntrack", "tcp", "udp"].includes(module)));
    return withoutUndefined({
      chain,
      destination: normalizedAddress(argument(tokens, "-d") ?? argument(tokens, "--destination")),
      destinationPort: argument(tokens, "--dport") ?? argument(tokens, "--destination-port"),
      input: argument(tokens, "-i") ?? argument(tokens, "--in-interface"),
      output: argument(tokens, "-o") ?? argument(tokens, "--out-interface"),
      protocol: argument(tokens, "-p") ?? argument(tokens, "--protocol"),
      source: normalizedAddress(argument(tokens, "-s") ?? argument(tokens, "--source")),
      states,
      target: argument(tokens, "-j") ?? argument(tokens, "--jump"),
      unsupported: unsupported.length === 0 ? undefined : unsupported,
    }) as FirewallRule;
  });
}

function shellTokens(value: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  let escaped = false;
  for (const character of value) {
    if (escaped) { current += character; escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote !== undefined) {
      if (character === quote) { quote = undefined; } else { current += character; }
      continue;
    }
    if (character === "\"" || character === "'") { quote = character; continue; }
    if (/\s/u.test(character)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
      continue;
    }
    current += character;
  }
  if (escaped || quote !== undefined) { throw new Error("iptables-save returned malformed quoting"); }
  if (current.length > 0) { tokens.push(current); }
  return tokens;
}

function argument(tokens: readonly string[], option: string): string | undefined {
  const index = tokens.indexOf(option);
  return index < 0 ? undefined : tokens[index + 1];
}

function canonicalIpv4(value: string): string {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/u.test(octet)
    || Number(octet) > 255 || (octet !== "0" && octet.startsWith("0")))) {
    throw new Error("Craig container has no canonical IPv4 address on the compiled bridge");
  }
  return value;
}

function normalizedAddress(value: string | undefined): string | undefined {
  if (value === undefined) { return undefined; }
  return /^\d+\.\d+\.\d+\.\d+$/u.test(value) ? `${value}/32` : value;
}

function sameMatch(actual: FirewallRule, expected: Omit<FirewallRule, "chain">): boolean {
  const { chain: _chain, ...actualMatch } = actual;
  return stableObject(withoutUndefined(actualMatch)) === stableObject(withoutUndefined(expected));
}

function overlaps(rule: FirewallRule, direction: Omit<FirewallRule, "chain">): boolean {
  if ((rule.input !== undefined && direction.output !== undefined && direction.input === undefined)
    || (rule.output !== undefined && direction.input !== undefined && direction.output === undefined)) {
    return false;
  }
  for (const key of ["destination", "input", "output", "protocol", "source"] as const) {
    if (rule[key] !== undefined && direction[key] !== undefined && rule[key] !== direction[key]) {
      return false;
    }
  }
  return true;
}

function withoutUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined)) as T;
}

function stableObject(value: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right))));
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseExactDockerInspection<T>(schema: z.ZodType<T>, value: unknown): T {
  const values = z.array(schema).length(1).parse(value);
  const result = values[0];
  if (result === undefined) {
    throw new Error("Docker inspection returned no object");
  }
  return result;
}
