import { confusablesMap, remove } from "confusables";

import type { IdentitySkeletonPortV1, IdentitySkeletonV1 } from
  "@discord-meeting/meeting-core/meeting-knowledge";

const unsafeIdentityFormatting =
  /[\p{Bidi_Control}\p{Join_Control}\u034F\u061C\u180E\u200B\u2060\u2061-\u2064\u206A-\u206F\uFEFF]/u;
const asciiIdentitySkeleton = /^[a-z0-9]+$/u;
const asciiIdentityCharacter = /^[a-z0-9]$/u;

/** Discord-owned deterministic adapter over the reviewed confusable mapping. */
export class DiscordConfusableIdentitySkeletons implements IdentitySkeletonPortV1 {
  public skeleton(value: string): IdentitySkeletonV1 {
    const canonical = value.normalize("NFKC").toLocaleLowerCase("und");
    const skeleton = remove(canonical).normalize("NFKC").toLocaleLowerCase("und");
    const mappedCompletely = asciiIdentitySkeleton.test(skeleton) &&
      Array.from(canonical).every((character) =>
        !/[\p{L}\p{N}]/u.test(character) ||
        asciiIdentityCharacter.test(character) ||
        confusablesMap.has(character)
      );
    return Object.freeze({
      canonical,
      certainty: !unsafeIdentityFormatting.test(value) && mappedCompletely
        ? "certain" as const
        : "uncertain" as const,
      skeleton,
    });
  }
}
