import { isAbsolute, normalize, relative, resolve, sep } from "node:path";

import type {
  HostedCampaignExecutableCompletion,
  HostedCampaignExecutableSpec,
  HostedCampaignInput,
} from "./hosted-campaign-coordinator.js";

type PathClaim = Readonly<{ identity: string; path: string }>;

export function validateHostedCampaignOwnedPaths(
  plan: HostedCampaignInput,
  campaignRoot: string,
  externalPaths: readonly string[] = [],
): void {
  const campaignId = plan.runs[0]?.campaignId;
  if (campaignId === undefined || plan.runs.some((run) => run.campaignId !== campaignId)) {
    throw new Error("Hosted campaign owned paths require one campaign identity");
  }
  const ownedRoot = resolve(campaignRoot, campaignId);
  const external = new Set(externalPaths.map((path) => canonicalExternalPath(path)));
  const claims = plan.children.flatMap(structuralClaims);
  const identitiesByPath = new Map<string, string>();
  for (const claim of claims) {
    registerClaim(claim, ownedRoot, identitiesByPath);
  }
  for (const path of external) {
    if (identitiesByPath.has(path)) {
      throw new Error(`Hosted campaign external path aliases a generated owned resource: ${path}`);
    }
  }
  registerOrchestratorOwnedArtifacts(plan.children, ownedRoot, identitiesByPath);
  registerEnvironmentOutputs(plan.children, ownedRoot, identitiesByPath);
  validateOwnedEnvironmentReferences(plan.children, ownedRoot, external, identitiesByPath);
  validateOwnedArgumentReferences(plan.children, ownedRoot, external, identitiesByPath);
}

function registerOrchestratorOwnedArtifacts(
  children: readonly HostedCampaignExecutableSpec[],
  ownedRoot: string,
  identitiesByPath: Map<string, string>,
): void {
  const launchClockPaths = new Set(children.flatMap(({ environment }) => {
    const path = environment.DISCORD_E2E_SLA_CLOCK_PREFLIGHT_INPUT;
    return path === undefined ? [] : [path];
  }));
  if (launchClockPaths.size !== 1) {
    throw new Error("Hosted campaign requires one orchestrator-owned launch clock preflight artifact");
  }
  registerClaim({
    identity: "orchestrator:launch-clock-preflight",
    path: [...launchClockPaths][0]!,
  }, ownedRoot, identitiesByPath);
}

function structuralClaims(child: HostedCampaignExecutableSpec): PathClaim[] {
  return [
    ...child.produces.map(({ action, outputPath }) => ({
      identity: `barrier:${JSON.stringify(action)}`, path: outputPath,
    })),
    ...completionClaims(child.childId, child.completion),
    ...gateClaims(child),
  ];
}

function completionClaims(
  childId: string,
  completion: HostedCampaignExecutableCompletion | undefined,
): PathClaim[] {
  if (completion === undefined || completion.kind === "campaign-verifier"
    || completion.kind === "evidence-verifier" || completion.kind === "replay-attestation-publisher") {
    return [];
  }
  if (completion.kind === "conversation-observer") {
    return completion.outputPaths.map((path, index) => ({ identity: `capture:${index + 1}`, path }));
  }
  if (completion.kind === "provenance-probe") {
    return [{ identity: "provenance-snapshot", path: completion.snapshotPath }];
  }
  if (completion.kind === "collector") {
    return [{ identity: `evidence:${completion.runId}`, path: completion.evidencePath }];
  }
  if (completion.kind === "service-level-sources") {
    return [
      { identity: "sla-source:clock", path: completion.clockAttestationsPath },
      { identity: "sla-source:database", path: completion.databasePath },
      { identity: "sla-source:logs", path: completion.meetingPlatformLogsPath },
      { identity: "sla-source:report", path: completion.reportPath },
      { identity: "sla-source:s3", path: completion.s3Path },
    ];
  }
  if (completion.kind === "service-levels") {
    return [
      { identity: "service-levels", path: completion.outputPath },
      { identity: "service-levels-report", path: completion.reportPath },
    ];
  }
  return [{ identity: `completion:${childId}`, path: completion.outputPath }];
}

function gateClaims(child: HostedCampaignExecutableSpec): PathClaim[] {
  const claims: PathClaim[] = [];
  const add = (identity: string, gate: { readonly armedPath?: string; readonly path: string }) => {
    claims.push({ identity: `${identity}:gate`, path: gate.path });
    if (gate.armedPath !== undefined) {
      claims.push({ identity: `${identity}:armed`, path: gate.armedPath });
    }
  };
  if (child.releaseGate !== undefined) {
    add(`${child.childId}:release`, child.releaseGate);
  }
  if (child.actorGates !== undefined) {
    add(`${child.childId}:speaker-b`, child.actorGates.speakerB);
    add(`${child.childId}:playback`, child.actorGates.playback);
    add(`${child.childId}:end`, child.actorGates.end);
  }
  if (child.supplementalGates !== undefined) {
    add(`${child.childId}:connection`, child.supplementalGates.connection);
    add(`${child.childId}:playback`, child.supplementalGates.playback);
  }
  return claims;
}

function registerEnvironmentOutputs(
  children: readonly HostedCampaignExecutableSpec[],
  ownedRoot: string,
  identitiesByPath: Map<string, string>,
): void {
  for (const child of children) {
    for (const [name, path] of Object.entries(child.environment)) {
      if (!name.endsWith("_OUTPUT") || !isOwnedAbsolutePath(path, ownedRoot)
        || identitiesByPath.has(normalize(path))) {
        continue;
      }
      registerClaim({ identity: `environment-output:${child.childId}:${name}`, path }, ownedRoot, identitiesByPath);
    }
  }
}

function validateOwnedEnvironmentReferences(
  children: readonly HostedCampaignExecutableSpec[],
  ownedRoot: string,
  externalPaths: ReadonlySet<string>,
  identitiesByPath: Map<string, string>,
): void {
  const suffixes = ["_INPUT", "_OUTPUT", "_PATH", "_ROOT"];
  for (const child of children) {
    for (const [name, path] of Object.entries(child.environment)) {
      if (!suffixes.some((suffix) => name.endsWith(suffix)) || !isAbsolute(path)) {
        continue;
      }
      if (externalPaths.has(normalize(path))) {
        continue;
      }
      if (!isOwnedAbsolutePath(path, ownedRoot)) {
        throw new Error(`Hosted campaign environment path is not classified as owned or external: ${name}`);
      }
      assertCanonicalOwnedPath(path, ownedRoot);
      if (name.endsWith("_ROOT")) {
        registerClaim({ identity: `environment-root:${child.childId}:${name}`, path }, ownedRoot, identitiesByPath);
      } else if (!identitiesByPath.has(normalize(path))) {
        throw new Error(`Hosted campaign environment path has no owned resource declaration: ${name}`);
      }
    }
  }
}

function validateOwnedArgumentReferences(
  children: readonly HostedCampaignExecutableSpec[],
  ownedRoot: string,
  externalPaths: ReadonlySet<string>,
  identitiesByPath: ReadonlyMap<string, string>,
): void {
  for (const child of children) {
    const childArguments = child.arguments;
    if (childArguments.kind === "environment") {
      continue;
    }
    const paths = childArguments.kind === "campaign-verifier"
      ? childArguments.evidencePaths
      : [childArguments.evidencePath];
    for (const path of paths) {
      const canonical = normalize(path);
      if (externalPaths.has(canonical)) {
        continue;
      }
      if (!isOwnedAbsolutePath(path, ownedRoot)) {
        throw new Error(`Hosted campaign argument path is not classified as owned or external: ${path}`);
      }
      if (!identitiesByPath.has(canonical)) {
        throw new Error(`Hosted campaign argument references undeclared owned path: ${path}`);
      }
    }
  }
}

function registerClaim(claim: PathClaim, ownedRoot: string, identitiesByPath: Map<string, string>): void {
  assertCanonicalOwnedPath(claim.path, ownedRoot);
  const canonical = normalize(claim.path);
  const existing = identitiesByPath.get(canonical);
  if (existing !== undefined && existing !== claim.identity) {
    throw new Error(`Hosted campaign owned path aliases distinct resources: ${existing} and ${claim.identity}`);
  }
  identitiesByPath.set(canonical, claim.identity);
}

function assertCanonicalOwnedPath(path: string, ownedRoot: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || !isOwnedAbsolutePath(path, ownedRoot)) {
    throw new Error(`Hosted campaign generated path escapes or is not canonical under its owned root: ${path}`);
  }
}

function isOwnedAbsolutePath(path: string, ownedRoot: string): boolean {
  if (!isAbsolute(path)) {
    return false;
  }
  const relation = relative(ownedRoot, normalize(path));
  return relation !== "" && relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation);
}

function canonicalExternalPath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path === normalize("/")) {
    throw new Error(`Hosted campaign external path is not canonical and absolute: ${path}`);
  }
  return path;
}
