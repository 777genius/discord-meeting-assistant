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
  readonly correlationSource: "handshake" | "literal";
  readonly purpose: "addressed-answer" | "farewell" | "greeting";
  readonly role: string;
  readonly turnId?: string;
}

export const conversationVoiceCampaignRoles: readonly ConversationVoiceCampaignRole[] = Object.freeze([
  Object.freeze({
    correlationSource: "literal" as const,
    purpose: "greeting" as const,
    role: "observer-unknown" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.observer}`,
  }),
  Object.freeze({
    correlationSource: "literal" as const,
    purpose: "greeting" as const,
    role: "speaker-ru-known" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerRu}`,
  }),
  Object.freeze({
    correlationSource: "literal" as const,
    purpose: "greeting" as const,
    role: "speaker-en-known" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerEn}`,
  }),
  Object.freeze({
    correlationSource: "literal" as const,
    purpose: "greeting" as const,
    role: "speaker-d-unknown" as const,
    turnId: `participant-greeting:${conversationVoiceCampaignIdentities.speakerD}`,
  }),
  Object.freeze({
    correlationSource: "handshake" as const,
    purpose: "addressed-answer" as const,
    role: "speaker-d-addressed-answer" as const,
  }),
  Object.freeze({
    correlationSource: "literal" as const,
    purpose: "farewell" as const,
    role: "explicit-group-farewell" as const,
    turnId: "meeting-farewell:v1",
  }),
]);

type CapturePurpose = "addressed-answer" | "farewell" | "greeting";

interface PlannedCapture {
  readonly attemptId?: string | undefined;
  readonly expectedDuration: {
    readonly maximumMilliseconds: number;
    readonly minimumMilliseconds: number;
  };
  readonly outputPath: string;
  readonly playbackHandshakeRoot?: string | undefined;
  readonly purpose: CapturePurpose;
  readonly turnId?: string | undefined;
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
  const selection = selectConversationVoiceCampaignLifecycle(captures, events);
  if (selection.issue !== undefined) {
    return selection.issue;
  }
  const campaignEvents = selection.events;
  if (campaignEvents.length !== conversationVoiceCampaignRoles.length) {
    return `expected exactly ${conversationVoiceCampaignRoles.length} lifecycle events`;
  }
  const expected = conversationVoiceCampaignIdentities;
  const eventMatches = [
    isGreeting(campaignEvents[0], expected.observer, "ru", "unknown"),
    isGreeting(campaignEvents[1], expected.speakerRu, "ru", "known"),
    isGreeting(campaignEvents[2], expected.speakerEn, "en", "known"),
    isGreeting(campaignEvents[3], expected.speakerD, "ru", "unknown"),
    campaignEvents[4]?.type === "addressed-answer" &&
      campaignEvents[4].participantId === expected.speakerD &&
      campaignEvents[4].turnId === captures[4]?.correlation.turnId,
    campaignEvents[5]?.type === "farewell" &&
      campaignEvents[5].turnId === "meeting-farewell:v1",
  ];
  const mismatchIndex = eventMatches.findIndex((matches) => !matches);
  if (mismatchIndex >= 0) {
    return `lifecycle event ${mismatchIndex + 1} must match ${conversationVoiceCampaignRoles[mismatchIndex]!.role}`;
  }
  for (const [index, event] of campaignEvents.entries()) {
    const observedAt = Date.parse(event.observedAt);
    if (!Number.isFinite(observedAt)) {
      return `lifecycle event ${index + 1} has an invalid observedAt`;
    }
    if (index > 0 && observedAt <= Date.parse(campaignEvents[index - 1]!.observedAt)) {
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

export function selectConversationVoiceCampaignLifecycle<Event extends LifecycleEvent>(
  captures: readonly RetainedCapture[],
  events: readonly Event[],
): { readonly events: readonly Event[]; readonly issue?: string } {
  const selected: Event[] = [];
  for (const [eventIndex, event] of events.entries()) {
    const matchingCaptureCount = captures.filter((capture) =>
      capture.correlation.purpose === event.type &&
      isLifecycleTurnBinding(event, capture.correlation.turnId)
    ).length;
    if (matchingCaptureCount > 1) {
      return {
        events: selected,
        issue: `lifecycle event ${eventIndex + 1} ambiguously matches multiple captures`,
      };
    }
    if (matchingCaptureCount === 1) {
      selected.push(event);
    }
  }
  return { events: selected };
}

export function conversationVoiceCampaignPreflight(
  captures: readonly PlannedCapture[],
): {
  readonly captures: readonly {
    readonly attemptId?: string;
    readonly correlation: { readonly source: "handshake" | "literal"; readonly value: string };
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
      ...(capture.attemptId === undefined ? {} : { attemptId: capture.attemptId }),
      correlation: capture.playbackHandshakeRoot === undefined
        ? { source: "literal", value: capture.turnId! }
        : { source: "handshake", value: capture.playbackHandshakeRoot },
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
    if (role.correlationSource === "handshake") {
      if (capture.playbackHandshakeRoot === undefined || capture.attemptId !== undefined ||
        capture.turnId !== undefined) {
        return `capture ${index + 1} must derive attempt and turn IDs from a playback handshake`;
      }
      continue;
    }
    if (
      capture.attemptId === undefined || capture.turnId !== role.turnId ||
      capture.playbackHandshakeRoot !== undefined
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

function isLifecycleTurnBinding(event: LifecycleEvent, capturedTurnId: string): boolean {
  return capturedTurnId === event.turnId || event.type === "greeting" &&
    event.participantId !== undefined &&
    isAllowedGreetingTurnId(event.turnId, event.participantId) &&
    capturedTurnId === `participant-greeting:${event.participantId}`;
}
