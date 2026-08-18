import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createGroundedVoiceRolloutAuthority } from
  "../src/composition/voice-grounded-answers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("grounded voice rollout authority", () => {
  it("rechecks durable state and revokes the old release without a restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-voice-rollout-"));
    roots.push(root);
    const stateFile = join(root, "state.json");
    const authority = createGroundedVoiceRolloutAuthority(stateFile, "release-a");
    const signal = new AbortController().signal;

    await writeFile(stateFile, JSON.stringify({ enabled: true, rolloutEpoch: "release-a" }));
    await expect(authority(signal)).resolves.toBe(true);

    await writeFile(stateFile, JSON.stringify({ enabled: false, rolloutEpoch: "release-a" }));
    await expect(authority(signal)).resolves.toBe(false);

    await writeFile(stateFile, JSON.stringify({ enabled: true, rolloutEpoch: "release-b" }));
    await expect(authority(signal)).resolves.toBe(false);
    await expect(createGroundedVoiceRolloutAuthority(stateFile, "release-b")(signal))
      .resolves.toBe(true);
  });

  it("fails closed for malformed, missing and aborted reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "grounded-voice-rollout-"));
    roots.push(root);
    const stateFile = join(root, "state.json");
    const authority = createGroundedVoiceRolloutAuthority(stateFile, "release-a");

    await expect(authority(new AbortController().signal)).resolves.toBe(false);
    await writeFile(stateFile, "{not-json");
    await expect(authority(new AbortController().signal)).resolves.toBe(false);

    const controller = new AbortController();
    controller.abort("revoked");
    await expect(authority(controller.signal)).rejects.toBeDefined();
  });
});
