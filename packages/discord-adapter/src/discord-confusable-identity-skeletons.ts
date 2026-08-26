import { remove } from "confusables";

import type { IdentitySkeletonPortV1, IdentitySkeletonV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

const unsafeIdentityUnicodeProperty =
  /(?:\p{Default_Ignorable_Code_Point}|\p{Bidi_Control}|\p{Join_Control}|\p{Cf}|\p{Cc})/u;

// Unicode reserves these complete ranges for default-ignorable semantics. Keep
// them explicit so certainty does not depend on whether the runtime's Unicode
// tables have assigned each code point yet (notably U+FFF0..U+FFF8 and tags).
const reservedDefaultIgnorableRanges = [
  [0x2065, 0x2065],
  [0xFFF0, 0xFFF8],
  [0xE0000, 0xE0FFF],
] as const;

function isUnsafeIdentityCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return unsafeIdentityUnicodeProperty.test(character) ||
    (codePoint !== undefined && reservedDefaultIgnorableRanges.some(
      ([start, end]) => codePoint >= start && codePoint <= end,
    ));
}

/**
 * Discord-owned deterministic deny-only adapter over the reviewed confusable
 * mapping. Its skeleton can identify ambiguity but can never authorize an
 * identity match; Meeting Core reserves that to safe canonical equality.
 */
export class DiscordConfusableIdentitySkeletons implements IdentitySkeletonPortV1 {
  public skeleton(value: string): IdentitySkeletonV1 {
    const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
    const characters = Array.from(canonical);
    const denyComparable = characters.filter((character) =>
      !isUnsafeIdentityCharacter(character)
    ).join("");
    const skeleton = remove(denyComparable).normalize("NFKC").toLocaleLowerCase("und");
    return Object.freeze({
      canonical,
      certainty: characters.some(isUnsafeIdentityCharacter)
        ? "uncertain" as const
        : "certain" as const,
      skeleton,
    });
  }
}
