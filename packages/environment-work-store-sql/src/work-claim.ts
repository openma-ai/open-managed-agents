import type {
  EnvironmentWorkClaim,
  EnvironmentWorkClaimPort,
  OpenEnvironmentWorkClaimResult,
  PublishRuntimeResourcesResult,
  RuntimePublicationCandidate,
  RuntimeResourcePublication,
} from "@open-managed-agents/runtime-resource-contract";
import type { SqlClient } from "@open-managed-agents/sql-client";

/** Resolves the database that holds a workspace's managed_environment_work rows. */
export type EnvironmentWorkDatabase =
  | SqlClient
  | ((workspaceId: string) => SqlClient | Promise<SqlClient>);

export interface SqlEnvironmentWorkClaimOptions {
  now?: () => Date;
  /** Compare-and-set retries when concurrent publications race. */
  maxPublishAttempts?: number;
}

interface ClaimRow {
  claim_at: number | string;
  state: string;
  document: string;
  heartbeat_ttl_seconds: number | string;
  runtime_publication_json: string | null;
}

const OPEN_STATES = "('queued', 'starting', 'active')";
// A stop request keeps the claim (nothing may reclaim a stopping item), so the
// owner may still publish its final checkpoint while it drains.
const HELD_STATES = "('queued', 'starting', 'active', 'stopping')";

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function validCandidate(value: unknown, nullable: boolean): boolean {
  if (value === null) return nullable;
  if (typeof value !== "object" || value === undefined) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.contentHash === "string";
}

function validRuntimeCheckpoint(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object") return false;
  const checkpoint = value as Record<string, unknown>;
  return typeof checkpoint.provider === "string"
    && checkpoint.provider.length > 0
    && typeof checkpoint.checkpointId === "string"
    && checkpoint.checkpointId.length > 0
    && (checkpoint.kind === "filesystem" || checkpoint.kind === "process")
    && typeof checkpoint.sourceRuntimeId === "string"
    && checkpoint.sourceRuntimeId.length > 0
    && typeof checkpoint.sessionId === "string"
    && Number.isSafeInteger(checkpoint.workGeneration)
    && Number.isSafeInteger(checkpoint.workspaceRevision)
    && typeof checkpoint.harnessVersion === "string"
    && typeof checkpoint.runtimeIdentity === "string";
}

function parsePublication(value: string | null): RuntimeResourcePublication | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as RuntimeResourcePublication;
  if (
    typeof parsed !== "object"
    || parsed === null
    || !Number.isSafeInteger(parsed.generation)
    || !Number.isSafeInteger(parsed.revision)
    || parsed.revision < 1
    || !validCandidate(parsed.workspaceCandidate, false)
    || !validCandidate(parsed.outputCandidate, true)
    || !validRuntimeCheckpoint(parsed.runtimeCheckpoint)
  ) {
    throw new Error("Environment Work contains an invalid runtime publication");
  }
  return parsed;
}

function candidateFields(input: {
  workspaceCandidate: RuntimePublicationCandidate;
  outputCandidate: RuntimePublicationCandidate | null;
  runtimeCheckpoint?: RuntimeResourcePublication["runtimeCheckpoint"];
}) {
  return {
    workspaceCandidate: input.workspaceCandidate,
    outputCandidate: input.outputCandidate,
    ...(input.runtimeCheckpoint === undefined
      ? {}
      : { runtimeCheckpoint: input.runtimeCheckpoint }),
  };
}

/**
 * The protocol Environment Work claim as the Runtime Host's only authority
 * (ADR 0005). Every check is a predicate on the same managed_environment_work
 * row that poll, ack, heartbeat and stop mutate: claim_generation identifies
 * the claim (only a claim bumps it), and claim_at + heartbeat_ttl_seconds is
 * the lease the protocol's 412 enforces. A reclaim, a force stop or an expired
 * lease therefore ends execution authority with no second lease to drift.
 * Only final host publication may drain the same stopped generation; this
 * does not make isCurrent/open or sandbox authentication succeed.
 *
 * The Work token is not compared here: the host is a trusted process that
 * read the generation from its own claimed secret, and the generation alone
 * names one claim. Untrusted bearers are checked by isCurrentEnvironmentWorkClaim.
 *
 * The restore pointer lives in runtime_publication_json on the Work row and is
 * advanced by compare-and-set on that column, never on revision, so it does
 * not contend with the control plane's optimistic Work writes.
 */
export class SqlEnvironmentWorkClaimPort implements EnvironmentWorkClaimPort {
  readonly #database: EnvironmentWorkDatabase;
  readonly #now: () => Date;
  readonly #maxPublishAttempts: number;

  constructor(database: EnvironmentWorkDatabase, options: SqlEnvironmentWorkClaimOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#maxPublishAttempts = options.maxPublishAttempts ?? 5;
    if (!Number.isSafeInteger(this.#maxPublishAttempts) || this.#maxPublishAttempts < 1) {
      throw new Error("maxPublishAttempts must be a positive integer");
    }
  }

  async open(claim: EnvironmentWorkClaim): Promise<OpenEnvironmentWorkClaimResult> {
    const row = await this.#read(claim, OPEN_STATES);
    if (row === null) return { type: "lost" };
    return {
      type: "current",
      expiresAt: new Date(
        Number(row.claim_at) + Number(row.heartbeat_ttl_seconds) * 1_000,
      ).toISOString(),
      publication: parsePublication(row.runtime_publication_json),
    };
  }

  async isCurrent(claim: EnvironmentWorkClaim): Promise<boolean> {
    return (await this.#read(claim, HELD_STATES)) !== null;
  }

  async publish(input: {
    claim: EnvironmentWorkClaim;
    final?: boolean;
    workspaceCandidate: RuntimePublicationCandidate;
    outputCandidate: RuntimePublicationCandidate | null;
    runtimeCheckpoint?: RuntimeResourcePublication["runtimeCheckpoint"];
  }): Promise<PublishRuntimeResourcesResult> {
    const fields = candidateFields(input);
    const fieldsJson = stableJson(fields);
    const sql = await this.#client(input.claim.workspaceId);
    for (let attempt = 0; attempt < this.#maxPublishAttempts; attempt += 1) {
      const row = await this.#read(input.claim, HELD_STATES, input.final);
      if (row === null) return { type: "lost" };
      const previous = parsePublication(row.runtime_publication_json);
      if (
        previous !== null
        && previous.generation === input.claim.generation
        && stableJson(candidateFields(previous)) === fieldsJson
      ) {
        return { type: "published", revision: previous.revision };
      }
      const revision = (previous?.revision ?? 0) + 1;
      const next = stableJson({ ...fields, generation: input.claim.generation, revision });
      const [condition, parameters] = this.#claimCondition(input.claim, HELD_STATES, input.final);
      const result = await sql.prepare(
        `UPDATE managed_environment_work
            SET runtime_publication_json = ?
          WHERE ${condition}
            AND state = ? AND document = ? AND claim_at = ? AND heartbeat_ttl_seconds = ?
            AND ${row.runtime_publication_json === null
              ? "runtime_publication_json IS NULL"
              : "runtime_publication_json = ?"}`,
      ).bind(
        next,
        ...parameters,
        row.state, row.document, row.claim_at, row.heartbeat_ttl_seconds,
        ...(row.runtime_publication_json === null ? [] : [row.runtime_publication_json]),
      ).run();
      if (result.meta.changes === 1) return { type: "published", revision };
      if (result.meta.changes > 1) {
        throw new Error(`Environment Work publication affected ${result.meta.changes} rows`);
      }
    }
    throw new Error(
      `Environment Work publication lost ${this.#maxPublishAttempts} compare-and-set races`,
    );
  }

  async #client(workspaceId: string): Promise<SqlClient> {
    return typeof this.#database === "function"
      ? this.#database(workspaceId)
      : this.#database;
  }

  #claimCondition(
    claim: EnvironmentWorkClaim,
    states: string,
    final = false,
  ): [string, Array<string | number>] {
    return [
      `workspace_id = ? AND environment_id = ? AND id = ? AND session_id = ?
         AND claim_generation = ?
         AND ((claim_at IS NOT NULL
           AND claim_at + heartbeat_ttl_seconds * 1000 > ?
           AND state IN ${states})${final ? " OR state = 'stopped'" : ""})`,
      [
        claim.workspaceId,
        claim.environmentId,
        claim.workId,
        claim.sessionId,
        claim.generation,
        this.#now().getTime(),
      ],
    ];
  }

  async #read(claim: EnvironmentWorkClaim, states: string, final = false): Promise<ClaimRow | null> {
    if (!Number.isSafeInteger(claim.generation) || claim.generation < 1) return null;
    const sql = await this.#client(claim.workspaceId);
    const [condition, parameters] = this.#claimCondition(claim, states, final);
    const row = await sql.prepare(
      `SELECT claim_at, heartbeat_ttl_seconds, runtime_publication_json, state, document
         FROM managed_environment_work
        WHERE ${condition}`,
    ).bind(...parameters).first<ClaimRow>();
    if (row !== null && row.state === "stopped") {
      // stoppedAt already lives in the Work document on every SQL dialect.
      // Pin that document and the lease columns in the publication CAS above.
      const stoppedAt = (JSON.parse(row.document) as { stoppedAt?: string | null }).stoppedAt;
      if (row.claim_at === null || stoppedAt == null
        || !(Date.parse(stoppedAt) <= Number(row.claim_at) + Number(row.heartbeat_ttl_seconds) * 1_000)) {
        return null;
      }
    }
    return row;
  }
}
