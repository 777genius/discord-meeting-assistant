interface Actor { readonly actorId: string; readonly kind: "automation" | "human" | "unknown" }

function canonical(actors: readonly Actor[]): readonly Actor[] {
  return [...actors].toSorted((left, right) => left.actorId.localeCompare(right.actorId) ||
    left.kind.localeCompare(right.kind));
}

export function historicalReplyProducerBindingsMatch(input: {
  readonly authority: { readonly meetingId: string; readonly turns: readonly {
    readonly speakerId: string }[] };
  readonly botActorId: string;
  readonly guildId: string;
  readonly intendedActors: readonly Actor[];
  readonly producer: {
    readonly actors: readonly Actor[];
    readonly identityProvenance: { readonly producerRevision: string };
    readonly lifecycleGeneration: number;
    readonly meetingIdentity: { readonly guildId: string; readonly meetingId: string;
      readonly recordingId: string };
  };
  readonly readiness: { readonly actors: readonly Actor[]; readonly lifecycleGeneration: number;
    readonly producerRevision: string };
}): boolean {
  const intended = canonical(input.intendedActors);
  const kinds = new Map(input.readiness.actors.map(({ actorId, kind }) => [actorId, kind]));
  return new Set(input.intendedActors.map(({ actorId }) => actorId)).size ===
      input.intendedActors.length &&
    JSON.stringify(intended) === JSON.stringify(input.producer.actors) &&
    JSON.stringify(intended) === JSON.stringify(canonical(input.readiness.actors)) &&
    input.producer.identityProvenance.producerRevision === input.readiness.producerRevision &&
    input.producer.lifecycleGeneration === input.readiness.lifecycleGeneration &&
    input.producer.meetingIdentity.meetingId === input.authority.meetingId &&
    input.producer.meetingIdentity.recordingId === input.authority.meetingId &&
    input.producer.meetingIdentity.guildId === input.guildId &&
    intended.filter(({ kind }) => kind === "automation").length === 1 &&
    intended.find(({ actorId }) => actorId === input.botActorId)?.kind === "automation" &&
    intended.every(({ actorId, kind }) => actorId === input.botActorId || kind === "human") &&
    input.authority.turns.every(({ speakerId }) => kinds.get(speakerId) === "human");
}
