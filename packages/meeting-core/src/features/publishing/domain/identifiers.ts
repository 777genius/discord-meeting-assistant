import { requireNonEmpty } from "./errors.js";

declare const publishingIdentifierBrand: unique symbol;

type PublishingIdentifier<Kind extends string> = string & {
  readonly [publishingIdentifierBrand]: Kind;
};

export type PublicationTargetId = PublishingIdentifier<"PublicationTargetId">;
export type ExternalPublicationId = PublishingIdentifier<"ExternalPublicationId">;

function publishingIdentifier<Kind extends string>(
  value: string,
  field: string,
): PublishingIdentifier<Kind> {
  return requireNonEmpty(value, field) as PublishingIdentifier<Kind>;
}

export const createPublicationTargetId = (value: string): PublicationTargetId =>
  publishingIdentifier<"PublicationTargetId">(value, "publicationTargetId");

export const createExternalPublicationId = (value: string): ExternalPublicationId =>
  publishingIdentifier<"ExternalPublicationId">(value, "externalPublicationId");
