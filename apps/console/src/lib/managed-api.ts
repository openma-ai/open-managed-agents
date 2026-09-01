import type {
  AgentCreateParams,
  AgentListParams,
  AgentRetrieveParams,
  AgentUpdateParams,
  BetaManagedAgentsAgent,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type { VersionListParams as AgentVersionListParams } from "@anthropic-ai/sdk/resources/beta/agents/versions";
import type {
  BetaManagedAgentsDeployment,
  DeploymentArchiveParams,
  DeploymentCreateParams,
  DeploymentListParams,
  DeploymentPauseParams,
  DeploymentRetrieveParams,
  DeploymentRunParams,
  DeploymentUnpauseParams,
  DeploymentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/deployments";
import type {
  BetaManagedAgentsDeploymentRun,
  DeploymentRunListParams,
  DeploymentRunRetrieveParams,
} from "@anthropic-ai/sdk/resources/beta/deployment-runs";
import type {
  BetaDream,
  DreamArchiveParams,
  DreamCancelParams,
  DreamCreateParams,
  DreamListParams,
  DreamRetrieveParams,
} from "@anthropic-ai/sdk/resources/beta/dreams";
import type {
  BetaEnvironment,
  BetaEnvironmentDeleteResponse,
  EnvironmentCreateParams,
  EnvironmentListParams,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import type {
  BetaSelfHostedWork,
  BetaSelfHostedWorkHeartbeatResponse,
  BetaSelfHostedWorkQueueStats,
  WorkAckParams,
  WorkHeartbeatParams,
  WorkListParams,
  WorkPollParams,
  WorkRetrieveParams,
  WorkStatsParams,
  WorkStopParams,
  WorkUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/work";
import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsCredentialValidation,
  BetaManagedAgentsDeletedCredential,
  CredentialCreateParams,
  CredentialListParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type {
  BetaManagedAgentsDeletedVault,
  BetaManagedAgentsVault,
  VaultCreateParams,
  VaultListParams,
  VaultUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import type {
  BetaManagedAgentsDeletedMemoryStore,
  BetaManagedAgentsMemoryStore,
  MemoryStoreCreateParams,
  MemoryStoreListParams,
  MemoryStoreUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores";
import type {
  BetaManagedAgentsDeletedMemory,
  BetaManagedAgentsMemory,
  BetaManagedAgentsMemoryListItem,
  MemoryCreateParams,
  MemoryListParams,
  MemoryRetrieveParams,
  MemoryUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memories";
import type {
  BetaManagedAgentsMemoryVersion,
  MemoryVersionListParams,
  MemoryVersionRetrieveParams,
} from "@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions";
import type {
  BetaManagedAgentsDeletedSession,
  BetaManagedAgentsSession,
  SessionCreateParams,
  SessionListParams,
  SessionUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/sessions";
import type {
  BetaManagedAgentsSendSessionEvents,
  BetaManagedAgentsSessionEvent,
  EventListParams,
  EventSendParams,
  EventStreamParams,
  BetaManagedAgentsStreamSessionEvents,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import type {
  BetaManagedAgentsDeleteSessionResource,
  BetaManagedAgentsFileResource,
  BetaManagedAgentsSessionResource,
  ResourceAddParams,
  ResourceListParams,
  ResourceRetrieveResponse,
  ResourceUpdateParams,
  ResourceUpdateResponse,
} from "@anthropic-ai/sdk/resources/beta/sessions/resources";
import type {
  BetaManagedAgentsSessionThread,
  BetaManagedAgentsStreamSessionThreadEvents,
  ThreadListParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/threads/threads";
import type {
  EventListParams as ThreadEventListParams,
  EventStreamParams as ThreadEventStreamParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/threads/events";
import type {
  BetaDeletedFile,
  BetaFileMetadata,
  FileDownloadParams,
  FileListParams,
  FileUploadParams,
} from "@anthropic-ai/sdk/resources/beta/files";
import type {
  SkillCreateParams,
  SkillCreateResponse,
  SkillDeleteResponse,
  SkillListParams,
  SkillListResponse,
  SkillRetrieveResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/skills";
import type {
  VersionCreateParams,
  VersionCreateResponse,
  VersionDeleteResponse,
  VersionDownloadParams,
  VersionListParams,
  VersionListResponse,
  VersionRetrieveResponse,
} from "@anthropic-ai/sdk/resources/beta/skills/versions";
import type {
  BetaModelInfo,
  ModelListParams,
} from "@anthropic-ai/sdk/resources/beta/models";
import type {
  BetaTunnel,
  BetaTunnelToken,
  TunnelArchiveParams,
  TunnelCreateParams,
  TunnelListParams,
  TunnelRetrieveParams,
  TunnelRevealTokenParams,
  TunnelRotateTokenParams,
} from "@anthropic-ai/sdk/resources/beta/tunnels/tunnels";
import type {
  BetaTunnelCertificate,
  CertificateArchiveParams,
  CertificateCreateParams,
  CertificateListParams,
  CertificateRetrieveParams,
} from "@anthropic-ai/sdk/resources/beta/tunnels/certificates";
import type {
  BetaUserProfile,
  BetaUserProfileEnrollmentURL,
  UserProfileCreateEnrollmentURLParams,
  UserProfileCreateParams,
  UserProfileListParams,
  UserProfileRetrieveParams,
  UserProfileUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/user-profiles";

export type ManagedPage<T> = {
  data: T[];
  next_page: string | null;
};

export type ManagedBidirectionalPage<T> = ManagedPage<T> & {
  prev_page: string | null;
};

export type FilesPage<T> = {
  data: T[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
};

export type ManagedApiRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<T>;

export type ManagedApiRawRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export type ManagedApiStreamRequest = <T>(
  path: string,
  init?: RequestInit,
) => Promise<AsyncIterable<T>>;

export interface ManagedApiTransport {
  request: ManagedApiRequest;
  raw: ManagedApiRawRequest;
  stream: ManagedApiStreamRequest;
}

type WithoutBetas<T> = Omit<T, "betas">;
type QueryValue = string | number | boolean | readonly string[] | null | undefined;

function appendQueryValue(
  search: URLSearchParams,
  key: string,
  value: QueryValue,
): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) search.append(`${key}[]`, item);
    return;
  }
  search.set(key, String(value));
}

export function buildManagedApiUrl(
  path: string,
  params?: Record<string, QueryValue>,
): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    appendQueryValue(search, key, value);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function id(value: string): string {
  return encodeURIComponent(value);
}

function json(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

function multipart(
  files: readonly unknown[],
  fields: Record<string, string | null | undefined> = {},
): RequestInit {
  const form = new FormData();
  for (const file of files) {
    if (!(file instanceof Blob)) {
      throw new TypeError("Browser Managed API uploads require File or Blob values");
    }
    form.append("files[]", file);
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.append(key, value);
  }
  return { method: "POST", body: form };
}

function singleFile(file: unknown): RequestInit {
  if (!(file instanceof Blob)) {
    throw new TypeError("Browser Managed API uploads require a File or Blob value");
  }
  const form = new FormData();
  form.append("file", file);
  return { method: "POST", body: form };
}

function missingTransport(kind: "raw" | "stream"): never {
  throw new Error(
    `Managed API ${kind} transport is not configured; pass a ManagedApiTransport to createManagedApiClient`,
  );
}

/** Browser-facing Managed Agents resource client. It deliberately accepts the
 * same request DTOs exported by `@anthropic-ai/sdk` (minus its `betas` header
 * convenience field) while reusing the Console's cookie/tenant-aware request
 * transport. Product-only `/v1/oma/*` routes do not exist on this client. */
export function createManagedApiClient(
  input: ManagedApiRequest | ManagedApiTransport,
) {
  const request = typeof input === "function" ? input : input.request;
  const raw =
    typeof input === "function"
      ? (_path: string, _init?: RequestInit) => missingTransport("raw")
      : input.raw;
  const stream =
    typeof input === "function"
      ? <T>(_path: string, _init?: RequestInit) =>
          missingTransport("stream") as Promise<AsyncIterable<T>>
      : input.stream;

  return {
    agents: {
      list: (params: WithoutBetas<AgentListParams> = {}) =>
        request<ManagedPage<BetaManagedAgentsAgent>>(
          buildManagedApiUrl("/v1/agents", params as Record<string, QueryValue>),
        ),
      retrieve: (
        agentId: string,
        params: WithoutBetas<AgentRetrieveParams> = {},
      ) =>
        request<BetaManagedAgentsAgent>(
          buildManagedApiUrl(
            `/v1/agents/${id(agentId)}`,
            params as Record<string, QueryValue>,
          ),
        ),
      create: (params: WithoutBetas<AgentCreateParams>) =>
        request<BetaManagedAgentsAgent>("/v1/agents", json(params)),
      update: (agentId: string, params: WithoutBetas<AgentUpdateParams>) =>
        request<BetaManagedAgentsAgent>(
          `/v1/agents/${id(agentId)}`,
          json(params),
        ),
      archive: (agentId: string) =>
        request<BetaManagedAgentsAgent>(
          `/v1/agents/${id(agentId)}/archive`,
          json({}),
        ),
      versions: {
        list: (
          agentId: string,
          params: WithoutBetas<AgentVersionListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsAgent>>(
            buildManagedApiUrl(
              `/v1/agents/${id(agentId)}/versions`,
              params as Record<string, QueryValue>,
            ),
          ),
      },
    },
    deployments: {
      create: (params: WithoutBetas<DeploymentCreateParams>) =>
        request<BetaManagedAgentsDeployment>("/v1/deployments", json(params)),
      retrieve: (
        deploymentId: string,
        _params: WithoutBetas<DeploymentRetrieveParams> = {},
      ) =>
        request<BetaManagedAgentsDeployment>(
          `/v1/deployments/${id(deploymentId)}`,
        ),
      update: (
        deploymentId: string,
        params: WithoutBetas<DeploymentUpdateParams>,
      ) =>
        request<BetaManagedAgentsDeployment>(
          `/v1/deployments/${id(deploymentId)}`,
          json(params),
        ),
      list: (params: WithoutBetas<DeploymentListParams> = {}) =>
        request<ManagedPage<BetaManagedAgentsDeployment>>(
          buildManagedApiUrl(
            "/v1/deployments",
            params as Record<string, QueryValue>,
          ),
        ),
      archive: (
        deploymentId: string,
        _params: WithoutBetas<DeploymentArchiveParams> = {},
      ) =>
        request<BetaManagedAgentsDeployment>(
          `/v1/deployments/${id(deploymentId)}/archive`,
          json({}),
        ),
      pause: (
        deploymentId: string,
        _params: WithoutBetas<DeploymentPauseParams> = {},
      ) =>
        request<BetaManagedAgentsDeployment>(
          `/v1/deployments/${id(deploymentId)}/pause`,
          json({}),
        ),
      run: (
        deploymentId: string,
        _params: WithoutBetas<DeploymentRunParams> = {},
      ) =>
        request<BetaManagedAgentsDeploymentRun>(
          `/v1/deployments/${id(deploymentId)}/run`,
          json({}),
        ),
      unpause: (
        deploymentId: string,
        _params: WithoutBetas<DeploymentUnpauseParams> = {},
      ) =>
        request<BetaManagedAgentsDeployment>(
          `/v1/deployments/${id(deploymentId)}/unpause`,
          json({}),
        ),
    },
    deploymentRuns: {
      retrieve: (
        deploymentRunId: string,
        _params: WithoutBetas<DeploymentRunRetrieveParams> = {},
      ) =>
        request<BetaManagedAgentsDeploymentRun>(
          `/v1/deployment_runs/${id(deploymentRunId)}`,
        ),
      list: (params: WithoutBetas<DeploymentRunListParams> = {}) =>
        request<ManagedPage<BetaManagedAgentsDeploymentRun>>(
          buildManagedApiUrl(
            "/v1/deployment_runs",
            params as Record<string, QueryValue>,
          ),
        ),
    },
    dreams: {
      create: (params: WithoutBetas<DreamCreateParams>) =>
        request<BetaDream>("/v1/dreams", json(params)),
      retrieve: (
        dreamId: string,
        _params: WithoutBetas<DreamRetrieveParams> = {},
      ) => request<BetaDream>(`/v1/dreams/${id(dreamId)}`),
      list: (params: WithoutBetas<DreamListParams> = {}) =>
        request<ManagedPage<BetaDream>>(
          buildManagedApiUrl(
            "/v1/dreams",
            params as Record<string, QueryValue>,
          ),
        ),
      archive: (
        dreamId: string,
        _params: WithoutBetas<DreamArchiveParams> = {},
      ) =>
        request<BetaDream>(`/v1/dreams/${id(dreamId)}/archive`, json({})),
      cancel: (
        dreamId: string,
        _params: WithoutBetas<DreamCancelParams> = {},
      ) => request<BetaDream>(`/v1/dreams/${id(dreamId)}/cancel`, json({})),
    },
    environments: {
      list: (params: WithoutBetas<EnvironmentListParams> = {}) =>
        request<ManagedPage<BetaEnvironment>>(
          buildManagedApiUrl(
            "/v1/environments",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (environmentId: string) =>
        request<BetaEnvironment>(`/v1/environments/${id(environmentId)}`),
      create: (params: WithoutBetas<EnvironmentCreateParams>) =>
        request<BetaEnvironment>("/v1/environments", json(params)),
      update: (
        environmentId: string,
        params: WithoutBetas<EnvironmentUpdateParams>,
      ) =>
        request<BetaEnvironment>(
          `/v1/environments/${id(environmentId)}`,
          json(params),
        ),
      delete: (environmentId: string) =>
        request<BetaEnvironmentDeleteResponse>(
          `/v1/environments/${id(environmentId)}`,
          { method: "DELETE" },
        ),
      archive: (environmentId: string) =>
        request<BetaEnvironment>(
          `/v1/environments/${id(environmentId)}/archive`,
          json({}),
        ),
      work: {
        retrieve: (
          workId: string,
          params: WithoutBetas<WorkRetrieveParams>,
        ) =>
          request<BetaSelfHostedWork>(
            `/v1/environments/${id(params.environment_id)}/work/${id(workId)}`,
          ),
        update: (workId: string, params: WithoutBetas<WorkUpdateParams>) => {
          const { environment_id: environmentId, ...body } = params;
          return request<BetaSelfHostedWork>(
            `/v1/environments/${id(environmentId)}/work/${id(workId)}`,
            json(body),
          );
        },
        list: (
          environmentId: string,
          params: WithoutBetas<WorkListParams> = {},
        ) =>
          request<ManagedPage<BetaSelfHostedWork>>(
            buildManagedApiUrl(
              `/v1/environments/${id(environmentId)}/work`,
              params as Record<string, QueryValue>,
            ),
          ),
        ack: (workId: string, params: WithoutBetas<WorkAckParams>) =>
          request<BetaSelfHostedWork>(
            `/v1/environments/${id(params.environment_id)}/work/${id(workId)}/ack`,
            json({}),
          ),
        heartbeat: (
          workId: string,
          params: WithoutBetas<WorkHeartbeatParams>,
        ) => {
          const {
            environment_id: environmentId,
            desired_ttl_seconds,
            expected_last_heartbeat,
          } = params;
          return request<BetaSelfHostedWorkHeartbeatResponse>(
            buildManagedApiUrl(
              `/v1/environments/${id(environmentId)}/work/${id(workId)}/heartbeat`,
              { desired_ttl_seconds, expected_last_heartbeat },
            ),
            json({}),
          );
        },
        poll: (
          environmentId: string,
          params: WithoutBetas<WorkPollParams> = {},
        ) => {
          const {
            "Anthropic-Worker-ID": workerId,
            ...query
          } = params;
          return request<BetaSelfHostedWork | null>(
            buildManagedApiUrl(
              `/v1/environments/${id(environmentId)}/work/poll`,
              query as Record<string, QueryValue>,
            ),
            workerId
              ? { headers: { "Anthropic-Worker-ID": workerId } }
              : undefined,
          );
        },
        stats: (
          environmentId: string,
          _params: WithoutBetas<WorkStatsParams> = {},
        ) =>
          request<BetaSelfHostedWorkQueueStats>(
            `/v1/environments/${id(environmentId)}/work/stats`,
          ),
        stop: (workId: string, params: WithoutBetas<WorkStopParams>) => {
          const { environment_id: environmentId, ...body } = params;
          return request<BetaSelfHostedWork>(
            `/v1/environments/${id(environmentId)}/work/${id(workId)}/stop`,
            json(body),
          );
        },
      },
    },
    vaults: {
      list: (params: WithoutBetas<VaultListParams> = {}) =>
        request<ManagedPage<BetaManagedAgentsVault>>(
          buildManagedApiUrl(
            "/v1/vaults",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (vaultId: string) =>
        request<BetaManagedAgentsVault>(`/v1/vaults/${id(vaultId)}`),
      create: (params: WithoutBetas<VaultCreateParams>) =>
        request<BetaManagedAgentsVault>("/v1/vaults", json(params)),
      update: (vaultId: string, params: WithoutBetas<VaultUpdateParams>) =>
        request<BetaManagedAgentsVault>(`/v1/vaults/${id(vaultId)}`, json(params)),
      delete: (vaultId: string) =>
        request<BetaManagedAgentsDeletedVault>(`/v1/vaults/${id(vaultId)}`, {
          method: "DELETE",
        }),
      archive: (vaultId: string) =>
        request<BetaManagedAgentsVault>(
          `/v1/vaults/${id(vaultId)}/archive`,
          json({}),
        ),
      credentials: {
        list: (
          vaultId: string,
          params: WithoutBetas<CredentialListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsCredential>>(
            buildManagedApiUrl(
              `/v1/vaults/${id(vaultId)}/credentials`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (credentialId: string, params: { vault_id: string }) =>
          request<BetaManagedAgentsCredential>(
            `/v1/vaults/${id(params.vault_id)}/credentials/${id(credentialId)}`,
          ),
        create: (
          vaultId: string,
          params: WithoutBetas<CredentialCreateParams>,
        ) =>
          request<BetaManagedAgentsCredential>(
            `/v1/vaults/${id(vaultId)}/credentials`,
            json(params),
          ),
        update: (
          credentialId: string,
          params: WithoutBetas<CredentialUpdateParams>,
        ) => {
          const { vault_id: vaultId, ...body } = params;
          return request<BetaManagedAgentsCredential>(
            `/v1/vaults/${id(vaultId)}/credentials/${id(credentialId)}`,
            json(body),
          );
        },
        delete: (credentialId: string, params: { vault_id: string }) =>
          request<BetaManagedAgentsDeletedCredential>(
            `/v1/vaults/${id(params.vault_id)}/credentials/${id(credentialId)}`,
            { method: "DELETE" },
          ),
        archive: (credentialId: string, params: { vault_id: string }) =>
          request<BetaManagedAgentsCredential>(
            `/v1/vaults/${id(params.vault_id)}/credentials/${id(credentialId)}/archive`,
            json({}),
          ),
        mcpOAuthValidate: (
          credentialId: string,
          params: { vault_id: string },
        ) =>
          request<BetaManagedAgentsCredentialValidation>(
            `/v1/vaults/${id(params.vault_id)}/credentials/${id(credentialId)}/mcp_oauth_validate`,
            json({}),
          ),
      },
    },
    memoryStores: {
      list: (params: WithoutBetas<MemoryStoreListParams> = {}) =>
        request<ManagedPage<BetaManagedAgentsMemoryStore>>(
          buildManagedApiUrl(
            "/v1/memory_stores",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (memoryStoreId: string) =>
        request<BetaManagedAgentsMemoryStore>(
          `/v1/memory_stores/${id(memoryStoreId)}`,
        ),
      create: (params: WithoutBetas<MemoryStoreCreateParams>) =>
        request<BetaManagedAgentsMemoryStore>("/v1/memory_stores", json(params)),
      update: (
        memoryStoreId: string,
        params: WithoutBetas<MemoryStoreUpdateParams>,
      ) =>
        request<BetaManagedAgentsMemoryStore>(
          `/v1/memory_stores/${id(memoryStoreId)}`,
          json(params),
        ),
      delete: (memoryStoreId: string) =>
        request<BetaManagedAgentsDeletedMemoryStore>(
          `/v1/memory_stores/${id(memoryStoreId)}`,
          { method: "DELETE" },
        ),
      archive: (memoryStoreId: string) =>
        request<BetaManagedAgentsMemoryStore>(
          `/v1/memory_stores/${id(memoryStoreId)}/archive`,
          json({}),
        ),
      memories: {
        list: (
          memoryStoreId: string,
          params: WithoutBetas<MemoryListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsMemoryListItem>>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memories`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (
          memoryId: string,
          params: WithoutBetas<MemoryRetrieveParams>,
        ) => {
          const { memory_store_id: memoryStoreId, ...query } = params;
          return request<BetaManagedAgentsMemory>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memories/${id(memoryId)}`,
              query as Record<string, QueryValue>,
            ),
          );
        },
        create: (
          memoryStoreId: string,
          params: WithoutBetas<MemoryCreateParams>,
        ) => {
          const { view, ...body } = params;
          return request<BetaManagedAgentsMemory>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memories`,
              { view },
            ),
            json(body),
          );
        },
        update: (
          memoryId: string,
          params: WithoutBetas<MemoryUpdateParams>,
        ) => {
          const { memory_store_id: memoryStoreId, view, ...body } = params;
          return request<BetaManagedAgentsMemory>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memories/${id(memoryId)}`,
              { view },
            ),
            json(body),
          );
        },
        delete: (
          memoryId: string,
          params: { memory_store_id: string; expected_content_sha256?: string },
        ) =>
          request<BetaManagedAgentsDeletedMemory>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(params.memory_store_id)}/memories/${id(memoryId)}`,
              { expected_content_sha256: params.expected_content_sha256 },
            ),
            { method: "DELETE" },
          ),
      },
      memoryVersions: {
        list: (
          memoryStoreId: string,
          params: WithoutBetas<MemoryVersionListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsMemoryVersion>>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memory_versions`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (
          memoryVersionId: string,
          params: WithoutBetas<MemoryVersionRetrieveParams>,
        ) => {
          const { memory_store_id: memoryStoreId, ...query } = params;
          return request<BetaManagedAgentsMemoryVersion>(
            buildManagedApiUrl(
              `/v1/memory_stores/${id(memoryStoreId)}/memory_versions/${id(memoryVersionId)}`,
              query as Record<string, QueryValue>,
            ),
          );
        },
        redact: (memoryVersionId: string, params: { memory_store_id: string }) =>
          request<BetaManagedAgentsMemoryVersion>(
            `/v1/memory_stores/${id(params.memory_store_id)}/memory_versions/${id(memoryVersionId)}/redact`,
            json({}),
          ),
      },
    },
    sessions: {
      list: (params: WithoutBetas<SessionListParams> = {}) =>
        request<ManagedBidirectionalPage<BetaManagedAgentsSession>>(
          buildManagedApiUrl(
            "/v1/sessions",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (sessionId: string) =>
        request<BetaManagedAgentsSession>(`/v1/sessions/${id(sessionId)}`),
      create: (params: WithoutBetas<SessionCreateParams>) =>
        request<BetaManagedAgentsSession>("/v1/sessions", json(params)),
      update: (sessionId: string, params: WithoutBetas<SessionUpdateParams>) =>
        request<BetaManagedAgentsSession>(
          `/v1/sessions/${id(sessionId)}`,
          json(params),
        ),
      archive: (sessionId: string) =>
        request<BetaManagedAgentsSession>(
          `/v1/sessions/${id(sessionId)}/archive`,
          json({}),
        ),
      delete: (sessionId: string) =>
        request<BetaManagedAgentsDeletedSession>(`/v1/sessions/${id(sessionId)}`, {
          method: "DELETE",
        }),
      events: {
        list: (
          sessionId: string,
          params: WithoutBetas<EventListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsSessionEvent>>(
            buildManagedApiUrl(
              `/v1/sessions/${id(sessionId)}/events`,
              params as Record<string, QueryValue>,
            ),
          ),
        send: (sessionId: string, params: WithoutBetas<EventSendParams>) =>
          request<BetaManagedAgentsSendSessionEvents>(
            `/v1/sessions/${id(sessionId)}/events`,
            json(params),
          ),
        stream: (
          sessionId: string,
          params: WithoutBetas<EventStreamParams> = {},
          options?: RequestInit,
        ) =>
          stream<BetaManagedAgentsStreamSessionEvents>(
            buildManagedApiUrl(
              `/v1/sessions/${id(sessionId)}/events/stream`,
              params as Record<string, QueryValue>,
            ),
            options,
          ),
      },
      resources: {
        list: (
          sessionId: string,
          params: WithoutBetas<ResourceListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsSessionResource>>(
            buildManagedApiUrl(
              `/v1/sessions/${id(sessionId)}/resources`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (resourceId: string, params: { session_id: string }) =>
          request<ResourceRetrieveResponse>(
            `/v1/sessions/${id(params.session_id)}/resources/${id(resourceId)}`,
          ),
        add: (sessionId: string, params: WithoutBetas<ResourceAddParams>) =>
          request<BetaManagedAgentsFileResource>(
            `/v1/sessions/${id(sessionId)}/resources`,
            json(params),
          ),
        update: (
          resourceId: string,
          params: WithoutBetas<ResourceUpdateParams>,
        ) => {
          const { session_id: sessionId, ...body } = params;
          return request<ResourceUpdateResponse>(
            `/v1/sessions/${id(sessionId)}/resources/${id(resourceId)}`,
            json(body),
          );
        },
        delete: (resourceId: string, params: { session_id: string }) =>
          request<BetaManagedAgentsDeleteSessionResource>(
            `/v1/sessions/${id(params.session_id)}/resources/${id(resourceId)}`,
            { method: "DELETE" },
          ),
      },
      threads: {
        list: (
          sessionId: string,
          params: WithoutBetas<ThreadListParams> = {},
        ) =>
          request<ManagedPage<BetaManagedAgentsSessionThread>>(
            buildManagedApiUrl(
              `/v1/sessions/${id(sessionId)}/threads`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (threadId: string, params: { session_id: string }) =>
          request<BetaManagedAgentsSessionThread>(
            `/v1/sessions/${id(params.session_id)}/threads/${id(threadId)}`,
          ),
        archive: (threadId: string, params: { session_id: string }) =>
          request<BetaManagedAgentsSessionThread>(
            `/v1/sessions/${id(params.session_id)}/threads/${id(threadId)}/archive`,
            json({}),
          ),
        events: {
          list: (
            threadId: string,
            params: WithoutBetas<ThreadEventListParams>,
          ) => {
            const { session_id: sessionId, ...query } = params;
            return request<ManagedPage<BetaManagedAgentsSessionEvent>>(
              buildManagedApiUrl(
                `/v1/sessions/${id(sessionId)}/threads/${id(threadId)}/events`,
                query as Record<string, QueryValue>,
              ),
            );
          },
          stream: (
            threadId: string,
            params: WithoutBetas<ThreadEventStreamParams>,
            options?: RequestInit,
          ) => {
            const { session_id: sessionId, ...query } = params;
            return stream<BetaManagedAgentsStreamSessionThreadEvents>(
              buildManagedApiUrl(
                `/v1/sessions/${id(sessionId)}/threads/${id(threadId)}/stream`,
                query as Record<string, QueryValue>,
              ),
              options,
            );
          },
        },
      },
    },
    files: {
      list: (params: WithoutBetas<FileListParams> = {}) =>
        request<FilesPage<BetaFileMetadata>>(
          buildManagedApiUrl("/v1/files", params as Record<string, QueryValue>),
        ),
      retrieveMetadata: (fileId: string) =>
        request<BetaFileMetadata>(`/v1/files/${id(fileId)}`),
      download: (
        fileId: string,
        _params: WithoutBetas<FileDownloadParams> = {},
      ) =>
        raw(`/v1/files/${id(fileId)}/content`, {
          headers: { Accept: "application/binary" },
        }),
      upload: (params: WithoutBetas<FileUploadParams>) =>
        request<BetaFileMetadata>("/v1/files", singleFile(params.file)),
      delete: (fileId: string) =>
        request<BetaDeletedFile>(`/v1/files/${id(fileId)}`, {
          method: "DELETE",
        }),
    },
    skills: {
      list: (params: WithoutBetas<SkillListParams> = {}) =>
        request<ManagedPage<SkillListResponse>>(
          buildManagedApiUrl(
            "/v1/skills",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (skillId: string) =>
        request<SkillRetrieveResponse>(`/v1/skills/${id(skillId)}`),
      create: (params: WithoutBetas<SkillCreateParams>) =>
        request<SkillCreateResponse>(
          "/v1/skills",
          multipart(params.files, { display_title: params.display_title }),
        ),
      delete: (skillId: string) =>
        request<SkillDeleteResponse>(`/v1/skills/${id(skillId)}`, {
          method: "DELETE",
        }),
      versions: {
        list: (
          skillId: string,
          params: WithoutBetas<VersionListParams> = {},
        ) =>
          request<ManagedPage<VersionListResponse>>(
            buildManagedApiUrl(
              `/v1/skills/${id(skillId)}/versions`,
              params as Record<string, QueryValue>,
            ),
          ),
        retrieve: (version: string, params: { skill_id: string }) =>
          request<VersionRetrieveResponse>(
            `/v1/skills/${id(params.skill_id)}/versions/${id(version)}`,
          ),
        create: (
          skillId: string,
          params: WithoutBetas<VersionCreateParams>,
        ) =>
          request<VersionCreateResponse>(
            `/v1/skills/${id(skillId)}/versions`,
            multipart(params.files),
          ),
        delete: (version: string, params: { skill_id: string }) =>
          request<VersionDeleteResponse>(
            `/v1/skills/${id(params.skill_id)}/versions/${id(version)}`,
            { method: "DELETE" },
          ),
        download: (
          version: string,
          params: WithoutBetas<VersionDownloadParams>,
        ) =>
          raw(
            `/v1/skills/${id(params.skill_id)}/versions/${id(version)}/content`,
            { headers: { Accept: "application/binary" } },
          ),
      },
    },
    models: {
      list: (params: WithoutBetas<ModelListParams> = {}) =>
        request<FilesPage<BetaModelInfo>>(
          buildManagedApiUrl(
            "/v1/models",
            params as Record<string, QueryValue>,
          ),
        ),
      retrieve: (modelId: string) =>
        request<BetaModelInfo>(`/v1/models/${id(modelId)}`),
    },
    tunnels: {
      create: (params: WithoutBetas<TunnelCreateParams>) =>
        request<BetaTunnel>("/v1/tunnels", json(params)),
      retrieve: (
        tunnelId: string,
        _params: WithoutBetas<TunnelRetrieveParams> = {},
      ) => request<BetaTunnel>(`/v1/tunnels/${id(tunnelId)}`),
      list: (params: WithoutBetas<TunnelListParams> = {}) =>
        request<ManagedPage<BetaTunnel>>(
          buildManagedApiUrl(
            "/v1/tunnels",
            params as Record<string, QueryValue>,
          ),
        ),
      archive: (
        tunnelId: string,
        _params: WithoutBetas<TunnelArchiveParams> = {},
      ) =>
        request<BetaTunnel>(
          `/v1/tunnels/${id(tunnelId)}/archive`,
          json({}),
        ),
      revealToken: (
        tunnelId: string,
        _params: WithoutBetas<TunnelRevealTokenParams> = {},
      ) =>
        request<BetaTunnelToken>(
          `/v1/tunnels/${id(tunnelId)}/reveal_token`,
          json({}),
        ),
      rotateToken: (
        tunnelId: string,
        params: WithoutBetas<TunnelRotateTokenParams>,
      ) =>
        request<BetaTunnelToken>(
          `/v1/tunnels/${id(tunnelId)}/rotate_token`,
          json(params),
        ),
      certificates: {
        create: (
          tunnelId: string,
          params: WithoutBetas<CertificateCreateParams>,
        ) =>
          request<BetaTunnelCertificate>(
            `/v1/tunnels/${id(tunnelId)}/certificates`,
            json(params),
          ),
        retrieve: (
          certificateId: string,
          params: WithoutBetas<CertificateRetrieveParams>,
        ) =>
          request<BetaTunnelCertificate>(
            `/v1/tunnels/${id(params.tunnel_id)}/certificates/${id(certificateId)}`,
          ),
        list: (
          tunnelId: string,
          params: WithoutBetas<CertificateListParams> = {},
        ) =>
          request<ManagedPage<BetaTunnelCertificate>>(
            buildManagedApiUrl(
              `/v1/tunnels/${id(tunnelId)}/certificates`,
              params as Record<string, QueryValue>,
            ),
          ),
        archive: (
          certificateId: string,
          params: WithoutBetas<CertificateArchiveParams>,
        ) =>
          request<BetaTunnelCertificate>(
            `/v1/tunnels/${id(params.tunnel_id)}/certificates/${id(certificateId)}/archive`,
            json({}),
          ),
      },
    },
    userProfiles: {
      create: (params: WithoutBetas<UserProfileCreateParams>) =>
        request<BetaUserProfile>("/v1/user_profiles", json(params)),
      retrieve: (
        userProfileId: string,
        _params: WithoutBetas<UserProfileRetrieveParams> = {},
      ) => request<BetaUserProfile>(`/v1/user_profiles/${id(userProfileId)}`),
      update: (
        userProfileId: string,
        params: WithoutBetas<UserProfileUpdateParams>,
      ) =>
        request<BetaUserProfile>(
          `/v1/user_profiles/${id(userProfileId)}`,
          json(params),
        ),
      list: (params: WithoutBetas<UserProfileListParams> = {}) =>
        request<ManagedPage<BetaUserProfile>>(
          buildManagedApiUrl(
            "/v1/user_profiles",
            params as Record<string, QueryValue>,
          ),
        ),
      createEnrollmentURL: (
        userProfileId: string,
        _params: WithoutBetas<UserProfileCreateEnrollmentURLParams> = {},
      ) =>
        request<BetaUserProfileEnrollmentURL>(
          `/v1/user_profiles/${id(userProfileId)}/enrollment_url`,
          json({}),
        ),
    },
  } as const;
}
