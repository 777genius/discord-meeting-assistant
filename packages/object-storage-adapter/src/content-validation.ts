import { createHash } from "node:crypto";

import {
  ArtifactIntegrityError,
  ArtifactOperationCancelledError,
} from "./errors.js";

export const CHECKSUM_METADATA_KEY = "artifact-sha256";
export const SIZE_METADATA_KEY = "artifact-size-bytes";

const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/u;
const METADATA_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u;
const MAX_METADATA_BYTES = 1_024;
const MAX_CONTENT_TYPE_BYTES = 255;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 32 || codeUnit === 127) {
      return true;
    }
  }
  return false;
}

export function assertChecksumSha256(value: string): string {
  if (!CHECKSUM_PATTERN.test(value)) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }
  return value;
}

export function assertSizeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }
  return value;
}

export function assertContentType(value: string): string {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_CONTENT_TYPE_BYTES ||
    !MEDIA_TYPE_PATTERN.test(value) ||
    containsControlCharacter(value)
  ) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }
  return value;
}

export function validateUserMetadata(
  metadata: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (metadata === undefined) {
    return Object.freeze({});
  }

  const validated: Record<string, string> = {};
  let encodedBytes = 0;
  for (const [key, value] of Object.entries(metadata)) {
    if (
      !METADATA_KEY_PATTERN.test(key) ||
      key === CHECKSUM_METADATA_KEY ||
      key === SIZE_METADATA_KEY ||
      containsControlCharacter(value)
    ) {
      throw new ArtifactIntegrityError("invalid-metadata");
    }
    encodedBytes += new TextEncoder().encode(`${key}:${value}`).byteLength;
    validated[key] = value;
  }

  if (encodedBytes > MAX_METADATA_BYTES) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }
  return Object.freeze(validated);
}

export function createOperationSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ArtifactIntegrityError("invalid-metadata");
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return callerSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([callerSignal, timeoutSignal]);
}

function throwWhenAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ArtifactOperationCancelledError({ cause: signal.reason });
  }
}

export function assertOperationActive(signal: AbortSignal): void {
  throwWhenAborted(signal);
}

function asUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  throw new ArtifactIntegrityError("unsupported-body");
}

function hasAsyncIterator(value: unknown): value is AsyncIterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function hasByteArrayTransformer(
  value: unknown,
): value is { transformToByteArray(): Promise<Uint8Array> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "transformToByteArray" in value &&
    typeof value.transformToByteArray === "function"
  );
}

export async function* toByteChunks(body: unknown): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    yield asUint8Array(body);
    return;
  }

  if (hasAsyncIterator(body)) {
    for await (const chunk of body) {
      yield asUint8Array(chunk);
    }
    return;
  }

  if (hasByteArrayTransformer(body)) {
    yield await body.transformToByteArray();
    return;
  }

  throw new ArtifactIntegrityError("unsupported-body");
}

export async function* verifyByteStream(
  source: AsyncIterable<Uint8Array>,
  expectation: { readonly checksumSha256: string; readonly sizeBytes: number },
  signal: AbortSignal,
): AsyncIterable<Uint8Array> {
  const checksumSha256 = assertChecksumSha256(expectation.checksumSha256);
  const expectedSizeBytes = assertSizeBytes(expectation.sizeBytes);
  const hash = createHash("sha256");
  let observedSizeBytes = 0;

  throwWhenAborted(signal);
  for await (const chunk of source) {
    throwWhenAborted(signal);
    const bytes = asUint8Array(chunk);
    observedSizeBytes += bytes.byteLength;
    if (observedSizeBytes > expectedSizeBytes) {
      throw new ArtifactIntegrityError("size-mismatch");
    }
    hash.update(bytes);
    yield bytes;
  }
  throwWhenAborted(signal);

  if (observedSizeBytes !== expectedSizeBytes) {
    throw new ArtifactIntegrityError("size-mismatch");
  }
  if (hash.digest("hex") !== checksumSha256) {
    throw new ArtifactIntegrityError("checksum-mismatch");
  }
}

export function checksumHexToBase64(checksumSha256: string): string {
  return Buffer.from(assertChecksumSha256(checksumSha256), "hex").toString(
    "base64",
  );
}
