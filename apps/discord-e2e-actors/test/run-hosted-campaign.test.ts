import { chmod, lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type HostedCampaignChildHandle,
  type HostedCampaignLeaseHandle,
} from "../src/hosted-campaign-coordinator.js";
import { buildResolvedHostedCampaignPlanV1 } from "../src/hosted-campaign-plan-builder.js";
import { parseHostedCampaignArguments, parseHostedCampaignPlan } from "../src/hosted-campaign-run-config.js";
import {
  assertHostedCampaignReceiptAbsent,
  loadHostedCampaignTrustedRuntimeEnvironment,
  readPrivateHostedCampaignPlan,
  resolveHostedCampaignBarrierRoot,
  runHostedCampaignCli,
  writeCreateOnlyHostedCampaignReceipt,
} from "../src/run-hosted-campaign.js";

const plan = () => {
  return buildResolvedHostedCampaignPlanV1({
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
  }, {
    runs: [1, 2, 3].map((ordinal) => ({
      remoteAttestationPath: `/tmp/discord-e2e-attestations/run-${ordinal}.json`,
    })),
    schemaVersion: 1,
  });
};

const admittedReceipt = () => ({
  remoteReadiness: { deploymentSafety: { revalidationBaseline: {
    campaignId: "campaign-1", deploymentFingerprint: "1".repeat(64),
    expectationSha256: "2".repeat(64), kind: "hosted-deployment-revalidation-baseline",
    schemaVersion: 1,
  } } },
}) as never;

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
      assertAdmission: () => { throw new Error("invalid admission"); },
      assertReceiptAbsent: async () => {},
      now: () => Date.now(),
      readPlan: async () => plan(),
      writeReceipt: async () => { written = true; },
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
      readBindings: async () => ({}), readDefinition: async () => ({}),
      revalidateTrustedAdmission: async () => {},
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
        assertAdmission: () => { effects.push("admission"); throw new Error("mismatch"); },
        assertReceiptAbsent: async () => {},
        createPorts: async () => { effects.push("factory"); throw new Error("unreachable"); },
        now: Date.now,
        readAdmission: async () => ({}), readBindings: async () => ({}),
        readDefinition: async () => ({}), readPlan: async () => plan(),
        revalidateTrustedAdmission: async () => { effects.push("revalidate"); },
        writeReceipt: async () => { effects.push("write"); },
      }, new AbortController().signal,
    )).rejects.toThrow("mismatch");
    expect(effects).toEqual(["admission"]);
  });

  it("preserves the deployment baseline across separate-CLI JSON and reaches createPorts when unchanged", async () => {
    const effects: string[] = [];
    const serializedAdmission = JSON.stringify(admittedReceipt());
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmission: () => { effects.push("admission"); return JSON.parse(serializedAdmission) as never; },
        assertReceiptAbsent: async () => {},
        createPorts: async () => {
          effects.push("factory");
          return {
            acquireCampaignLease: async () => { effects.push("acquire"); throw new Error("stop-after-lease"); },
            awaitBarrier: async () => { throw new Error("unreachable"); }, awaitChildCompletion: async () => {}, publishReleaseGate: async () => {},
            publishSupplementalGate: async () => {}, releaseCampaignLease: async () => {},
            startChild: async () => ({ childId: "x" }) as HostedCampaignChildHandle, stopChild: async () => {},
          };
        },
        now: Date.now,
        readAdmission: async () => ({}), readBindings: async () => ({}),
        readDefinition: async () => ({}), readPlan: async () => plan(), writeReceipt: async () => {},
        revalidateTrustedAdmission: async ({ deploymentBaseline }) => {
          effects.push("revalidate");
          expect(deploymentBaseline.deploymentFingerprint).toBe("1".repeat(64));
        },
      }, new AbortController().signal,
    )).rejects.toThrow("stop-after-lease");
    expect(effects).toEqual(["admission", "revalidate", "admission", "factory", "acquire"]);
  });

  it("fails closed before ports and leases when trusted pre-spawn revalidation fails", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmission: () => { effects.push("admission"); return admittedReceipt(); },
        assertReceiptAbsent: async () => {},
        createPorts: async () => { effects.push("factory"); throw new Error("unreachable"); },
        now: () => 123,
        readAdmission: async () => ({}), readBindings: async () => ({}),
        readDefinition: async () => ({}), readPlan: async () => plan(),
        revalidateTrustedAdmission: async ({ deploymentBaseline, nowEpochMs, signal }) => {
          effects.push(`revalidate:${nowEpochMs}:${String(signal.aborted)}`);
          const freshDeploymentFingerprint = "9".repeat(64);
          if (deploymentBaseline.deploymentFingerprint !== freshDeploymentFingerprint) {
            throw new Error("trusted deployment changed");
          }
        },
        writeReceipt: async () => { effects.push("write"); },
      }, new AbortController().signal,
    )).rejects.toThrow("trusted deployment changed");
    expect(effects).toEqual(["admission", "revalidate:123:false"]);
  });

  it("rechecks readiness expiry after revalidation and before creating ports", async () => {
    const effects: string[] = [];
    let nowEpochMs = 100;
    await expect(runHostedCampaignCli(
      ["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"],
      {
        assertAdmission: ({ nowEpochMs: checkedAt }) => {
          effects.push(`admission:${checkedAt}`);
          if (checkedAt >= 200) { throw new Error("remote readiness expired"); }
          return admittedReceipt();
        },
        assertReceiptAbsent: async () => {},
        createPorts: async () => { effects.push("factory"); throw new Error("unreachable"); },
        now: () => nowEpochMs,
        readAdmission: async () => ({}), readBindings: async () => ({}),
        readDefinition: async () => ({}), readPlan: async () => plan(),
        revalidateTrustedAdmission: async () => { effects.push("revalidate"); nowEpochMs = 200; },
        writeReceipt: async () => { effects.push("write"); },
      }, new AbortController().signal,
    )).rejects.toThrow("remote readiness expired");
    expect(effects).toEqual(["admission:100", "revalidate", "admission:200"]);
  });

  it("rejects an existing receipt before reading the plan or acquiring the campaign", async () => {
    const effects: string[] = [];
    await expect(runHostedCampaignCli(["/plan.json", "/receipt.json", "1000", "/admission.json", "/definition.json", "/bindings.json"], {
      assertAdmission: () => { effects.push("admission"); return {} as never; },
      assertReceiptAbsent: async () => { throw new Error("receipt collision"); },
      now: () => { effects.push("clock"); return Date.now(); },
      readPlan: async () => { effects.push("read-plan"); return plan(); },
      writeReceipt: async () => { effects.push("write-receipt"); },
      createPorts: async () => ({
        acquireCampaignLease: async () => { effects.push("acquire"); return { campaignId: "campaign-1" } as HostedCampaignLeaseHandle; },
        awaitChildCompletion: async () => {}, publishReleaseGate: async () => {},
        publishSupplementalGate: async () => {}, startChild: async () => { effects.push("start"); return { childId: "x" } as HostedCampaignChildHandle; },
        awaitBarrier: async () => { throw new Error("unreachable"); }, releaseCampaignLease: async () => {}, stopChild: async () => {},
      }),
      readAdmission: async () => { effects.push("read-admission"); return {}; },
      readBindings: async () => { effects.push("read-bindings"); return {}; },
      readDefinition: async () => { effects.push("read-definition"); return {}; },
      revalidateTrustedAdmission: async () => { effects.push("revalidate"); },
    }, new AbortController().signal)).rejects.toThrow("receipt collision");
    expect(effects).toEqual([]);
  });
});
