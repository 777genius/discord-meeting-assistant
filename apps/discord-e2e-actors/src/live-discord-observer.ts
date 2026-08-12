interface LiveDiscordEmbedInput {
  readonly description: string | null | undefined;
  readonly fields: readonly LiveDiscordEmbedFieldInput[];
  readonly footerText?: string | null | undefined;
  readonly title: string | null | undefined;
  readonly url?: string | null | undefined;
}

interface LiveDiscordEmbedFieldInput {
  readonly inline: boolean | undefined;
  readonly name: string;
  readonly value: string;
}

export interface LiveDiscordMessageInput {
  readonly authorId: string;
  readonly content: string;
  readonly createdAtMilliseconds: number;
  readonly editedAtMilliseconds: number | null;
  readonly embeds: readonly LiveDiscordEmbedInput[];
  readonly id: string;
}

export interface LiveDiscordThreadInput {
  readonly id: string;
  readonly name: string;
  readonly parentId: string;
}

export type LiveDiscordProjectionContainerInput =
  | {
    readonly kind: "channel-message";
    readonly parentChannelId: string;
  }
  | ({ readonly kind: "thread" } & LiveDiscordThreadInput);

export interface LiveDiscordProjectionMessages {
  readonly messages: readonly LiveDiscordMessageInput[];
  readonly container: LiveDiscordProjectionContainerInput;
}

export interface LiveDiscordProjectionReader {
  poll(input: {
    readonly createdSinceMilliseconds: number;
    readonly resultChannelId: string;
  }): Promise<readonly LiveDiscordProjectionMessages[]>;
}

export interface LiveDiscordObserverClock {
  now(): number;
  wait(milliseconds: number): Promise<void>;
}

interface NormalizedLiveDiscordEmbed {
  readonly description: string | null;
  readonly fields: readonly NormalizedLiveDiscordEmbedField[];
  readonly title: string | null;
}

interface NormalizedLiveDiscordEmbedField {
  readonly inline: boolean;
  readonly name: string;
  readonly value: string;
}

export interface NormalizedLiveDiscordProjection {
  readonly channel: {
    readonly id: string;
  };
  readonly message: {
    readonly authorId: string;
    readonly content: string;
    readonly createdAt: string;
    readonly editedAt: string | null;
    readonly embeds: readonly NormalizedLiveDiscordEmbed[];
    readonly id: string;
  };
  readonly observedAt: string;
  readonly container:
    | { readonly kind: "channel-message"; readonly parentChannelId: string }
    | {
      readonly kind: "thread";
      readonly id: string;
      readonly name: string;
      readonly parentId: string;
    };
}

export interface LiveDiscordObservationTrace {
  readonly observation: {
    readonly captureDeadlineAt: string;
    readonly durationMilliseconds: number;
    readonly endedAt: string;
    readonly pollIntervalMilliseconds: number;
    readonly resultChannelId: string;
    readonly startedAt: string;
    readonly sutApplicationId: string;
  };
  readonly runId: string;
  readonly schemaVersion: 2;
  readonly snapshots: readonly NormalizedLiveDiscordProjection[];
}

export interface ObserveLiveDiscordInput {
  readonly durationMilliseconds: number;
  readonly pollIntervalMilliseconds: number;
  readonly resultChannelId: string;
  readonly runId: string;
  readonly sutApplicationId: string;
}

const systemClock: LiveDiscordObserverClock = {
  now: () => Date.now(),
  wait: (milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }),
};

export async function observeLiveDiscord(
  input: ObserveLiveDiscordInput,
  reader: LiveDiscordProjectionReader,
  clock: LiveDiscordObserverClock = systemClock,
): Promise<LiveDiscordObservationTrace> {
  const startedAtMilliseconds = clock.now();
  assertUnixTimestamp(startedAtMilliseconds, "observation start");
  const captureDeadlineMilliseconds = startedAtMilliseconds + input.durationMilliseconds;
  if (!Number.isSafeInteger(captureDeadlineMilliseconds)) {
    throw new Error("Live Discord observation deadline is outside the safe range");
  }

  const snapshots: NormalizedLiveDiscordProjection[] = [];
  const latestProjectionByMessage = new Map<string, string>();
  let shouldPoll = true;
  while (shouldPoll) {
    const projectionMessages = await reader.poll({
      createdSinceMilliseconds: startedAtMilliseconds,
      resultChannelId: input.resultChannelId,
    });
    const observedAtMilliseconds = clock.now();
    assertUnixTimestamp(observedAtMilliseconds, "observation poll");
    collectChangedProjections({
      captureDeadlineMilliseconds,
      observedAtMilliseconds,
      resultChannelId: input.resultChannelId,
      snapshots,
      startedAtMilliseconds,
      sutApplicationId: input.sutApplicationId,
      projectionMessages,
      latestProjectionByMessage,
    });

    const remainingMilliseconds = captureDeadlineMilliseconds - observedAtMilliseconds;
    if (remainingMilliseconds <= 0) {
      shouldPoll = false;
    } else {
      await clock.wait(Math.min(input.pollIntervalMilliseconds, remainingMilliseconds));
    }
  }

  const endedAtMilliseconds = clock.now();
  assertUnixTimestamp(endedAtMilliseconds, "observation end");
  if (snapshots.length === 0) {
    throw new Error("Live Discord observation found no SUT-authored projections in its capture window");
  }
  return Object.freeze({
    observation: Object.freeze({
      captureDeadlineAt: toIsoTimestamp(captureDeadlineMilliseconds, "capture deadline"),
      durationMilliseconds: input.durationMilliseconds,
      endedAt: toIsoTimestamp(endedAtMilliseconds, "observation end"),
      pollIntervalMilliseconds: input.pollIntervalMilliseconds,
      resultChannelId: input.resultChannelId,
      startedAt: toIsoTimestamp(startedAtMilliseconds, "observation start"),
      sutApplicationId: input.sutApplicationId,
    }),
    runId: input.runId,
    schemaVersion: 2,
    snapshots: Object.freeze(snapshots),
  });
}

export function normalizeLiveDiscordProjection(input: {
  readonly message: LiveDiscordMessageInput;
  readonly observedAtMilliseconds: number;
  readonly resultChannelId: string;
  readonly container: LiveDiscordProjectionContainerInput;
}): NormalizedLiveDiscordProjection {
  return Object.freeze({
    channel: Object.freeze({ id: requiredIdentifier(input.resultChannelId, "result channel") }),
    message: Object.freeze({
      authorId: requiredIdentifier(input.message.authorId, "message author"),
      // Discord permits embed-only messages. Preserve an empty content field so
      // the observer can still capture the visible embed projection.
      content: normalizeText(input.message.content),
      createdAt: toIsoTimestamp(input.message.createdAtMilliseconds, "message creation"),
      editedAt: input.message.editedAtMilliseconds === null
        ? null
        : toIsoTimestamp(input.message.editedAtMilliseconds, "message edit"),
      embeds: Object.freeze(input.message.embeds.map(normalizeEmbed)),
      id: requiredIdentifier(input.message.id, "message"),
    }),
    observedAt: toIsoTimestamp(input.observedAtMilliseconds, "projection observation"),
    container: normalizeContainer(input.container),
  });
}

export function liveDiscordProjectionFingerprint(
  projection: NormalizedLiveDiscordProjection,
): string {
  return JSON.stringify({
    channel: projection.channel,
    message: {
      authorId: projection.message.authorId,
      content: projection.message.content,
      embeds: projection.message.embeds,
      id: projection.message.id,
    },
    container: projection.container,
  });
}

export function isMessageInsideLiveCaptureWindow(
  message: LiveDiscordMessageInput,
  sutApplicationId: string,
  startedAtMilliseconds: number,
  captureDeadlineMilliseconds: number,
): boolean {
  return message.authorId === sutApplicationId &&
    message.createdAtMilliseconds >= startedAtMilliseconds &&
    message.createdAtMilliseconds <= captureDeadlineMilliseconds;
}

function collectChangedProjections(input: {
  readonly captureDeadlineMilliseconds: number;
  readonly latestProjectionByMessage: Map<string, string>;
  readonly observedAtMilliseconds: number;
  readonly resultChannelId: string;
  readonly snapshots: NormalizedLiveDiscordProjection[];
  readonly startedAtMilliseconds: number;
  readonly sutApplicationId: string;
  readonly projectionMessages: readonly LiveDiscordProjectionMessages[];
}): void {
  const orderedContainers = input.projectionMessages.toSorted((left, right) =>
    containerIdentity(left.container).localeCompare(containerIdentity(right.container))
  );
  for (const { messages, container } of orderedContainers) {
    const orderedMessages = messages.toSorted((left, right) =>
      left.createdAtMilliseconds - right.createdAtMilliseconds || left.id.localeCompare(right.id)
    );
    for (const message of orderedMessages) {
      if (!isMessageInsideLiveCaptureWindow(
        message,
        input.sutApplicationId,
        input.startedAtMilliseconds,
        input.captureDeadlineMilliseconds,
      )) {
        continue;
      }
      const projection = normalizeLiveDiscordProjection({
        message,
        observedAtMilliseconds: input.observedAtMilliseconds,
        resultChannelId: input.resultChannelId,
        container,
      });
      const identity = `${containerIdentity(projection.container)}:${projection.message.id}`;
      const fingerprint = liveDiscordProjectionFingerprint(projection);
      if (input.latestProjectionByMessage.get(identity) === fingerprint) {
        continue;
      }
      input.latestProjectionByMessage.set(identity, fingerprint);
      input.snapshots.push(projection);
    }
  }
}

function normalizeContainer(
  container: LiveDiscordProjectionContainerInput,
): NormalizedLiveDiscordProjection["container"] {
  if (container.kind === "channel-message") {
    return Object.freeze({
      kind: "channel-message" as const,
      parentChannelId: requiredIdentifier(container.parentChannelId, "parent channel"),
    });
  }
  return Object.freeze({
    kind: "thread" as const,
    id: requiredIdentifier(container.id, "thread"),
    name: normalizeRequiredText(container.name, "thread name"),
    parentId: requiredIdentifier(container.parentId, "thread parent"),
  });
}

function containerIdentity(container: LiveDiscordProjectionContainerInput | NormalizedLiveDiscordProjection["container"]): string {
  return container.kind === "thread"
    ? `thread:${container.id}`
    : `channel-message:${container.parentChannelId}`;
}

function normalizeEmbed(input: LiveDiscordEmbedInput): NormalizedLiveDiscordEmbed {
  return Object.freeze({
    description: normalizeOptionalText(input.description),
    fields: Object.freeze(input.fields.map((field) => Object.freeze({
      inline: field.inline ?? false,
      name: normalizeRequiredText(field.name, "embed field name"),
      value: normalizeRequiredText(field.value, "embed field value"),
    }))),
    title: normalizeOptionalText(input.title),
  });
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized.length === 0 ? null : normalized;
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = normalizeText(value);
  if (normalized.length === 0) {
    throw new Error(`Live Discord ${label} must not be empty`);
  }
  return normalized;
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

function requiredIdentifier(value: string, label: string): string {
  const identifier = value.trim();
  if (identifier.length === 0) {
    throw new Error(`Live Discord ${label} identifier must not be empty`);
  }
  return identifier;
}

function toIsoTimestamp(value: number, label: string): string {
  assertUnixTimestamp(value, label);
  return new Date(value).toISOString();
}

function assertUnixTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || Number.isNaN(new Date(value).valueOf())) {
    throw new Error(`Live Discord ${label} timestamp is invalid`);
  }
}
