import { readFile } from "node:fs/promises";

export const MEETING_PLATFORM_BUILD_REVISION_PATH =
  "/opt/discord-meeting/meeting-platform-source-revision";

export type BuildRevisionReader = () => Promise<string>;

export async function readMeetingPlatformBuildRevision(): Promise<string> {
  const value = (await readFile(
    MEETING_PLATFORM_BUILD_REVISION_PATH,
    { encoding: "utf8" },
  )).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error(
      "immutable Meeting Platform build revision is missing or invalid",
    );
  }
  return value;
}
