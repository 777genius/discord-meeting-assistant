import { chmod, lstat, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectHostedClockPreflight,
  type HostedClockPreflightProducerConfig,
} from "../src/collect-hosted-clock-preflight.js";
import { hostedClockPreflightReceiptV2Schema } from "../src/hosted-clock-proof-v2.js";

describe("hosted clock preflight producer", () => {
  it("writes a create-only V2 receipt from an exact bracketed probe", async () => {
    const config = await configFixture();

    await collectHostedClockPreflight(config, {
      collectClockPreflight: async () => exchange(),
    });

    const receipt = hostedClockPreflightReceiptV2Schema.parse(
      JSON.parse(await readFile(config.outputPath, "utf8")) as unknown,
    );
    expect(receipt).toMatchObject({
      method: "ssh-bracketed-clock-v2",
      qualifiedAtEpochMs: 1_010,
      schemaVersion: 2,
      validUntilEpochMs: 61_010,
    });
    expect(receipt.raw).toMatchObject({
      observerClockId: "host:codex-workers-eu-01",
      sourceClockId: "container:meeting-platform",
    });
    expect((await lstat(config.outputPath)).mode & 0o777).toBe(0o600);
    await expect(collectHostedClockPreflight(config, {
      collectClockPreflight: async () => exchange(),
    })).rejects.toThrow("already exists");
  });

  it("rejects excessive probe RTT and leaves no qualifying receipt", async () => {
    const config = await configFixture();
    const raw = exchange();
    await expect(collectHostedClockPreflight(config, {
      collectClockPreflight: async () => ({
        ...raw,
        observer: {
          ...raw.observer,
          after: { ...raw.observer.after, epochMs: 7_000, monotonicNs: "7000000000" },
        },
      }),
    })).rejects.toThrow("round trip exceeds");
    await expect(lstat(config.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function configFixture(): Promise<HostedClockPreflightProducerConfig> {
  const root = await mkdtemp(join(tmpdir(), "hosted-clock-preflight-"));
  await chmod(root, 0o700);
  return {
    outputPath: join(root, "preflight.json"),
    remote: {
      composeFile: "/srv/e2e/compose.yaml",
      craigProjectName: "craig-meeting-e2e",
      craigServiceName: "bot",
      environmentFile: "/srv/e2e/source.env",
      host: "codex-workers-eu-01",
      mutationTarget: "test-only",
      projectName: "discord-meeting-assistant",
      sourceRoot: "/srv/e2e/source",
    },
  };
}

function exchange() {
  return {
    observer: {
      after: { bootId: "observer-boot", epochMs: 1_010, monotonicNs: "1010000000" },
      before: { bootId: "observer-boot", epochMs: 1_000, monotonicNs: "1000000000" },
    },
    observerClockId: "host:codex-workers-eu-01",
    source: {
      after: { bootId: "source-boot", epochMs: 1_008, monotonicNs: "1008000000" },
      before: { bootId: "source-boot", epochMs: 1_005, monotonicNs: "1005000000" },
      sample: { bootId: "source-boot", epochMs: 1_007, monotonicNs: "1007000000" },
    },
    sourceClockId: "container:meeting-platform",
    target: {
      environment: "private-test-guild" as const,
      host: "codex-workers-eu-01" as const,
      project: "discord-meeting-assistant" as const,
    },
  };
}
