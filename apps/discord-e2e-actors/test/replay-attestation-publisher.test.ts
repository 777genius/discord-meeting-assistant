import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { publishReplayAttestation } from "../src/replay-attestation-publisher.js";

const manifestSource = new URL("./fixtures/manifest.v1.json", import.meta.url);
const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;
const sourceRevision = "c".repeat(40);

describe("replay attestation publisher", () => {
  it("derives the marker from the pinned manifest and passes it to one create-only remote command", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-attestation-publisher-"));
    const fixtureManifestPath = join(root, "manifest.json");
    await writeFile(fixtureManifestPath, await readFile(manifestSource));
    const runner = vi.fn(async (_config, script: string, args: readonly string[]) => {
      expect(script).toContain("e2e.test-only");
      expect(script.indexOf('env_file=$1')).toBeLessThan(script.indexOf("set -- $container_ids"));
      expect(script).toContain('docker compose --env-file "$env_file" -f "$compose_file"');
      expect(script).toContain('node --input-type=module -e "$node_program" "$attestation_path" "$encoded_marker"');
      expect(args[2]).toContain("O_EXCL");
      expect(args.slice(0, 2)).toEqual(["/srv/e2e/.env", "/srv/e2e/compose.yml"]);
      const markerBase = JSON.parse(Buffer.from(args[4]!, "base64url").toString("utf8")) as Record<string, unknown>;
      expect(markerBase).toEqual({
        fixtureSetId: "discord-meeting-ru-en-v6", purpose: "bullmq-post-call-replay",
        recordingId: "recording-1", runId: "run-1",
      });
      expect(args[2]).toContain("schemaVersion: 2");
      expect(script).toContain("source_revision");
      return `${JSON.stringify({
        containerId, imageId, path: "/tmp/discord-e2e-attestations/run-1.json",
        sourceRevision, status: "created",
      })}\n`;
    });
    await expect(publishReplayAttestation({
      composeFile: "/srv/e2e/compose.yml", envFile: "/srv/e2e/.env", fixtureManifestPath,
      host: "codex-workers-eu-01", mutationTarget: "test-only", recordingId: "recording-1",
      remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json",
      remoteSourceRoot: "/srv/e2e", runId: "run-1",
    }, runner)).resolves.toEqual({
      containerId, fixtureSetId: "discord-meeting-ru-en-v6", imageId, recordingId: "recording-1",
      remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json", runId: "run-1",
      sourceRevision,
    });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("fails closed before remote access for any non-pinned host", async () => {
    const runner = vi.fn();
    await expect(publishReplayAttestation({
      composeFile: "/srv/e2e/compose.yml", envFile: "/srv/e2e/.env",
      fixtureManifestPath: "/private/manifest.json",
      host: "other-host" as "codex-workers-eu-01", mutationTarget: "test-only", recordingId: "recording-1",
      remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json",
      remoteSourceRoot: "/srv/e2e", runId: "run-1",
    }, runner)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects an already-existing or otherwise failed remote publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "replay-attestation-publisher-"));
    const fixtureManifestPath = join(root, "manifest.json");
    await writeFile(fixtureManifestPath, await readFile(manifestSource));
    await expect(publishReplayAttestation({
      composeFile: "/srv/e2e/compose.yml", envFile: "/srv/e2e/.env", fixtureManifestPath,
      host: "codex-workers-eu-01", mutationTarget: "test-only", recordingId: "recording-1",
      remoteAttestationPath: "/tmp/discord-e2e-attestations/run-1.json",
      remoteSourceRoot: "/srv/e2e", runId: "run-1",
    }, async () => { throw new Error("file exists"); })).rejects.toThrow("file exists");
  });
});
