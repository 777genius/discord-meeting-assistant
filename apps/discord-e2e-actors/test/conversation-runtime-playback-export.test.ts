import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("conversation playback readiness runtime export", () => {
  it("loads in the same plain Node runtime used by hosted campaign children", async () => {
    const { stderr, stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        "import { conversationPlaybackReadinessProtocolVersion }",
        "from '@discord-meeting/conversation-runtime-contracts/playback-readiness';",
        "process.stdout.write(String(conversationPlaybackReadinessProtocolVersion));",
      ].join(" "),
    ], {
      cwd: new URL("..", import.meta.url),
      timeout: 10_000,
    });

    expect(stderr).toBe("");
    expect(stdout).toBe("1");
  });
});
