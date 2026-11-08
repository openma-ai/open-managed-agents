// The Session a sandbox proxy request names (design §0.7, MCP and model
// gateway routes). A v1 managed Session is looked up first, then the legacy
// `/v1/oma` row; an archived or missing Session is not found. Both gateways
// read this one normalized view instead of re-reading the two record shapes.

export interface ProxyMcpServerRecord {
  name: string;
  type?: string;
  url?: string;
  authorizationToken?: string;
  authorization_token?: string;
}

type ProxyModelRecord = string | { id: string };

/** The v1 managed Session fields the gateways read. */
export interface ManagedProxySessionRecord {
  archivedAt: string | null;
  vaultIds: readonly string[];
  agent?: {
    id?: string;
    version?: number;
    model?: ProxyModelRecord;
    mcpServers?: readonly ProxyMcpServerRecord[];
    multiagent?: {
      subagents:
        | { type: "disabled" }
        | {
            type: "enabled";
            predefinedAgents: ReadonlyArray<{
              type: string;
              id?: string;
              version?: number;
              mcpServers?: readonly ProxyMcpServerRecord[];
            }>;
          };
    } | null;
  };
}

/** The legacy `/v1/oma` Session row fields the gateways read. */
export interface LegacyProxySessionRecord {
  archived_at?: string | number | null;
  vault_ids?: readonly string[] | null;
  agent_snapshot?: {
    id?: string;
    version?: number;
    model?: ProxyModelRecord;
    mcp_servers?: readonly ProxyMcpServerRecord[];
    multiagent?: {
      subagents:
        | { type: "disabled" }
        | {
            type: "enabled";
            predefined_agents: ReadonlyArray<{
              id?: string;
              version?: number;
              mcp_servers?: readonly ProxyMcpServerRecord[];
            }>;
          };
    } | null;
  } | null;
}

/** Where a workspace's Sessions live: v1 `managed_sessions`, legacy `sessions`. */
export interface ProxySessionSourcesPort {
  managed: {
    find(input: { workspaceId: string; sessionId: string }): Promise<ManagedProxySessionRecord | null>;
  };
  legacy: {
    get(input: { tenantId: string; sessionId: string }): Promise<LegacyProxySessionRecord | null>;
  };
}

export interface ProxyMcpServer {
  name: string;
  /** Null for a stdio server: nothing to proxy. */
  url: string | null;
  /** Literal bearer configured on the server, injected as is. */
  authorizationToken: string | null;
}

export interface ProxyAgent {
  id?: string;
  version?: number;
  /** Model card handle (`card.model_id`). */
  model?: string;
  mcpServers: ProxyMcpServer[];
}

export interface ProxySession {
  /** Which Vault store backs `vaultIds`: managed (v1) or legacy credentials. */
  kind: "managed" | "legacy";
  vaultIds: readonly string[];
  root: ProxyAgent;
  /** Pinned multiagent roster members. */
  members: ProxyAgent[];
}

export interface ProxyAgentIdentity {
  id: string;
  version: number;
}

/** A read failure is treated as "not this kind of Session": the request
 * then finds nothing and is refused, never forwarded on a guess. */
export async function findProxySession(
  sources: ProxySessionSourcesPort,
  input: { workspaceId: string; sessionId: string },
): Promise<ProxySession | null> {
  const managed = await sources.managed.find(input).catch(() => null);
  if (managed !== null) return managed.archivedAt ? null : fromManaged(managed);
  const legacy = await sources.legacy
    .get({ tenantId: input.workspaceId, sessionId: input.sessionId })
    .catch(() => null);
  if (legacy === null || legacy.archived_at) return null;
  return fromLegacy(legacy);
}

/** The agent a request acts as: the root, or the pinned roster member it
 * names. Selection reads only the Session's immutable roster. */
export function selectProxyAgent(
  session: ProxySession,
  identity?: ProxyAgentIdentity,
): ProxyAgent | undefined {
  if (identity === undefined) return session.root;
  const named = (agent: ProxyAgent) => agent.id === identity.id && agent.version === identity.version;
  return named(session.root) ? session.root : session.members.find(named);
}

function fromManaged(record: ManagedProxySessionRecord): ProxySession {
  const agent = record.agent;
  const subagents = agent?.multiagent?.subagents;
  return {
    kind: "managed",
    vaultIds: record.vaultIds,
    root: proxyAgent(agent?.id, agent?.version, agent?.model, agent?.mcpServers),
    members: subagents?.type === "enabled"
      ? subagents.predefinedAgents
        .filter((member) => member.type === "agent")
        .map((member) => proxyAgent(member.id, member.version, undefined, member.mcpServers))
      : [],
  };
}

function fromLegacy(record: LegacyProxySessionRecord): ProxySession {
  const agent = record.agent_snapshot ?? undefined;
  const subagents = agent?.multiagent?.subagents;
  return {
    kind: "legacy",
    vaultIds: record.vault_ids ?? [],
    root: proxyAgent(agent?.id, agent?.version, agent?.model, agent?.mcp_servers),
    members: subagents?.type === "enabled"
      ? subagents.predefined_agents.map((member) => proxyAgent(member.id, member.version, undefined, member.mcp_servers))
      : [],
  };
}

function proxyAgent(
  id: string | undefined,
  version: number | undefined,
  model: ProxyModelRecord | undefined,
  servers: readonly ProxyMcpServerRecord[] | undefined,
): ProxyAgent {
  return {
    ...(id !== undefined && { id }),
    ...(version !== undefined && { version }),
    ...(model !== undefined && { model: typeof model === "string" ? model : model.id }),
    mcpServers: (servers ?? []).map((server) => ({
      name: server.name,
      url: typeof server.url === "string" && server.url.length > 0 ? server.url : null,
      authorizationToken: server.authorization_token || server.authorizationToken || null,
    })),
  };
}
