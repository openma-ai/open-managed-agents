import type {
  EnvironmentWorkClaim,
  EnvironmentWorkClaimPort,
  OpenEnvironmentWorkClaimResult,
  PublishRuntimeResourcesResult,
  RuntimePublicationCandidate,
  RuntimeResourcePublication,
  RuntimeResourceScope,
  RuntimeOrphanPort,
  RuntimeOrphanRecord,
} from "@open-managed-agents/runtime-resource-contract";
import { runtimeOrphanId } from "@open-managed-agents/runtime-resource-contract";

export interface MemoryEnvironmentWorkClaimOptions {
  now?: () => Date;
  /** Work heartbeat TTL, measured from claim time. */
  ttlMs?: number;
}

interface WorkClaimRecord {
  generation: number;
  claimAt: number;
  token: string;
  /** claimed: starting/active; stopping: stop requested, claim kept; lost: force-stopped or expired. */
  state: "claimed" | "stopping" | "lost";
  publication: RuntimeResourcePublication | null;
  nextRevision: number;
}

function scopeKey(scope: RuntimeResourceScope): string {
  return [
    scope.workspaceId,
    scope.environmentId,
    scope.sessionId,
    scope.workId,
  ].join("\u0000");
}

function sameCandidate(
  left: RuntimePublicationCandidate | null,
  right: RuntimePublicationCandidate | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.contentHash === right.contentHash;
}

function sameRuntimeCheckpoint(
  left: RuntimeResourcePublication["runtimeCheckpoint"],
  right: RuntimeResourcePublication["runtimeCheckpoint"],
): boolean {
  // An omitted checkpoint differs from an explicit null, as in the SQL Port's
  // stable-JSON comparison of the publication fields.
  return (left === undefined) === (right === undefined)
    && JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Deterministic stand-in for the Work record's claim columns. `claim` plays
 * the protocol poll (a reclaim bumps claim_generation and rotates the Work
 * token); `requestStop` and `lose` play stop and force-stop/lease expiry.
 * Claim validation and pointer advancement happen in one synchronous step,
 * like the SQL conditional write.
 */
export class MemoryEnvironmentWorkClaimPort implements EnvironmentWorkClaimPort {
  readonly #records = new Map<string, WorkClaimRecord>();
  readonly #now: () => Date;
  readonly #ttlMs: number;

  constructor(options: MemoryEnvironmentWorkClaimOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#ttlMs = options.ttlMs ?? 90_000;
  }

  /** A worker claims the Work (first claim or reclaim). `token` stands in
   * for the Work's sessions_token when a test serves a real Work secret. */
  claim(scope: RuntimeResourceScope, token?: string): EnvironmentWorkClaim {
    const key = scopeKey(scope);
    const record = this.#records.get(key);
    const generation = (record?.generation ?? 0) + 1;
    token ??= `work-token-${generation}`;
    this.#records.set(key, {
      generation,
      claimAt: this.#now().getTime(),
      token,
      state: "claimed",
      publication: record?.publication ?? null,
      nextRevision: record?.nextRevision ?? 1,
    });
    return { ...scope, generation, token };
  }

  /** Graceful stop: the Work moves to stopping and keeps its claim. */
  requestStop(scope: RuntimeResourceScope): void {
    const record = this.#records.get(scopeKey(scope));
    if (record !== undefined && record.state === "claimed") record.state = "stopping";
  }

  /** Force stop or an expired lease: no claim is current. */
  lose(scope: RuntimeResourceScope): void {
    const record = this.#records.get(scopeKey(scope));
    if (record !== undefined) record.state = "lost";
  }

  async open(claim: EnvironmentWorkClaim): Promise<OpenEnvironmentWorkClaimResult> {
    const record = this.#records.get(scopeKey(claim));
    if (!this.#holds(record, claim) || record!.state !== "claimed") return { type: "lost" };
    return {
      type: "current",
      expiresAt: new Date(record!.claimAt + this.#ttlMs).toISOString(),
      publication: record!.publication === null ? null : structuredClone(record!.publication),
    };
  }

  async isCurrent(claim: EnvironmentWorkClaim): Promise<boolean> {
    return this.#holds(this.#records.get(scopeKey(claim)), claim);
  }

  async publish(input: {
    claim: EnvironmentWorkClaim;
    workspaceCandidate: RuntimePublicationCandidate;
    outputCandidate: RuntimePublicationCandidate | null;
    runtimeCheckpoint?: RuntimeResourcePublication["runtimeCheckpoint"];
  }): Promise<PublishRuntimeResourcesResult> {
    const record = this.#records.get(scopeKey(input.claim));
    if (!this.#holds(record, input.claim)) return { type: "lost" };
    const previous = record!.publication;
    if (
      previous !== null &&
      previous.generation === input.claim.generation &&
      sameCandidate(previous.workspaceCandidate, input.workspaceCandidate) &&
      sameCandidate(previous.outputCandidate, input.outputCandidate) &&
      sameRuntimeCheckpoint(previous.runtimeCheckpoint, input.runtimeCheckpoint)
    ) {
      return { type: "published", revision: previous.revision };
    }
    const revision = record!.nextRevision;
    record!.nextRevision += 1;
    record!.publication = {
      generation: input.claim.generation,
      revision,
      workspaceCandidate: { ...input.workspaceCandidate },
      outputCandidate:
        input.outputCandidate === null ? null : { ...input.outputCandidate },
      ...(input.runtimeCheckpoint === undefined
        ? {}
        : { runtimeCheckpoint: input.runtimeCheckpoint }),
    };
    return { type: "published", revision };
  }

  inspect(scope: RuntimeResourceScope): Readonly<WorkClaimRecord> | null {
    const record = this.#records.get(scopeKey(scope));
    return record === undefined ? null : structuredClone(record);
  }

  #holds(record: WorkClaimRecord | undefined, claim: EnvironmentWorkClaim): boolean {
    return record !== undefined
      && record.claimAt + this.#ttlMs > this.#now().getTime()
      && record.state !== "lost"
      && record.generation === claim.generation
      && record.token === claim.token;
  }
}

function orphanErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MemoryRuntimeOrphanPort implements RuntimeOrphanPort {
  readonly #records = new Map<string, RuntimeOrphanRecord>();

  async enqueue(input: Parameters<RuntimeOrphanPort["enqueue"]>[0]): Promise<void> {
    const id = runtimeOrphanId(input);
    const existing = this.#records.get(id);
    this.#records.set(id, {
      id,
      scope: { ...input.scope },
      generation: input.generation,
      ownerId: input.ownerId,
      sandbox: {
        ...input.sandbox,
        ...(input.sandbox.metadata === undefined
          ? {}
          : { metadata: { ...input.sandbox.metadata } }),
      },
      reason: input.reason,
      attempts: existing?.attempts ?? 0,
      lastError: orphanErrorMessage(input.error),
    });
  }

  async list(input: { limit: number }): Promise<readonly RuntimeOrphanRecord[]> {
    return [...this.#records.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, input.limit)
      .map((record) => structuredClone(record));
  }

  async failed(input: { id: string; error: unknown }): Promise<void> {
    const record = this.#records.get(input.id);
    if (record === undefined) return;
    this.#records.set(input.id, {
      ...record,
      attempts: record.attempts + 1,
      lastError: orphanErrorMessage(input.error),
    });
  }

  async resolve(input: { id: string }): Promise<void> {
    this.#records.delete(input.id);
  }
}
