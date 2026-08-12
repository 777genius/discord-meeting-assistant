export const conversationVoiceCampaignIdentities = Object.freeze({
  botik: "1534231284467896512",
  guild: "1533228590643155034",
  observer: "1533867700575670282",
  speakerD: "1533873978417086474",
  speakerEn: "1533228054724346087",
  speakerRu: "1533227577286852649",
  voiceChannel: "1533228823045214398",
});

export interface ConversationVoiceCampaignRole {
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly role: string;
  readonly turnId?: string;
  readonly turnIdSource: "file" | "literal";
}

export const conversationVoiceCampaignRoles: readonly ConversationVoiceCampaignRole[] = Object.freeze([
  Object.freeze({
    purpose: "greeting" as const,
    role: "observer-unknown" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.observer}`,
    turnIdSource: "literal" as const,
  }),
  Object.freeze({
    purpose: "greeting" as const,
    role: "speaker-ru-known" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerRu}`,
    turnIdSource: "literal" as const,
  }),
  Object.freeze({
    purpose: "greeting" as const,
    role: "speaker-en-known" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerEn}`,
    turnIdSource: "literal" as const,
  }),
  Object.freeze({
    purpose: "greeting" as const,
    role: "speaker-d-unknown" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerD}`,
    turnIdSource: "literal" as const,
  }),
  Object.freeze({
    purpose: "addressed-answer" as const,
    role: "speaker-d-addressed-answer" as const,
    turnIdSource: "file" as const,
  }),
  Object.freeze({
    purpose: "farewell" as const,
    role: "explicit-group-farewell" as const,
    turnId: "meeting-farewell:v1",
    turnIdSource: "literal" as const,
  }),
]);

type CapturePurpose = "addressed-answer" | "farewell" | "greeting";

interface PlannedCapture {
  readonly attemptId: string;
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly outputPath: string;
  readonly purpose: CapturePurpose;
  readonly turnId?: string | undefined;
  readonly turnIdFile?: string | undefined;
}

interface RetainedCapture {
  readonly capture: {
    readonly acceptedDurationMilliseconds: number;
    readonly endedAt: { readonly epochMilliseconds: number };
    readonly expectedDuration: {
      readonly maximumMilliseconds: number;
      readonly minimumMilliseconds: number;
    };
    readonly firstPacketAt: { readonly epochMilliseconds: number };
  };
  readonly correlation: {
    readonly purpose: CapturePurpose;
    readonly turnId: string;
  };
}

interface LifecycleEvent {
  readonly greetingLocale?: "en" | "ru";
  readonly observedAt: string;
  readonly participantId?: string;
  readonly participantNameStatus?: "known" | "unknown";
  readonly turnId: string;
  readonly type: "addressed-answer" | "farewell" | "greeting";
}

interface CampaignTarget {
  readonly craigBotId: string;
  readonly guildId: string;
  readonly observerApplicationId: string;
  readonly voiceChannelId: string;
}

export function assertConversationVoiceCampaignTarget(target: CampaignTarget): void {
  const expected = conversationVoiceCampaignIdentities;
  if (
    target.craigBotId !== expected.botik ||
    target.guildId !== expected.guild ||
    target.observerApplicationId !== expected.observer ||
    target.voiceChannelId !== expected.voiceChannel
  ) {
    throw new Error(
      "Conversation voice campaign target must match the pinned Botik, observer, guild, and voice channel",
    );
  }
}

export function assertConversationVoiceCampaignPlan(
  captures: readonly PlannedCapture[],
): void {
  const issue = conversationVoiceCampaignPlanIssue(captures);
  if (issue !== undefined) {
    throw new Error(`Conversation voice campaign plan is invalid: ${issue}`);
  }
}

export function conversationVoiceCampaignEvidenceIssue(
  captures: readonly RetainedCapture[],
): string | undefined {
  if (captures.length !== conversationVoiceCampaignRoles.length) {
    return `expected exactly ${conversationVoiceCampaignRoles.length} captures`;
  }
  for (const [index, role] of conversationVoiceCampaignRoles.entries()) {
    const capture = captures[index]!;
    if (capture.correlation.purpose !== role.purpose) {
      return `capture ${index + 1} must be ${role.role}`;
    }
    if (role.turnId !== undefined && capture.correlation.turnId !== role.turnId) {
      return `capture ${index + 1} must use ${role.role}'s pinned turn ID`;
    }
    const { acceptedDurationMilliseconds, expectedDuration } = capture.capture;
    if (
      acceptedDurationMilliseconds < expectedDuration.minimumMilliseconds ||
      acceptedDurationMilliseconds > expectedDuration.maximumMilliseconds
    ) {
      return `capture ${index + 1} duration must be within its retained minimum and maximum`;
    }
    if (index > 0) {
      const previous = captures[index - 1]!;
      if (
        previous.capture.endedAt.epochMilliseconds >=
          capture.capture.firstPacketAt.epochMilliseconds
      ) {
        return `capture ${index + 1} must start after capture ${index} ends`;
      }
    }
  }
  return undefined;
}

export function conversationVoiceCampaignLifecycleIssue(
  captures: readonly RetainedCapture[],
  events: readonly LifecycleEvent[],
  toleranceMilliseconds: number,
): string | undefined {
  if (events.length !== conversationVoiceCampaignRoles.length) {
    return `expected exactly ${conversationVoiceCampaignRoles.length} lifecycle events`;
  }
  const expected = conversationVoiceCampaignIdentities;
  const eventMatches = [
    isGreeting(events[0], expected.observer, "ru", "unknown"),
    isGreeting(events[1], expected.speakerRu, "ru", "known"),
    isGreeting(events[2], expected.speakerEn, "en", "known"),
    isGreeting(events[3], expected.speakerD, "ru", "unknown"),
    events[4]?.type === "addressed-answer" &&
      events[4].participantId === expected.speakerD &&
      events[4].turnId === captures[4]?.correlation.turnId,
    events[5]?.type === "farewell" && events[5].turnId === "meeting-farewell:v1",
  ];
  const mismatchIndex = eventMatches.findIndex((matches) => !matches);
  if (mismatchIndex >= 0) {
    return `lifecycle event ${mismatchIndex + 1} must match ${conversationVoiceCampaignRoles[mismatchIndex]!.role}`;
  }
  for (const [index, event] of events.entries()) {
    const observedAt = Date.parse(event.observedAt);
    if (!Number.isFinite(observedAt)) {
      return `lifecycle event ${index + 1} has an invalid observedAt`;
    }
    if (index > 0 && observedAt <= Date.parse(events[index - 1]!.observedAt)) {
      return `lifecycle event ${index + 1} must follow lifecycle event ${index}`;
    }
    const capture = captures[index]!;
    const firstPacketAt = capture.capture.firstPacketAt.epochMilliseconds;
    const endedAt = capture.capture.endedAt.epochMilliseconds;
    const timeBound = event.type === "addressed-answer"
      ? observedAt > captures[index - 1]!.capture.endedAt.epochMilliseconds &&
        observedAt <= firstPacketAt
      : observedAt >= firstPacketAt && observedAt <= endedAt + toleranceMilliseconds;
    if (!timeBound) {
      return `lifecycle event ${index + 1} is not time-bound to capture ${index + 1}`;
    }
  }
  return undefined;
}

export function conversationVoiceCampaignPreflight(
  captures: readonly PlannedCapture[],
): {
  readonly captures: readonly {
    readonly attemptId: string;
    readonly correlation: { readonly source: "file" | "literal"; readonly value: string };
    readonly expectedDuration: {
      readonly maximumMilliseconds: number;
      readonly minimumMilliseconds: number;
    };
    readonly ordinal: number;
    readonly outputPath: string;
    readonly purpose: CapturePurpose;
    readonly role: string;
  }[];
  readonly kind: "conversation-voice-campaign-preflight";
  readonly status: "validated";
} {
  assertConversationVoiceCampaignPlan(captures);
  return {
    captures: captures.map((capture, index) => ({
      attemptId: capture.attemptId,
      correlation: capture.turnIdFile === undefined
        ? { source: "literal", value: capture.turnId! }
        : { source: "file", value: capture.turnIdFile },
      expectedDuration: capture.expectedDuration,
      ordinal: index + 1,
      outputPath: capture.outputPath,
      purpose: capture.purpose,
      role: conversationVoiceCampaignRoles[index]!.role,
    })),
    kind: "conversation-voice-campaign-preflight",
    status: "validated",
  };
}

function conversationVoiceCampaignPlanIssue(
  captures: readonly PlannedCapture[],
): string | undefined {
  if (captures.length !== conversationVoiceCampaignRoles.length) {
    return `expected exactly ${conversationVoiceCampaignRoles.length} captures`;
  }
  for (const [index, role] of conversationVoiceCampaignRoles.entries()) {
    const capture = captures[index]!;
    if (capture.purpose !== role.purpose) {
      return `capture ${index + 1} must be ${role.role}`;
    }
    if (role.turnIdSource === "file") {
      if (capture.turnIdFile === undefined || capture.turnId !== undefined) {
        return `capture ${index + 1} must use a runtime turnIdFile`;
      }
      continue;
    }
    if (
      capture.turnId !== role.turnId || capture.turnIdFile !== undefined
    ) {
      return `capture ${index + 1} must use ${role.role}'s pinned literal turn ID`;
    }
  }
  return undefined;
}

function isGreeting(
  event: LifecycleEvent | undefined,
  participantId: string,
  greetingLocale: "en" | "ru",
  participantNameStatus: "known" | "unknown",
): boolean {
  return event?.type === "greeting" && event.participantId === participantId &&
    event.greetingLocale === greetingLocale &&
    event.participantNameStatus === participantNameStatus &&
    isAllowedGreetingTurnId(event.turnId, participantId);
}

function isAllowedGreetingTurnId(turnId: string, participantId: string): boolean {
  const baseTurnId = `participant-greeting:${participantId}`;
  return turnId === baseTurnId ||
    new Set([1, 2, 3].map((retry) => `${baseTurnId}:retry-${retry}`)).has(turnId);
}
