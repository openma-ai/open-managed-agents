/**
 * MCP Server Registry — known remote MCP servers that support OAuth via MCP spec.
 * Users search this list or enter a custom URL.
 * OAuth discovery is handled via .well-known/oauth-protected-resource.
 *
 * CLI tools (GitHub, GitLab, etc.) are NOT here — they don't support MCP OAuth
 * discovery or Dynamic Client Registration. Users add CLI tokens manually
 * via the "Add secret" flow.
 *
 * Icon strategy: Google's favicon service. Per-domain `/favicon.ico` is
 * unreliable — many sites serve nothing at the apex (Intercom, Notion at
 * one point) or 30x to a CDN that breaks <img> requests. Google's
 * `s2/favicons` follows redirects, normalizes formats, and has edge
 * caching. One URL pattern, no per-brand guess work.
 */

export interface McpRegistryEntry {
  id: string;
  name: string;
  url: string;
  icon?: string;
}

function favicon(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
}

export const MCP_REGISTRY: McpRegistryEntry[] = [
  { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp", icon: favicon("airtable.com") },
  { id: "amplitude", name: "Amplitude", url: "https://mcp.amplitude.com/mcp", icon: favicon("amplitude.com") },
  // { id: "apollo", name: "Apollo.io", url: "https://mcp.apollo.io/mcp", icon: favicon("apollo.io") },
  //   ↑ disabled: OAuth flow itself works (302 + DCR fine) but the callback
  //     hits an Invalid-OAuth-state on KV lookup, because CF Workers KV is
  //     eventually consistent and Apollo's redirect is faster (<1s) than KV
  //     put→get propagation on cross-POP reads. Re-enable once /v1/oauth/*
  //     migrates state from KV to JWT-encoded (self-contained, no roundtrip)
  //     or to a strongly-consistent store (D1 / Durable Object).
  { id: "asana", name: "Asana", url: "https://mcp.asana.com/v2/mcp", icon: favicon("asana.com") },
  // { id: "atlassian", name: "Atlassian Rovo", url: "https://mcp.atlassian.com/v1/mcp", icon: favicon("atlassian.com") },
  //   ↑ disabled: vendor publishes no PRM at standard well-known paths; OAuth discovery 404s.
  //     SSE endpoint /v1/sse 401s, suggesting a non-discoverable auth scheme.
  //     Re-enable once Atlassian ships RFC 9728 PRM or we add a hard-coded ASM fallback like GitHub's.
  // { id: "clickup", name: "ClickUp", url: "https://mcp.clickup.com/mcp", icon: favicon("clickup.com") },
  //   ↑ disabled: mcp.clickup.com runs a SEPARATE OAuth client namespace from
  //     ClickUp's standard app.clickup.com — client_ids minted via the public
  //     dev console (app.clickup.com/settings/team/<id>/apps) are rejected at
  //     mcp.clickup.com/oauth/authorize with 401 invalid_client. The MCP
  //     namespace only accepts client_ids issued via their DCR endpoint, which
  //     is allowlist-gated (same gate as Feishu/Lark). Re-enable after
  //     getting openma allowlisted in ClickUp's MCP partner program.
  // { id: "feishu", name: "Feishu (飞书)", url: "https://mcp.feishu.cn/mcp", icon: favicon("feishu.cn") },
  //   ↑ disabled: requires Feishu Partner allowlist for a https redirect URI; DCR returns
  //     invalid_redirect_uri for app.openma.dev. Re-enable after registering openma.dev as
  //     Feishu partner OR pushing FEISHU_OAUTH_CLIENT_ID/SECRET from a manually-registered App.
  { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", icon: favicon("github.com") },
  // { id: "intercom", name: "Intercom", url: "https://mcp.intercom.com/mcp", icon: favicon("intercom.com") },
  //   ↑ disabled: same as Atlassian — no PRM published, OAuth discovery 404s.
  // { id: "lark", name: "Lark", url: "https://mcp.larksuite.com/mcp", icon: favicon("larksuite.com") },
  //   ↑ disabled: same Partner-allowlist gate as Feishu (international counterpart, same vendor).
  { id: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", icon: favicon("linear.app") },
  { id: "notion", name: "Notion", url: "https://mcp.notion.com/mcp", icon: favicon("notion.so") },
  { id: "sentry", name: "Sentry", url: "https://mcp.sentry.dev/mcp", icon: favicon("sentry.io") },
  { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp", icon: favicon("slack.com") },
];
