import { describe, expect, it } from "vitest";

import {
  InvalidArtifactLocatorError,
  parseS3ArtifactLocator,
} from "../src/index.js";

const policy = {
  bucket: "meeting-e2e-artifacts",
  keyPrefix: "recordings/",
} as const;

describe("parseS3ArtifactLocator", () => {
  it("accepts only the configured bucket and canonical prefix", () => {
    expect(
      parseS3ArtifactLocator(
        "s3://meeting-e2e-artifacts/recordings/meeting-1/track-a.flac",
        policy,
      ),
    ).toEqual({
      bucket: "meeting-e2e-artifacts",
      canonical:
        "s3://meeting-e2e-artifacts/recordings/meeting-1/track-a.flac",
      key: "recordings/meeting-1/track-a.flac",
      scheme: "s3",
    });
  });

  it.each([
    ["https://meeting-e2e-artifacts/recordings/a.flac", "invalid-scheme"],
    ["s3://other-bucket/recordings/a.flac", "bucket-not-allowed"],
    ["s3://meeting-e2e-artifacts/private/a.flac", "key-outside-prefix"],
    ["s3://meeting-e2e-artifacts/recordings/../private/a.flac", "invalid-key"],
    ["s3://meeting-e2e-artifacts/recordings/%2e%2e/a.flac", "non-canonical-locator"],
    ["s3://meeting-e2e-artifacts/recordings/a.flac?version=1", "non-canonical-locator"],
    ["s3://meeting-e2e-artifacts/recordings//a.flac", "invalid-key"],
    ["s3://meeting-e2e-artifacts/recordings/a.flac/", "invalid-key"],
    ["s3://meeting_e2e/recordings/a.flac", "invalid-bucket"],
  ] as const)("rejects %s", (locator, reason) => {
    try {
      parseS3ArtifactLocator(locator, policy);
      expect.unreachable("locator should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArtifactLocatorError);
      expect(error).toMatchObject({
        code: "INVALID_ARTIFACT_LOCATOR",
        reason,
      } satisfies Partial<InvalidArtifactLocatorError>);
    }
  });

  it("does not echo rejected locators in errors", () => {
    const secretKey = "recordings/private-secret.flac?credential=secret";

    try {
      parseS3ArtifactLocator(
        `s3://meeting-e2e-artifacts/${secretKey}`,
        policy,
      );
      expect.unreachable("locator should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidArtifactLocatorError);
      expect((error as Error).message).not.toContain(secretKey);
    }
  });
});
