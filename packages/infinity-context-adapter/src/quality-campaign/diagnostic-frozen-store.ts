import type { HistoricalIndexPlanV1, HistoricalReleaseBindingV1, HistoricalRoomAuthoritySnapshotPort, HistoricalCandidateRecordV1 } from "@discord-meeting/meeting-core/meeting-knowledge";
import { PostgresDiagnosticFinalEvidence, assertConstructedPostgresDiagnosticFinalEvidence } from "@discord-meeting/postgres-adapter";
import { canonicalJson } from "./canonical.js";
const constructed = new WeakSet<object>();
/** A retained applied plan, not another historical database or production authority. */
export class DiagnosticFrozenStore implements HistoricalRoomAuthoritySnapshotPort {
  public constructor(readonly authority: PostgresDiagnosticFinalEvidence, readonly plan: HistoricalIndexPlanV1, readonly remoteDocumentIds: Readonly<Record<string, string>>) {
    assertConstructedPostgresDiagnosticFinalEvidence(authority);
    if (!plan.binding.scopeId.startsWith("diagnostic:") ||
      plan.documents.length !== Object.keys(remoteDocumentIds).length ||
      plan.documents.some(d => (remoteDocumentIds[d.manifest.documentExternalId] ?? "").length === 0)) {
      throw new Error("diagnostic index receipt is incomplete");
    }
    constructed.add(this);
    Object.freeze(this);
  }
  public async loadRoomAuthoritySnapshot(input: Parameters<HistoricalRoomAuthoritySnapshotPort["loadRoomAuthoritySnapshot"]>[0]) {
    input.signal?.throwIfAborted();
    this.assertScope(input.scopeId, input.roomId);
    const acceptedMeeting = await this.authority.loadFrozenProjection();
    return { schemaVersion: 1 as const, status: "current" as const, entries: [{
          acceptedMeeting, binding: this.plan.binding, plan: this.plan, remoteDocumentIds: this.remoteDocumentIds,
        }] };
  }
  public async findCurrentCandidates(scopeId: string, roomId: string, locators: readonly string[]): Promise<readonly HistoricalCandidateRecordV1[]> {
    this.assertScope(scopeId, roomId);
    if (new Set(locators).size !== locators.length) {
      throw new Error("duplicate diagnostic locator");
    }
    await this.authority.loadFrozenProjection();
    return locators.map(locator => {
      const ordinal = this.plan.documents.findIndex(d => d.manifest.candidateLocator === locator);
      if (ordinal < 0) {
        throw new Error("foreign diagnostic locator");
      }
      return { ordinal, binding: this.plan.binding, plan: this.plan, remoteDocumentIds: this.remoteDocumentIds };
    });
  }
  public async isCurrentGeneration(binding: HistoricalReleaseBindingV1, generation: string): Promise<boolean> {
    await this.authority.loadFrozenProjection();
    return canonicalJson(binding) === canonicalJson(this.plan.binding) &&
      generation === this.plan.topology.indexGeneration;
  }
  private assertScope(scope: string, room: string): void {
    if (scope !== this.plan.binding.scopeId || room !== this.plan.binding.roomId) {
      throw new Error("foreign diagnostic scope");
    }
  }
}
export function assertDiagnosticFrozenStore(value: unknown): asserts value is DiagnosticFrozenStore {
  if (typeof value !== "object" || value === null || !constructed.has(value)) {
    throw new Error("diagnostic store must be concrete");
  }
}
