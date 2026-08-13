import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type HostedCampaignChildHandle,
  type HostedCampaignLeaseHandle,
} from "../src/hosted-campaign-coordinator.js";
import { buildResolvedHostedCampaignPlanV1 } from "../src/hosted-campaign-plan-builder.js";
import { deriveHostedClockPreflightReceiptV2 } from "../src/hosted-clock-proof-v2.js";
import { parseHostedCampaignArguments, parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";
import {
  assertHostedCampaignReceiptAbsent,
  loadHostedCampaignTrustedRuntimeEnvironment,
  readPrivateHostedCampaignPlan,
  resolveHostedCampaignBarrierRoot,
  runHostedCampaignCli,
  writeCreateOnlyHostedCampaignReceipt,
} from "../src/run-hosted-campaign.js";

const definition = () => ({
    answerFirstPacketMilliseconds: 4_000,
    campaignId: "campaign-1",
    campaignRoot: "/private/evidence/campaigns",
    clockPreflightPath: "/private/evidence/clock-preflight.json",
    fixtureManifestPath: "/private/evidence/fixture-manifest.json",
    recordingPlaybackOrigin: "https://recordings.test.example",
    remote: {
      composeFile: "/srv/discord-meeting/compose.yaml",
      environmentFile: "/srv/discord-meeting/source.env",
      sourceRoot: "/srv/discord-meeting/source",
    },
    revisions: {
      craig: "a".repeat(40), meetingPlatform: "b".repeat(40),
      pipecat: "c".repeat(40), subscriptionRuntime: "d".repeat(40),
    },
    runIds: ["run-1", "run-2", "run-3"],
    schemaVersion: 1,
    secretDirectory: "/run/secrets/discord-e2e",
    speakerFixtures: { a: "/private/evidence/speaker-a.ogg", b: "/private/evidence/speaker-b.ogg" },
    serviceLevelThresholdsPath: "/private/evidence/service-level-thresholds.json",
    supplementalManifestPath: "/private/evidence/supplemental-manifest.json",
  } as const);
const bindings = () => ({
    runs: [
      { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json" },
      { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-2.json" },
      { remoteAttestationPath: "/tmp/discord-e2e-attestations/run-3.json" },
    ] as const,
    schemaVersion: 1,
  } as const);
const plan = () => buildResolvedHostedCampaignPlanV1(definition(), bindings());

const admittedReceipt = () => ({
  clockPreflightProof: clockProof(),
  remoteReadiness: { clockPreflight: { proofId: clockProof().proofId }, deploymentSafety: { revalidationBaseline: {
    campaignId: "campaign-1", deploymentFingerprint: "1".repeat(64),
    expectationSha256: "2".repeat(64), kind: "hosted-deployment-revalidation-baseline",
    schemaVersion: 1,
  } } },
}) as never;

const clockProof = () => deriveHostedClockPreflightReceiptV2({
  observer: {
    after: { bootId: "observer-boot", epochMs: 1_010, monotonicNs: "1010000000" },
    before: { bootId: "observer-boot", epochMs: 1_000, monotonicNs: "1000000000" },
  }, observerClockId: "observer-clock",
  source: {
    after: { bootId: "source-boot", epochMs: 1_008, monotonicNs: "1008000000" },
    before: { bootId: "source-boot", epochMs: 1_005, monotonicNs: "1005000000" },
    sample: { bootId: "source-boot", epochMs: 1_007, monotonicNs: "1007000000" },
  }, sourceClockId: "source-clock",
  target: { environment: "private-test-guild", host: "codex-workers-eu-01", project: "discord-meeting-assistant" },
});
const freshClockProof = () => deriveHostedClockPreflightReceiptV2({
  observer: {
    after: { bootId: "observer-boot", epochMs: 2_010, monotonicNs: "2010000000" },
    before: { bootId: "observer-boot", epochMs: 2_000, monotonicNs: "2000000000" },
  }, observerClockId: "observer-clock",
  source: {
    after: { bootId: "source-boot", epochMs: 2_008, monotonicNs: "2008000000" },
    before: { bootId: "source-boot", epochMs: 2_005, monotonicNs: "2005000000" },
    sample: { bootId: "source-boot", epochMs: 2_007, monotonicNs: "2007000000" },
  }, sourceClockId: "source-clock",
  target: { environment: "private-test-guild", host: "codex-workers-eu-01", project: "discord-meeting-assistant" },
});
const freshAuthorization = () => ({
  assertReadyForFirstChild: () => {}, clockPreflightProof: freshClockProof(),
});

describe("run-hosted-campaign CLI", () => {
  it("selects only the closed trusted runtime environment", () => {
    expect(loadHostedCampaignTrustedRuntimeEnvironment({
      HOME: "/private/tmp/test-home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      SECRET_SHOULD_NOT_REACH_CHILD: "secret-value",
      SSH_AUTH_SOCK: "/private/tmp/test-agent.sock",
    })).toEqual({
      HOME: "/private/tmp/test-home",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      SSH_AUTH_SOCK: "/private/tmp/test-agent.sock",
    });
    expect(loadHostedCampaignTrustedRuntimeEnvironment({
      HOME: "/private/tmp/test-home",
      PATH: "/usr/bin:/bin",
    })).toEqual({ HOME: "/private/tmp/test-home", PATH: "/usr/bin:/bin" });
  });

  it("requires exactly three arguments and absolute plan/receipt paths", () => {
    expect(parseHostedCampaignArguments(["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"])).toEqual({
      admissionPath: "/admission.json", bindingsPath: "/bindings.json", definitionPath: "/definition.json",
      planPath: "/plan.json", receiptPath: "/receipt.json", timeoutMilliseconds: 1_000,
    });
    expect(() => parseHostedCampaignArguments(["/plan.json", "/receipt.json"])).toThrow(/Usage/u);
    expect(() => parseHostedCampaignArguments(["plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"]))
      .toThrow(/absolute/u);
  });

  it("strictly validates the closed executable plan", () => {
    expect(parseHostedCampaignPlan(plan()).children[0]?.entrypoint).toBe("actor");
    expect(() => parseHostedCampaignPlan({ ...plan(), children: [{ ...plan().children[0], command: "sh" }] }))
      .toThrow();
    expect(() => parseHostedCampaignPlan({ ...plan(), thresholds: undefined })).toThrow();
    expect(() => parseHostedCampaignPlan({
      ...plan(), children: [{ ...plan().children[0], startBefore: "run-verified" }],
    })).toThrow();
    expect(() => parseHostedCampaignPlan({
      ...plan(), thresholds: { answerFirstPacketMilliseconds: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow();
  });

  it("accepts the closed recording-ready entrypoint", () => {
    const input = plan();
    expect(parseHostedCampaignPlan(input).children.some(({ entrypoint }) => entrypoint === "recording-ready")).toBe(true);
  });

  it("reads recording identity from the create-only readiness artifact", () => {
    const input = plan();
    const playback = input.children.find(({ childId }) => childId === "playback-link-observer")!;
    expect(playback.environmentBindings).toBeUndefined();
    expect(playback.environment.DISCORD_E2E_PLAYBACK_LINK_READY_RECEIPT_INPUT)
      .toBe("/private/evidence/campaigns/campaign-1/run-3/recording-ready.json");
    expect(() => parseHostedCampaignPlan({ ...input, children: [{ ...playback,
      environment: { ...playback.environment, PATH: "/tmp" } }] })).toThrow();
  });

  it("accepts a provenance producer bound to one campaign snapshot", () => {
    const input = plan();
    expect(parseHostedCampaignPlan(input).children
      .find(({ childId }) => childId === "provenance-before")?.entrypoint).toBe("provenance-probe");
  });

  it("reads only an owned regular 0600 plan and writes a create-only 0600 receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-cli-"));
    const planPath = join(directory, "plan.json");
    const receiptPath = join(directory, "receipt.json");
    await writeFile(planPath, JSON.stringify(plan()), { mode: 0o600 });
    expect(await readPrivateHostedCampaignPlan(planPath)).toEqual(plan());
    await chmod(planPath, 0o644);
    await expect(readPrivateHostedCampaignPlan(planPath)).rejects.toThrow(/0600/u);

    const receipt = { actionEvidence: [], campaignId: "campaign-1", runIds: ["run-1", "run-2", "run-3"], schemaVersion: 1, teardownComplete: true } as const;
    await writeCreateOnlyHostedCampaignReceipt(receiptPath, receipt);
    expect((await lstat(receiptPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
    await expect(writeCreateOnlyHostedCampaignReceipt(receiptPath, receipt)).rejects.toThrow();
    await expect(assertHostedCampaignReceiptAbsent(receiptPath)).rejects.toThrow(/new campaign ID/u);
  });

  it("resolves one exact generated barrier root and rejects split roots", () => {
    const input = parseHostedCampaignPlan(plan());
    expect(resolveHostedCampaignBarrierRoot(input)).toBe("/private/evidence/campaigns/campaign-1/barriers");
    const first = input.children[0]!;
    const split = parseHostedCampaignPlan({
      ...input,
      children: [{ ...first, produces: first.produces.map((item) => ({
        ...item, outputPath: `/private/evidence/other/barriers/${item.outputPath.split("/").at(-1)}`,
      })) }, ...input.children.slice(1)],
    });
    expect(() => resolveHostedCampaignBarrierRoot(split)).toThrow(/one exact barriers root/u);
  });

  it("does not follow a symlink when opening the private campaign plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-cli-"));
    const targetPath = join(directory, "target.json");
    const planPath = join(directory, "plan.json");
    await writeFile(targetPath, JSON.stringify(plan()), { mode: 0o600 });
    await symlink(targetPath, planPath);

    await expect(readPrivateHostedCampaignPlan(planPath)).rejects.toMatchObject({ code: "ELOOP" });
  });

  it("rejects an empty or oversized private campaign plan before parsing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hosted-campaign-cli-"));
    const emptyPath = join(directory, "empty.json");
    const oversizedPath = join(directory, "oversized.json");
    await writeFile(emptyPath, "", { mode: 0o600 });
    await writeFile(oversizedPath, "x".repeat(1024 * 1024 + 1), { mode: 0o600 });

    await expect(readPrivateHostedCampaignPlan(emptyPath)).rejects.toThrow(/at most 1 MiB/u);
    await expect(readPrivateHostedCampaignPlan(oversizedPath)).rejects.toThrow(/at most 1 MiB/u);
  });

  it("writes no receipt when a barrier fails", async () => {
    let written = false;
    const dependencies = {
      assertAdmissionAudit: () => { throw new Error("invalid admission"); },
      assertReceiptAbsent: async () => {},
      now: () => Date.now(),
      readPlan: async () => plan(),
      writeReceipt: async () => { written = true; },
      writeClockPreflightProof: async () => {},
      createPorts: async () => ({
        acquireCampaignLease: async (campaignId: string) => ({ campaignId }) as HostedCampaignLeaseHandle,
        awaitChildCompletion: async () => {},
        publishReleaseGate: async () => {},
        publishSupplementalGate: async () => {},
        startChild: async ({ childId }: { childId: string }) => ({ childId }) as HostedCampaignChildHandle,
        awaitBarrier: async () => { throw new Error("barrier failed"); },
        releaseCampaignLease: async () => {},
        stopChild: async () => {},
      }),
      readAdmission: async () => ({}),
      readBindings: async () => bindings(), readDefinition: async () => definition(),
      authorizeFreshAdmission: async () => (freshAuthorization()),
    };
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"], dependencies, new AbortController().signal,
    )).rejects.toThrow("invalid admission");
    expect(written).toBe(false);
  });

  it("validates admission before creating ports or acquiring a lease", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => { effects.push("admission"); throw new Error("mismatch"); },
        assertReceiptAbsent: async () => {},
        createPorts: async () => { effects.push("factory"); throw new Error("unreachable"); },
        now: Date.now,

        readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => plan(),
        authorizeFreshAdmission: async () => { effects.push("authorize"); return freshAuthorization(); },
        writeReceipt: async () => { effects.push("write"); },
      writeClockPreflightProof: async () => {},
      }, new AbortController().signal,
    )).rejects.toThrow("mismatch");
    expect(effects).toEqual(["admission"]);
  });

  it("acquires the lease before fresh authorization and releases it without spawning on failure", async () => {
    const effects: string[] = [];
    const serializedAdmission = JSON.stringify(admittedReceipt());
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => { effects.push("admission"); return JSON.parse(serializedAdmission) as never; },
        assertReceiptAbsent: async () => {},
        createPorts: async () => {
          effects.push("factory");
          return {
            acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
            awaitBarrier: async () => { throw new Error("unreachable"); }, awaitChildCompletion: async () => {}, publishReleaseGate: async () => {},
            publishSupplementalGate: async () => {}, releaseCampaignLease: async () => { effects.push("release"); },
            startChild: async () => { effects.push("spawn"); return { childId: "x" } as HostedCampaignChildHandle; }, stopChild: async () => {},
          };
        },
        now: Date.now,

        readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => plan(), writeReceipt: async () => {},
      writeClockPreflightProof: async () => {},
        authorizeFreshAdmission: async () => { effects.push("authorize"); throw new Error("fresh authorization failed"); },
      }, new AbortController().signal,
    )).rejects.toThrow("fresh authorization failed");
    expect(effects).toEqual(["admission", "factory", "acquire", "authorize", "release"]);
  });

  it("propagates cancellation into post-lease authorization and releases without spawning", async () => {
    const effects: string[] = [];
    const controller = new AbortController();
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "10000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => admittedReceipt(), assertReceiptAbsent: async () => {},
        authorizeFreshAdmission: async ({ signal }) => {
          effects.push("authorize"); controller.abort(new Error("cancel fresh authorization"));
          expect(signal.aborted).toBe(true); throw signal.reason;
        },
        createPorts: async () => ({
          acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
          awaitBarrier: async () => { throw new Error("unreachable"); }, awaitChildCompletion: async () => {},
          publishReleaseGate: async () => {}, publishSupplementalGate: async () => {},
          releaseCampaignLease: async () => { effects.push("release"); },
          startChild: async () => { effects.push("spawn"); return { childId: "x" } as HostedCampaignChildHandle; }, stopChild: async () => {},
        }),
        now: () => Date.now(), readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => plan(), writeReceipt: async () => {},
        writeClockPreflightProof: async () => { effects.push("write-proof"); },
      }, controller.signal,
    )).rejects.toThrow("cancel fresh authorization");
    expect(effects).toEqual(["acquire", "authorize", "release"]);
  });

  it("checks fresh authorization synchronously immediately before the first spawn", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "10000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => { effects.push("admission"); return admittedReceipt(); },
        assertReceiptAbsent: async () => {},
        createPorts: async () => ({
          acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
          awaitBarrier: async () => { throw new Error("unreachable"); }, awaitChildCompletion: async () => {}, publishReleaseGate: async () => {},
          publishSupplementalGate: async () => {}, releaseCampaignLease: async () => { effects.push("release"); }, stopChild: async () => {},
          startChild: async () => { effects.push("spawn"); return { childId: "x" } as HostedCampaignChildHandle; },
        }),
        now: () => Date.now(),

        readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => plan(),
        authorizeFreshAdmission: async () => { effects.push("authorize"); return {
          assertReadyForFirstChild: () => { effects.push("fence"); throw new Error("authorization expired"); },
          clockPreflightProof: freshClockProof(),
        }; },
        writeReceipt: async () => { effects.push("write"); },
      writeClockPreflightProof: async () => {},
      }, new AbortController().signal,
    )).rejects.toThrow("authorization expired");
    expect(effects).toEqual(["admission", "acquire", "authorize", "fence", "release"]);
  });

  it("publishes the fresh post-lease clock proof consumed by children, not the stale audit proof", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "10000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => admittedReceipt(), assertReceiptAbsent: async () => {},
        authorizeFreshAdmission: async () => { effects.push("authorize"); return freshAuthorization(); },
        createPorts: async () => ({
          acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
          awaitBarrier: async () => { throw new Error("stop-after-spawn"); }, awaitChildCompletion: async () => {},
          publishReleaseGate: async () => {}, publishSupplementalGate: async () => {},
          releaseCampaignLease: async () => { effects.push("release"); },
          startChild: async () => { effects.push("spawn"); return { childId: "conversation-observer" } as HostedCampaignChildHandle; },
          stopChild: async () => { effects.push("stop"); },
        }),
        now: () => Date.now(), readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => plan(), writeReceipt: async () => {},
        writeClockPreflightProof: async (path, proof) => {
          effects.push(`write:${proof.proofId}`);
          expect(path).toBe(definition().clockPreflightPath);
          expect(proof.proofId).toBe(freshClockProof().proofId);
          expect(proof.proofId).not.toBe(clockProof().proofId);
        },
      }, new AbortController().signal,
    )).rejects.toThrow();
    expect(effects.slice(0, 4)).toEqual(["acquire", "authorize", `write:${freshClockProof().proofId}`, "spawn"]);
  });

  it("rejects a supplied plan that was not independently rebuilt from definition and bindings", async () => {
    const effects: string[] = [];
    let nowEpochMs = 100;
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmissionAudit: () => { effects.push("admission"); return admittedReceipt(); },
        assertReceiptAbsent: async () => {},
        createPorts: async () => { effects.push("factory"); throw new Error("unreachable"); },
        now: () => nowEpochMs,

        readAdmission: async () => ({}), readBindings: async () => bindings(),
        readDefinition: async () => definition(), readPlan: async () => ({ ...plan(), thresholds: { answerFirstPacketMilliseconds: 1 } }),
        authorizeFreshAdmission: async () => (freshAuthorization()),
        writeReceipt: async () => { effects.push("write"); },
      writeClockPreflightProof: async () => {},
      }, new AbortController().signal,
    )).rejects.toThrow(/does not match the definition and bindings/u);
    expect(effects).toEqual([]);
  });

  it("rejects an existing receipt before reading the plan or acquiring the campaign", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"], {
      assertAdmissionAudit: () => { effects.push("admission"); return {} as never; },
      assertReceiptAbsent: async () => { throw new Error("receipt collision"); },
      now: () => { effects.push("clock"); return Date.now(); },
      readPlan: async () => { effects.push("read-plan"); return plan(); },
      writeReceipt: async () => { effects.push("write-receipt"); },
      writeClockPreflightProof: async () => {},
      createPorts: async () => ({
        acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
        awaitChildCompletion: async () => {}, publishReleaseGate: async () => {},
        publishSupplementalGate: async () => {}, startChild: async () => { effects.push("start"); return { childId: "x" } as HostedCampaignChildHandle; },
        awaitBarrier: async () => { throw new Error("unreachable"); }, releaseCampaignLease: async () => {}, stopChild: async () => {},
      }),
      readAdmission: async () => { effects.push("read-admission"); return {}; },
      readBindings: async () => { effects.push("read-bindings"); return bindings(); },
      readDefinition: async () => { effects.push("read-definition"); return definition(); },
      authorizeFreshAdmission: async () => { effects.push("authorize"); return freshAuthorization(); },
    }, new AbortController().signal)).rejects.toThrow("receipt collision");
    expect(effects).toEqual([]);
  });
});
