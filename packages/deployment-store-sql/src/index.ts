import type { SqlClient } from "@open-managed-agents/sql-client";
import type { Deployment, DeploymentResourceSecret } from "@open-managed-agents/domain/deployments";
import type {
  DeploymentLocation,
  DeploymentStore,
  InsertDeploymentRecord,
  ListDeploymentRecords,
  ReplaceDeploymentRecord,
  ReplaceDeploymentRecordResult,
  StoredDeployment,
} from "@open-managed-agents/deployment-store";

export interface DeploymentResourceSecretCipher {
  seal(input: { plaintext: string }): Promise<{ ciphertext: string }>;
  open(input: { ciphertext: string }): Promise<{ plaintext: string }>;
}

interface DeploymentRow {
  id: string;
  document: string;
  sealed_resource_secrets: string;
  revision: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface SealedDeploymentResourceSecret {
  kind: "github_repository_token";
  resourceIndex: number;
  ciphertext: string;
}

function timestamp(value: string): number {
  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) {
    throw new Error(`Invalid Deployment timestamp: ${value}`);
  }
  return milliseconds;
}

function parseSealedSecrets(value: string): SealedDeploymentResourceSecret[] {
  const parsed = JSON.parse(value) as SealedDeploymentResourceSecret[];
  if (!Array.isArray(parsed)) {
    throw new Error("Stored Deployment resource secrets are invalid");
  }
  return parsed;
}

export class SqlDeploymentStore implements DeploymentStore {
  constructor(
    private readonly client: SqlClient,
    private readonly cipher: DeploymentResourceSecretCipher,
  ) {}

  private async sealSecrets(
    secrets: DeploymentResourceSecret[],
  ): Promise<SealedDeploymentResourceSecret[]> {
    return Promise.all(
      secrets.map(async (secret) => ({
        kind: secret.kind,
        resourceIndex: secret.resourceIndex,
        ciphertext: (await this.cipher.seal({
          plaintext: secret.authorizationToken,
        })).ciphertext,
      })),
    );
  }

  private async toStored(row: DeploymentRow): Promise<StoredDeployment> {
    const stored = JSON.parse(row.document) as Deployment;
    const sealed = parseSealedSecrets(row.sealed_resource_secrets);
    const resourceSecrets = await Promise.all(
      sealed.map(async (secret) => ({
        kind: secret.kind,
        resourceIndex: secret.resourceIndex,
        authorizationToken: (await this.cipher.open({
          ciphertext: secret.ciphertext,
        })).plaintext,
      })),
    );
    return {
      revision: Number(row.revision),
      deployment: {
        ...stored,
        id: row.id,
        createdAt: new Date(Number(row.created_at)).toISOString(),
        updatedAt: new Date(Number(row.updated_at)).toISOString(),
        archivedAt: row.archived_at === null
          ? null
          : new Date(Number(row.archived_at)).toISOString(),
      },
      resourceSecrets,
    };
  }

  async insert(input: InsertDeploymentRecord): Promise<StoredDeployment> {
    const deployment = input.record.deployment;
    const sealed = await this.sealSecrets(input.record.resourceSecrets);
    const result = await this.client.prepare(
      `INSERT INTO managed_deployments
        (workspace_id, id, document, sealed_resource_secrets, revision,
         agent_id, status, created_at, updated_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      input.workspaceId,
      deployment.id,
      JSON.stringify(deployment),
      JSON.stringify(sealed),
      1,
      deployment.agent.id,
      deployment.status,
      timestamp(deployment.createdAt),
      timestamp(deployment.updatedAt),
      deployment.archivedAt === null ? null : timestamp(deployment.archivedAt),
    ).run();
    if (result.meta.changes !== 1) {
      throw new Error(`Deployment insertion affected ${result.meta.changes} rows`);
    }
    const inserted = await this.find({
      workspaceId: input.workspaceId,
      deploymentId: deployment.id,
    });
    if (inserted === null) throw new Error("Deployment vanished after insert");
    return inserted;
  }

  async find(input: DeploymentLocation): Promise<StoredDeployment | null> {
    const row = await this.client.prepare(
      `SELECT id, document, sealed_resource_secrets, revision,
              created_at, updated_at, archived_at
         FROM managed_deployments
        WHERE workspace_id = ? AND id = ?`,
    ).bind(input.workspaceId, input.deploymentId).first<DeploymentRow>();
    return row === null ? null : this.toStored(row);
  }

  async replace(
    input: ReplaceDeploymentRecord,
  ): Promise<ReplaceDeploymentRecordResult> {
    if (input.next.deployment.id !== input.deploymentId) {
      throw new Error("Replacement Deployment ID does not match its target");
    }
    const deployment = input.next.deployment;
    const sealed = await this.sealSecrets(input.next.resourceSecrets);
    const result = await this.client.prepare(
      `UPDATE managed_deployments
          SET document = ?, sealed_resource_secrets = ?,
              revision = revision + 1, agent_id = ?, status = ?,
              updated_at = ?, archived_at = ?
        WHERE workspace_id = ? AND id = ? AND revision = ?`,
    ).bind(
      JSON.stringify(deployment),
      JSON.stringify(sealed),
      deployment.agent.id,
      deployment.status,
      timestamp(deployment.updatedAt),
      deployment.archivedAt === null ? null : timestamp(deployment.archivedAt),
      input.workspaceId,
      input.deploymentId,
      input.expectedRevision,
    ).run();
    if (result.meta.changes === 0) {
      const current = await this.find({
        workspaceId: input.workspaceId,
        deploymentId: input.deploymentId,
      });
      return current === null
        ? { type: "not_found" }
        : { type: "revision_conflict", actualRevision: current.revision };
    }
    if (result.meta.changes !== 1) {
      throw new Error(`Deployment replacement affected ${result.meta.changes} rows`);
    }
    const record = await this.find({
      workspaceId: input.workspaceId,
      deploymentId: input.deploymentId,
    });
    if (record === null) throw new Error("Deployment vanished after replacement");
    return { type: "replaced", record };
  }

  async list(input: ListDeploymentRecords): Promise<StoredDeployment[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error("Deployment list limit must be a positive integer");
    }
    const conditions = ["workspace_id = ?"];
    const parameters: Array<string | number> = [input.workspaceId];
    if (!input.includeArchived) conditions.push("archived_at IS NULL");
    if (input.agentId !== undefined) {
      conditions.push("agent_id = ?");
      parameters.push(input.agentId);
    }
    if (input.createdAtOrAfter !== undefined) {
      conditions.push("created_at >= ?");
      parameters.push(timestamp(input.createdAtOrAfter));
    }
    if (input.createdAtOrBefore !== undefined) {
      conditions.push("created_at <= ?");
      parameters.push(timestamp(input.createdAtOrBefore));
    }
    if (input.status !== undefined) {
      conditions.push("status = ?");
      parameters.push(input.status);
    }
    if (input.position !== undefined) {
      const createdAt = timestamp(input.position.createdAt);
      conditions.push("(created_at < ? OR (created_at = ? AND id < ?))");
      parameters.push(createdAt, createdAt, input.position.deploymentId);
    }
    parameters.push(input.limit);
    const rows = await this.client.prepare(
      `SELECT id, document, sealed_resource_secrets, revision,
              created_at, updated_at, archived_at
         FROM managed_deployments
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...parameters).all<DeploymentRow>();
    return Promise.all((rows.results ?? []).map((row) => this.toStored(row)));
  }
}
