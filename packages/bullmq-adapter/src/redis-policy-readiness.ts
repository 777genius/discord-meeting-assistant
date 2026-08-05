const REDIS_DURABILITY_SETTINGS = [
  "appendfsync",
  "appendonly",
  "maxmemory",
  "maxmemory-policy",
] as const;

type RedisDurabilitySetting = (typeof REDIS_DURABILITY_SETTINGS)[number];

export interface RedisPolicyClient {
  config(
    command: "GET",
    setting: RedisDurabilitySetting,
  ): Promise<unknown>;
}

export interface RedisPolicyClientProvider {
  readonly client: Promise<unknown>;
}

export interface RedisPolicyReadiness {
  assertReady(): Promise<void>;
}

export class RedisPolicyReadinessError extends Error {
  public constructor(violations: readonly string[]) {
    super(`Redis queue durability policy is invalid: ${violations.join("; ")}`);
    this.name = "RedisPolicyReadinessError";
  }
}

/**
 * Verifies the Redis settings required to preserve BullMQ state across restart
 * and to avoid eviction of queue records under memory pressure.
 */
export function createRedisPolicyReadiness(
  provider: RedisPolicyClientProvider,
): RedisPolicyReadiness {
  return Object.freeze({
    assertReady: async () => {
      await assertRedisQueueDurabilityPolicy(
        requireRedisPolicyClient(await provider.client),
      );
    },
  });
}

export async function assertRedisQueueDurabilityPolicy(
  client: RedisPolicyClient,
): Promise<void> {
  const responses = await Promise.all(
    REDIS_DURABILITY_SETTINGS.map(async (setting) => [
      setting,
      await client.config("GET", setting),
    ] as const),
  );
  const values = new Map<RedisDurabilitySetting, string>();
  for (const [setting, response] of responses) {
    values.set(setting, readRedisConfigurationValue(setting, response));
  }

  const violations = [
    ...(values.get("maxmemory-policy") === "noeviction"
      ? []
      : ["maxmemory-policy must be noeviction"]),
    ...(isPositiveByteLimit(values.get("maxmemory"))
      ? []
      : ["maxmemory must be a finite positive byte limit"]),
    ...(values.get("appendonly") === "yes"
      ? []
      : ["appendonly must be yes"]),
    ...(["everysec", "always"].includes(values.get("appendfsync") ?? "")
      ? []
      : ["appendfsync must be everysec or always"]),
  ];
  if (violations.length > 0) {
    throw new RedisPolicyReadinessError(violations);
  }
}

function isPositiveByteLimit(value: string | undefined): boolean {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return false;
  }
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && bytes > 0;
}

function readRedisConfigurationValue(
  expectedSetting: RedisDurabilitySetting,
  response: unknown,
): string {
  if (Array.isArray(response)) {
    for (let index = 0; index + 1 < response.length; index += 2) {
      const value: unknown = response[index + 1];
      if (response[index] === expectedSetting && typeof value === "string") {
        return value;
      }
    }
  }
  if (typeof response === "object" && response !== null) {
    for (const [setting, value] of Object.entries(response)) {
      if (setting === expectedSetting && typeof value === "string") {
        return value;
      }
    }
  }
  throw new RedisPolicyReadinessError([
    `could not read ${expectedSetting} from Redis CONFIG GET`,
  ]);
}

function requireRedisPolicyClient(value: unknown): RedisPolicyClient {
  if (!isRedisConfigCapable(value)) {
    throw new RedisPolicyReadinessError([
      "Redis client does not support CONFIG GET",
    ]);
  }
  return {
    config: async (command, setting) =>
      value.config(command, setting),
  };
}

function isRedisConfigCapable(
  value: unknown,
): value is { config(command: string, setting: string): unknown } {
  return (
    typeof value === "object"
    && value !== null
    && "config" in value
    && typeof value.config === "function"
  );
}
