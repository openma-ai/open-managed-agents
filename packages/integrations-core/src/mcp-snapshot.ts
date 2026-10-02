import type { AgentConfig } from "@open-managed-agents/shared";

export interface IntegrationMcpServer {
  name: string;
  url: string;
  type?: string;
}

/**
 * Augment an agent snapshot with extra MCP servers, injecting BOTH the
 * `mcp_servers` URL entry AND a matching `mcp_toolset` declaration into
 * `tools[]` so the agent runtime actually exposes the server's tools.
 *
 * Why both: the harness's MCP wiring iterates `agentConfig.mcp_servers`
 * to set up clients, but the model only sees a tool if there's a
 * corresponding `mcp_toolset` declaration in `tools[]`. Pre-fix, the
 * publish flow added the server URL but never the toolset entry — so a
 * Slack-published agent had the slack vault + server attached, yet the
 * model literally told users to run curl commands because no
 * `mcp__slack__*` tool surfaced. Tracked 2026-05-19.
 *
 * Permission policy = always_allow for injected toolsets: the user just
 * published the agent to this integration, so requiring a per-tool
 * confirmation defeats the point of a teammate bot. Vault binding still
 * gates access — unpublish to revoke.
 *
 * Idempotent on the toolset side: if the agent already declares an
 * mcp_toolset for one of the injected servers (e.g. user manually added
 * slack to the agent before publishing), the existing entry stays.
 * Servers are appended — `mcp_servers` tolerates duplicates today but
 * callers that need a URL change should use
 * {@link refreshIntegrationMcpServers} instead.
 */
export function injectMcpServersIntoSnapshot(
  snapshot: AgentConfig,
  servers: ReadonlyArray<IntegrationMcpServer>,
): AgentConfig {
  if (servers.length === 0) return snapshot;
  const existingServers = snapshot.mcp_servers ?? [];
  const existingTools = snapshot.tools ?? [];
  const declaredToolsetServers = new Set(
    existingTools
      .filter(
        (t): t is { type: "mcp_toolset"; mcp_server_name: string } =>
          (t as { type?: string }).type === "mcp_toolset" &&
          typeof (t as { mcp_server_name?: unknown }).mcp_server_name === "string",
      )
      .map((t) => t.mcp_server_name),
  );
  const toolsToInject = servers
    .filter((s) => !declaredToolsetServers.has(s.name))
    .map((s) => ({
      // mcp_toolset entries carry an extension field `mcp_server_name` not
      // represented in ToolsetConfig today — existing rows in production
      // look identical. Cast through unknown to satisfy TS without widening
      // the shared type for this one path.
      type: "mcp_toolset",
      mcp_server_name: s.name,
      default_config: { permission_policy: { type: "always_allow" as const } },
    })) as unknown as AgentConfig["tools"];
  return {
    ...snapshot,
    mcp_servers: [
      ...existingServers,
      ...servers.map((s) => ({
        name: s.name,
        type: (s.type === "sse" || s.type === "http" ? s.type : "url") as
          "url" | "http" | "sse",
        url: s.url,
      })),
    ],
    tools: [...existingTools, ...(toolsToInject ?? [])],
  };
}

/**
 * Refresh only the MCP servers and toolsets owned by an integration.
 *
 * The rest of the frozen session snapshot stays put: system prompt,
 * metadata, user tool overrides, and MCP servers the user configured on
 * the agent. Session-owned URLs (the per-session Linear hosted MCP
 * endpoint, for example) are left alone even when they share a name with
 * the integration server.
 *
 * Existing toolset entries are kept so a user override on that server is
 * not reset. A missing toolset is added with `always_allow`, matching
 * create-time injection.
 */
export function refreshIntegrationMcpServers(
  snapshot: AgentConfig,
  servers: ReadonlyArray<IntegrationMcpServer>,
  options?: { preserveUrls?: readonly string[] },
): AgentConfig {
  if (servers.length === 0) return snapshot;
  const preserve = new Set(options?.preserveUrls ?? []);
  const mcpServers = [...(snapshot.mcp_servers ?? [])];

  for (const server of servers) {
    const type = (server.type === "sse" || server.type === "http" ? server.type : "url") as
      "url" | "http" | "sse";
    const matches = mcpServers
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => {
        if (entry.name !== server.name || !("url" in entry)) return false;
        return !preserve.has(entry.url);
      });
    if (matches.length === 0) {
      const alreadyPresent = mcpServers.some(
        (entry) => entry.name === server.name && "url" in entry && entry.url === server.url,
      );
      if (!alreadyPresent) {
        mcpServers.push({ name: server.name, type, url: server.url });
      }
      continue;
    }
    const [keep, ...dupes] = matches;
    const authorizationToken = "authorization_token" in keep.entry
      ? keep.entry.authorization_token
      : undefined;
    mcpServers[keep.index] = {
      name: server.name,
      type,
      url: server.url,
      ...(authorizationToken ? { authorization_token: authorizationToken } : {}),
    };
    for (const dupe of [...dupes].reverse()) {
      mcpServers.splice(dupe.index, 1);
    }
  }

  const declaredToolsetServers = new Set(
    (snapshot.tools ?? [])
      .filter(
        (tool): tool is { type: "mcp_toolset"; mcp_server_name: string } =>
          (tool as { type?: string }).type === "mcp_toolset" &&
          typeof (tool as { mcp_server_name?: unknown }).mcp_server_name === "string",
      )
      .map((tool) => tool.mcp_server_name),
  );
  const toolsToInject = servers
    .filter((server) => !declaredToolsetServers.has(server.name))
    .map((server) => ({
      type: "mcp_toolset",
      mcp_server_name: server.name,
      default_config: { permission_policy: { type: "always_allow" as const } },
    })) as unknown as AgentConfig["tools"];

  return {
    ...snapshot,
    mcp_servers: mcpServers,
    tools: [...(snapshot.tools ?? []), ...(toolsToInject ?? [])],
  };
}

/** URLs minted for this session (not the publication) that must survive a refresh. */
export function sessionOwnedMcpUrls(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const linear = metadata?.linear as { mcp_url?: unknown } | undefined;
  return typeof linear?.mcp_url === "string" && linear.mcp_url.length > 0
    ? [linear.mcp_url]
    : [];
}
