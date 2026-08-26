import { z } from "zod";

const snowflake = z.string().regex(/^\d{17,20}$/u);
const participantName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !(
        codePoint <= 31 ||
        (codePoint >= 127 && codePoint <= 159) ||
        codePoint === 8_232 ||
        codePoint === 8_233
      );
    }),
  )
  .transform((value) => value.normalize("NFC"));
const participantGreetingProfileSchema = z
  .object({
    displayName: participantName,
    greetingLocale: z.enum(["ru", "en"]),
    spokenName: participantName,
  })
  .strict();
const participantGreetingProfilesSchema = z.record(
  snowflake,
  participantGreetingProfileSchema,
);

interface ParticipantGreetingProfile {
  readonly displayName: string;
  readonly greetingLocale: "ru" | "en";
  readonly spokenName: string;
}

export type ParticipantGreetingProfiles = Readonly<
  Record<string, ParticipantGreetingProfile>
>;

export function participantSpeakerAliases(
  profiles: ParticipantGreetingProfiles,
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(Object.entries(profiles).map(
    ([participantId, profile]) => [
      participantId,
      Object.freeze([...new Set([profile.displayName, profile.spokenName])]),
    ],
  )));
}

export function participantRetrievalActorAliases(
  profiles: ParticipantGreetingProfiles,
  actorKeys: { actorKeysForFilter(discordActorId: string): readonly string[] },
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(Object.entries(profiles).flatMap(
    ([participantId, profile]) => actorKeys.actorKeysForFilter(participantId).map(
      (actorKey) => [
        actorKey,
        Object.freeze([...new Set([profile.displayName, profile.spokenName])]),
      ],
    ),
  )));
}

export const participantGreetingProfilesEnvironmentSchema = z
  .string()
  .max(64_000)
  .optional()
  .transform(parseParticipantGreetingProfiles);

function parseParticipantGreetingProfiles(
  rawValue: string | undefined,
  context: z.RefinementCtx,
): ParticipantGreetingProfiles {
  if (rawValue === undefined || rawValue.trim() === "") {
    return Object.freeze({});
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawValue) as unknown;
  } catch {
    context.addIssue({
      code: "custom",
      message: "participant greeting profiles must be valid JSON",
    });
    return z.NEVER;
  }

  const result = participantGreetingProfilesSchema.safeParse(decoded);
  if (!result.success || Object.keys(result.data).length > 500) {
    context.addIssue({
      code: "custom",
      message: "participant greeting profiles are invalid",
    });
    return z.NEVER;
  }

  const entries = Object.entries(result.data)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(
      ([participantId, profile]) =>
        [participantId, Object.freeze(profile)] as const,
    );
  return Object.freeze(Object.fromEntries(entries));
}
