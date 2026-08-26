import { remove } from "confusables";

import type { IdentitySkeletonPortV1, IdentitySkeletonV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

const unsafeIdentityCharacter =
  /(?:\p{Default_Ignorable_Code_Point}|\p{Bidi_Control}|\p{Join_Control}|\p{Cc})/u;

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
      !unsafeIdentityCharacter.test(character)
    ).join("");
    const skeleton = remove(denyComparable).normalize("NFKC").toLocaleLowerCase("und");
    return Object.freeze({
      canonical,
      certainty: characters.some((character) => unsafeIdentityCharacter.test(character))
        ? "uncertain" as const
        : "certain" as const,
      skeleton,
    });
  }
}
