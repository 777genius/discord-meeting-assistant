import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RecordingReadyFileIdentitySource } from
  "../src/live-discord-playback-recording-identity-source.js";
import { HOSTED_CAMPAIGN_TARGET } from "../src/hosted-campaign-coordinator.js";

const receipt = {
  authoritativeSource: { eventDigestSha256: "e".repeat(64), eventId: "ready-1",
    kind: "meeting-platform-completion-receipt-v2", occurredAt: "2026-08-13T00:00:01.000Z" },
  meetingId: "recording-42", observedAt: "2026-08-13T00:00:02.000Z",
  pinnedTestTarget: { guildId: HOSTED_CAMPAIGN_TARGET.guildId,
    provenanceDigestSha256: "f".repeat(64), voiceChannelId: HOSTED_CAMPAIGN_TARGET.voiceChannelId },
  recordingId: "recording-42", runId: "run-42", schemaVersion: 1,
} as const;

describe("playback-link recording identity source", () => {
  it("returns undefined until the create-only receipt appears, then binds exact identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "playback-identity-"));
    const path = join(root, "ready.json");
    const source = new RecordingReadyFileIdentitySource(path);
    await expect(source.read()).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
    await expect(source.read()).resolves.toEqual({ meetingId: "recording-42", recordingId: "recording-42" });
  });

  it("rejects permissive files and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "playback-identity-"));
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    await writeFile(target, JSON.stringify(receipt), { mode: 0o600 });
    await chmod(target, 0o644);
    await expect(new RecordingReadyFileIdentitySource(target).read()).rejects.toThrow("mode-0600");
    await chmod(target, 0o600);
    await symlink(target, link);
    await expect(new RecordingReadyFileIdentitySource(link).read()).rejects.toThrow("mode-0600");
  });
});
