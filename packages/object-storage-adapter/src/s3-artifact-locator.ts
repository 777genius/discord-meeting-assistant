import { InvalidArtifactLocatorError } from "./errors.js";

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;
const SAFE_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9!_.*'()-]+$/u;
const MAX_KEY_BYTES = 1_024;

export interface S3ArtifactLocator {
  readonly bucket: string;
  readonly canonical: string;
  readonly key: string;
  readonly scheme: "s3";
}

export interface S3ArtifactAccessPolicy {
  readonly bucket: string;
  /** Canonical slash-terminated prefix, for example `meeting-artifacts/`. */
  readonly keyPrefix?: string;
}

function isValidBucket(bucket: string): boolean {
  return (
    BUCKET_PATTERN.test(bucket) &&
    !bucket.includes("..") &&
    !IPV4_PATTERN.test(bucket)
  );
}

function isValidKey(key: string): boolean {
  if (
    key.length === 0 ||
    key.endsWith("/") ||
    new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES
  ) {
    return false;
  }

  const segments = key.split("/");
  return segments.every(
    (segment) =>
      segment !== "." &&
      segment !== ".." &&
      SAFE_KEY_SEGMENT_PATTERN.test(segment),
  );
}

function assertValidPolicy(policy: S3ArtifactAccessPolicy): void {
  if (!isValidBucket(policy.bucket)) {
    throw new InvalidArtifactLocatorError("invalid-bucket");
  }

  if (
    policy.keyPrefix !== undefined &&
    (policy.keyPrefix.length === 0 ||
      !policy.keyPrefix.endsWith("/") ||
      !isValidKey(`${policy.keyPrefix}placeholder`))
  ) {
    throw new InvalidArtifactLocatorError("invalid-key");
  }
}

export function parseS3ArtifactLocator(
  value: string,
  policy: S3ArtifactAccessPolicy,
): S3ArtifactLocator {
  assertValidPolicy(policy);

  if (!value.startsWith("s3://")) {
    throw new InvalidArtifactLocatorError("invalid-scheme");
  }

  if (
    value.includes("?") ||
    value.includes("#") ||
    value.includes("\\") ||
    value.includes("%")
  ) {
    throw new InvalidArtifactLocatorError("non-canonical-locator");
  }

  const authorityAndKey = value.slice("s3://".length);
  const separatorIndex = authorityAndKey.indexOf("/");
  if (separatorIndex < 1) {
    throw new InvalidArtifactLocatorError("non-canonical-locator");
  }

  const bucket = authorityAndKey.slice(0, separatorIndex);
  const key = authorityAndKey.slice(separatorIndex + 1);
  if (!isValidBucket(bucket)) {
    throw new InvalidArtifactLocatorError("invalid-bucket");
  }
  if (!isValidKey(key)) {
    throw new InvalidArtifactLocatorError("invalid-key");
  }
  if (bucket !== policy.bucket) {
    throw new InvalidArtifactLocatorError("bucket-not-allowed");
  }
  if (policy.keyPrefix !== undefined && !key.startsWith(policy.keyPrefix)) {
    throw new InvalidArtifactLocatorError("key-outside-prefix");
  }

  return Object.freeze({
    bucket,
    canonical: value,
    key,
    scheme: "s3" as const,
  });
}
