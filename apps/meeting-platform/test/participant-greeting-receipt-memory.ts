import type {
  LiveConversationOneShotReceiptPort,
  LiveConversationOneShotReceiptReservation,
} from "../src/live-runtime/contracts.js";

type MemoryReceiptState =
  | "commanded"
  | "completed"
  | "played"
  | "reserved"
  | "started"
  | "suppressed_ambiguous"
  | "suppressed_capacity"
  | "suppressed_stale";

const terminalReceiptStates = new Set<MemoryReceiptState>([
  "completed", "played", "started", "suppressed_ambiguous", "suppressed_capacity",
  "suppressed_stale",
]);

export class MemoryOneShotReceipts implements LiveConversationOneShotReceiptPort {
  readonly #capacityAdmissions = new Map<string, Set<string>>();
  readonly #states = new Map<string, {
    readonly expired?: boolean;
    readonly leaseToken?: string;
    readonly providerCommand?: { readonly locale: "en" | "ru"; readonly prompt: string };
    readonly providerCommandId?: string;
    readonly providerRecoveryDeadlineMilliseconds?: number;
    readonly state: MemoryReceiptState;
  }>();
  #leaseSequence = 0;

  public constructor(private readonly nowMilliseconds: () => number = () => 0) {}

  public beginGreetingAttempt(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["beginGreetingAttempt"]
    >>[0],
  ) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    if (this.#states.get(key)?.leaseToken !== input.leaseToken) {
      return Promise.reject(new Error("greeting attempt lost its reservation"));
    }
    this.#states.set(key, {
      leaseToken: input.leaseToken,
      providerCommand: { locale: input.locale, prompt: input.prompt },
      providerCommandId: input.providerCommandId,
      providerRecoveryDeadlineMilliseconds:
        this.#states.get(key)?.providerRecoveryDeadlineMilliseconds ??
        this.nowMilliseconds() + 120_000,
      state: "commanded",
    });
    return Promise.resolve();
  }

  public async beginGreetingCohortAttempt(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["beginGreetingCohortAttempt"]
    >>[0],
  ): Promise<void> {
    for (const receipt of input.receipts) {
      const current = this.#states.get(this.key("greeting", input.meetingId, receipt.subjectId));
      if (current?.leaseToken !== receipt.leaseToken) {
        throw new Error("greeting cohort attempt lost its reservation");
      }
    }
    for (const receipt of input.receipts) {
      await this.beginGreetingAttempt({
        kind: "greeting",
        leaseToken: receipt.leaseToken,
        locale: input.locale,
        meetingId: input.meetingId,
        prompt: input.prompt,
        providerCommandId: input.providerCommandId,
        subjectId: receipt.subjectId,
      });
    }
  }

  public confirmGreetingStarted(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["confirmGreetingStarted"]
    >>[0],
  ) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    const current = this.#states.get(key);
    if (current?.leaseToken !== input.leaseToken ||
      current.providerCommandId !== input.providerCommandId) {
      return Promise.reject(new Error("greeting start lost its command"));
    }
    for (const [candidateKey, candidate] of this.#states) {
      if (candidate.providerCommandId === input.providerCommandId &&
        candidate.state === "commanded") {
        this.#states.set(candidateKey, { ...candidate, state: "started" });
      }
    }
    return Promise.resolve();
  }

  public async confirmGreetingCohortStarted(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["confirmGreetingCohortStarted"]
    >>[0],
  ): Promise<void> {
    for (const receipt of input.receipts) {
      await this.confirmGreetingStarted({
        kind: "greeting",
        leaseToken: receipt.leaseToken,
        meetingId: input.meetingId,
        providerCommandId: input.providerCommandId,
        startedAtMilliseconds: input.startedAtMilliseconds,
        subjectId: receipt.subjectId,
      });
    }
  }

  public complete(input: Parameters<LiveConversationOneShotReceiptPort["complete"]>[0]) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    if (this.#states.get(key)?.leaseToken === input.leaseToken) {
      this.#states.set(key, { state: "completed" });
    }
    return Promise.resolve();
  }

  public release(input: Parameters<LiveConversationOneShotReceiptPort["release"]>[0]) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    if (this.#states.get(key)?.leaseToken === input.leaseToken) {
      this.#states.delete(key);
    }
    return Promise.resolve();
  }


  public releaseGreetingAttempt(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["releaseGreetingAttempt"]
    >>[0],
  ) {
    return this.release(input);
  }

  public reserve(
    input: Parameters<LiveConversationOneShotReceiptPort["reserve"]>[0],
  ): Promise<LiveConversationOneShotReceiptReservation> {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    const receipt = this.#states.get(key);
    if (receipt !== undefined && terminalReceiptStates.has(receipt.state)) {
      return Promise.resolve({ status: "completed" as const });
    }
    if (receipt?.state === "commanded" &&
      receipt.providerRecoveryDeadlineMilliseconds !== undefined &&
      this.nowMilliseconds() >= receipt.providerRecoveryDeadlineMilliseconds) {
      this.#states.set(key, { state: "suppressed_ambiguous" });
      return Promise.resolve({ status: "completed" as const });
    }
    if (receipt !== undefined && isActiveReceipt(receipt.state) &&
      receipt.expired !== true && input.reclaimActive !== true) {
      return Promise.resolve({ status: "in_flight" as const });
    }
    this.#leaseSequence += 1;
    const leaseToken = `greeting-test-lease-${this.#leaseSequence}`;
    const providerCommandId = receipt?.providerCommandId ?? `participant-greeting:${input.subjectId}`;
    this.#states.set(key, {
      ...(receipt?.providerCommand === undefined
        ? {}
        : { providerCommand: receipt.providerCommand }),
      ...(receipt?.providerRecoveryDeadlineMilliseconds === undefined
        ? {}
        : { providerRecoveryDeadlineMilliseconds:
            receipt.providerRecoveryDeadlineMilliseconds }),
      leaseToken,
      providerCommandId,
      state: receipt?.state === "commanded" ? "commanded" : "reserved",
    });
    return Promise.resolve(memoryReservation(
      receipt,
      leaseToken,
      providerCommandId,
      this.nowMilliseconds(),
    ));
  }

  public settleGreeting(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["settleGreeting"]
    >>[0],
  ) {
    const key = this.key(input.kind, input.meetingId, input.subjectId);
    const state = input.outcome === "played"
      ? "played"
      : input.reason === "stale"
        ? "suppressed_stale"
        : input.reason === "capacity" ? "suppressed_capacity" : "suppressed_ambiguous";
    const current = this.#states.get(key);
    if (current?.state === state) {
      return Promise.resolve();
    }
    if (current?.leaseToken !== input.leaseToken) {
      return Promise.reject(new Error("greeting settlement lost its attempt"));
    }
    for (const [candidateKey, candidate] of this.#states) {
      if (candidateKey === key ||
        (candidate.providerCommandId === current.providerCommandId &&
          (candidate.state === "commanded" || candidate.state === "started"))) {
        this.#states.set(candidateKey, { state });
      }
    }
    return Promise.resolve();
  }

  public reconcileGreetingCapacity(
    input: Parameters<NonNullable<
      LiveConversationOneShotReceiptPort["reconcileGreetingCapacity"]
    >>[0],
  ) {
    const commandedSubjectIds: string[] = [];
    const suppressedSubjectIds: string[] = [];
    const terminalSubjectIds: string[] = [];
    const admitted = this.#capacityAdmissions.get(input.meetingId) ?? new Set<string>();
    this.#capacityAdmissions.set(input.meetingId, admitted);
    for (const subjectId of input.orderedSubjectIds) {
      const key = this.key(input.kind, input.meetingId, subjectId);
      const current = this.#states.get(key);
      if (current?.state === "commanded") {
        commandedSubjectIds.push(subjectId);
        continue;
      }
      if (current !== undefined && current.state !== "reserved") {
        if (current.state === "suppressed_capacity") {
          suppressedSubjectIds.push(subjectId);
        } else {
          terminalSubjectIds.push(subjectId);
        }
        continue;
      }
      if (admitted.has(subjectId)) {
        continue;
      }
      if (admitted.size < input.capacity) {
        admitted.add(subjectId);
      } else {
        this.#states.set(key, { state: "suppressed_capacity" });
        suppressedSubjectIds.push(subjectId);
      }
    }
    return Promise.resolve({
      commandedSubjectIds,
      suppressedSubjectIds,
      terminalSubjectIds,
    });
  }

  public state(
    kind: "farewell" | "greeting",
    meetingId: string,
    subjectId: string,
  ): MemoryReceiptState | undefined {
    return this.#states.get(this.key(kind, meetingId, subjectId))?.state;
  }

  public expireReservations(): void {
    for (const [key, receipt] of this.#states) {
      if (receipt.state === "reserved" || receipt.state === "commanded") {
        this.#states.set(key, { ...receipt, expired: true });
      }
    }
  }

  private key(kind: string, meetingId: string, subjectId: string): string {
    return `${kind}\u0000${meetingId}\u0000${subjectId}`;
  }
}

function isActiveReceipt(state: MemoryReceiptState): boolean {
  return state === "reserved" || state === "commanded";
}

function memoryReservation(
  receipt: {
    readonly providerCommand?: { readonly locale: "en" | "ru"; readonly prompt: string };
    readonly providerRecoveryDeadlineMilliseconds?: number;
  } | undefined,
  leaseToken: string,
  providerCommandId: string,
  nowMilliseconds = 0,
): LiveConversationOneShotReceiptReservation {
  return {
    ...(receipt?.providerCommand === undefined ? {} : { providerCommand: receipt.providerCommand }),
    ...(receipt?.providerRecoveryDeadlineMilliseconds === undefined ? {} : {
      providerRecoveryRemainingMilliseconds: Math.max(
        0,
        receipt.providerRecoveryDeadlineMilliseconds - nowMilliseconds,
      ),
    }),
    leaseToken,
    providerCommandId,
    status: "reserved",
  };
}
