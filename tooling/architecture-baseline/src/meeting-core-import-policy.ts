interface ConsumerPolicy {
  readonly boundary: string;
  readonly roots: readonly string[];
  readonly allowFeatureSubpaths: readonly string[];
}

export interface MeetingCoreImportPolicy {
  readonly schemaVersion: 1;
  readonly packageName: string;
  readonly packageManifest: string;
  readonly productionSearchRoots: readonly string[];
  readonly featureSubpaths: readonly string[];
  readonly consumers: readonly ConsumerPolicy[];
}

function asRecord(value: unknown, description: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function readRequiredString(
  candidate: Record<string, unknown>,
  key: string,
  description: string,
): string {
  const value = candidate[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${description} must be a string.`);
  }
  return value;
}

function hasUniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function readUniqueStringArray(
  candidate: Record<string, unknown>,
  key: string,
  description: string,
  allowEmpty = false,
): readonly string[] {
  const value = candidate[key];
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${description} must be a unique string array.`);
  }
  const strings: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`${description} must be a unique string array.`);
    }
    strings.push(entry);
  }
  if (!hasUniqueValues(strings)) {
    throw new Error(`${description} must be a unique string array.`);
  }
  return strings;
}

function parseConsumer(value: unknown, index: number): ConsumerPolicy {
  const candidate = asRecord(value, `Meeting Core consumer at index ${index}`);
  const boundary = readRequiredString(
    candidate,
    "boundary",
    `Meeting Core consumer at index ${index} boundary`,
  );
  return {
    boundary,
    roots: readUniqueStringArray(
      candidate,
      "roots",
      `Meeting Core consumer ${boundary} roots`,
    ),
    allowFeatureSubpaths: readUniqueStringArray(
      candidate,
      "allowFeatureSubpaths",
      `Meeting Core consumer ${boundary} allowFeatureSubpaths`,
      true,
    ),
  };
}

function validateConsumers(
  consumers: readonly ConsumerPolicy[],
  featureSubpaths: readonly string[],
): void {
  if (!hasUniqueValues(consumers.map(({ boundary }) => boundary))) {
    throw new Error("Meeting Core consumer boundary IDs must be unique.");
  }
  if (!hasUniqueValues(consumers.flatMap(({ roots }) => roots))) {
    throw new Error("Meeting Core consumer roots must belong to exactly one boundary.");
  }

  const knownFeatures = new Set(featureSubpaths);
  for (const consumer of consumers) {
    for (const subpath of consumer.allowFeatureSubpaths) {
      if (!knownFeatures.has(subpath)) {
        throw new Error(
          `Meeting Core consumer ${consumer.boundary} allows unknown feature ${subpath}.`,
        );
      }
    }
  }
}

export function parseMeetingCoreImportPolicy(value: unknown): MeetingCoreImportPolicy {
  const candidate = asRecord(value, "Meeting Core import policy");
  if (candidate.schemaVersion !== 1) {
    throw new Error("Meeting Core import policy schemaVersion must be 1.");
  }
  if (!Array.isArray(candidate.consumers) || candidate.consumers.length === 0) {
    throw new Error("Meeting Core import policy consumers must be non-empty.");
  }

  const featureSubpaths = readUniqueStringArray(
    candidate,
    "featureSubpaths",
    "Meeting Core import policy featureSubpaths",
  );
  const consumers = candidate.consumers.map(parseConsumer);
  validateConsumers(consumers, featureSubpaths);

  return {
    schemaVersion: 1,
    packageName: readRequiredString(
      candidate,
      "packageName",
      "Meeting Core import policy packageName",
    ),
    packageManifest: readRequiredString(
      candidate,
      "packageManifest",
      "Meeting Core import policy packageManifest",
    ),
    productionSearchRoots: readUniqueStringArray(
      candidate,
      "productionSearchRoots",
      "Meeting Core import policy productionSearchRoots",
    ),
    featureSubpaths,
    consumers,
  };
}
