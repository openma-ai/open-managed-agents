import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";

import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Disclosure } from "../components/Disclosure";
import { LocalCombobox } from "../components/LocalCombobox";
import { SecretInput, TextInput } from "../components/Input";
import { FilterChip } from "../components/FilterChip";
import { FacetedFilter } from "../components/FacetedFilter";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";

// =================================================================
// Types
// =================================================================

interface Vault {
  id: string;
  name: string;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}
interface Credential {
  id: string;
  display_name: string;
  vault_id: string;
  auth: { type: string; mcp_server_url?: string; cli_id?: string };
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
}

// First-wave cap CLI list. Mirrors @open-managed-agents/cap builtinSpecs.
// Lifted verbatim from VaultsList — kept here because the Add-credential
// flow now lives on this page.
const CAP_CLIS: Array<{ cli_id: string; label: string; helper: string; oauth?: boolean }> = [
  { cli_id: "gh", label: "GitHub CLI (gh)", helper: "Personal access token (ghp_...)", oauth: true },
  { cli_id: "glab", label: "GitLab CLI (glab)", helper: "Personal access token (glpat-...)", oauth: true },
  { cli_id: "az", label: "Azure CLI (az)", helper: "ARM access token", oauth: true },
  { cli_id: "gcloud", label: "Google Cloud SDK", helper: "OAuth access token", oauth: true },
  { cli_id: "fly", label: "Fly.io (fly / flyctl)", helper: "Fly API token (fo1_...)" },
  { cli_id: "vercel", label: "Vercel CLI", helper: "Account access token" },
  { cli_id: "doctl", label: "DigitalOcean (doctl)", helper: "API token (dop_v1_...)" },
  { cli_id: "heroku", label: "Heroku CLI", helper: "API token (heroku auth:token)" },
  { cli_id: "cf", label: "Cloudflare (cf / wrangler)", helper: "API token (CLOUDFLARE_API_TOKEN)" },
  { cli_id: "npm", label: "npm registry", helper: "Granular access token (npm_...)" },
  { cli_id: "aws", label: "AWS CLI / SDKs", helper: "AWS secret access key" },
  { cli_id: "kubectl", label: "kubectl", helper: "Bearer token for the API server" },
  { cli_id: "docker", label: "Docker registry", helper: "Registry password / PAT" },
  { cli_id: "git", label: "git (HTTPS remotes)", helper: "Personal access token" },
];

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

// =================================================================
// Page
// =================================================================

export function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();

  const { data: vault, error: vaultError } = useApiQuery<Vault>(
    id ? `/v1/vaults/${id}` : null,
  );
  const {
    data: credsRes,
    isLoading: credsLoading,
    refetch: refetchCreds,
  } = useApiQuery<{ data: Credential[] }>(
    id ? `/v1/vaults/${id}/credentials` : null,
  );
  const credentials = useMemo(() => credsRes?.data ?? [], [credsRes]);

  // Status filter applied client-side — the credentials list endpoint
  // doesn't accept a status query param and the per-vault credential count
  // is small enough that paging it server-side would be over-engineering.
  const [status, setStatus] = useState<StatusValue>("active");
  const filteredCreds = useMemo(() => {
    if (status === "any") return credentials;
    if (status === "active") return credentials.filter((c) => !c.archived_at);
    return credentials.filter((c) => !!c.archived_at);
  }, [credentials, status]);

  const [showAddCred, setShowAddCred] = useState(false);

  // Refetch credentials after a successful add/delete. Mirrors the old
  // `openVault(selectedVault)` reload from VaultsList, but goes through
  // TQ so any other tab/observer with the same key updates too.
  const reloadCredentials = useCallback(() => {
    if (!id) return;
    void refetchCreds();
    void queryClient.invalidateQueries({
      queryKey: [`/v1/vaults/${id}/credentials`],
    });
  }, [id, refetchCreds, queryClient]);

  const archive = async () => {
    if (!id) return;
    if (
      !confirm(
        "Archive this vault? All its credentials will also be archived. Archive is one-way.",
      )
    )
      return;
    try {
      await api(`/v1/vaults/${id}/archive`, { method: "POST" });
      nav("/vaults");
    } catch {
      // useApi already toasts the underlying error.
    }
  };

  const del = async () => {
    if (!id) return;
    if (
      !confirm(
        "Delete this vault and ALL its credentials? This cannot be undone.",
      )
    )
      return;
    try {
      await api(`/v1/vaults/${id}`, { method: "DELETE" });
      nav("/vaults");
    } catch {
      // useApi already toasts the underlying error.
    }
  };

  const deleteCred = async (credId: string) => {
    if (!id) return;
    if (!confirm("Delete this credential?")) return;
    try {
      await api(`/v1/vaults/${id}/credentials/${credId}`, { method: "DELETE" });
      reloadCredentials();
    } catch {
      // useApi already toasts the underlying error.
    }
  };

  const errorMsg =
    vaultError instanceof Error
      ? vaultError.message
      : vaultError
        ? String(vaultError)
        : null;

  if (!id) return <div className="flex-1 p-8">Missing vault id.</div>;
  if (errorMsg)
    return <div className="flex-1 p-8 text-danger">Error: {errorMsg}</div>;
  if (!vault) return <div className="flex-1 p-8 text-fg-muted">Loading...</div>;

  const archived = !!vault.archived_at;
  const updatedAt = vault.updated_at ?? vault.created_at;

  // Active-filter chip display — null at the default so the chip reads
  // "Status ▾" rather than "Status: All ▾". Matches the list-page pattern.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  return (
    <Page
      header={
        <PageHeader
          title={vault.name}
          subtitle={
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
              <span
                className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full ${
                  archived
                    ? "bg-bg-surface text-fg-subtle"
                    : "bg-success-subtle text-success"
                }`}
              >
                {archived ? "archived" : "active"}
              </span>
              <span className="font-mono">{vault.id}</span>
              <span>Created {new Date(vault.created_at).toLocaleString()}</span>
              <span>Updated {new Date(updatedAt).toLocaleString()}</span>
              {archived && (
                <span>
                  Archived {new Date(vault.archived_at!).toLocaleString()}
                </span>
              )}
            </span>
          }
          actions={
            <>
              {!archived && (
                <Button variant="outline" size="sm" onClick={archive}>
                  Archive
                </Button>
              )}
              <Button variant="destructive" size="sm" onClick={del}>
                Delete
              </Button>
            </>
          }
        />
      }
    >
      <div>
        <section>
          <header className="flex items-center gap-3 mb-3 flex-wrap">
            <h2 className="font-display text-base font-semibold text-fg mr-auto">
              Credentials
            </h2>
            <FilterChip
              label="Status"
              active={status !== "any"}
              display={statusDisplay}
              onClear={() => setStatus("any")}
            >
              <PopoverContent
                align="end"
                sideOffset={4}
                collisionPadding={8}
                className="w-48 p-0"
              >
                <FacetedFilter
                  options={STATUS_OPTIONS}
                  value={status}
                  onValueChange={(v) => setStatus(v as StatusValue)}
                  searchPlaceholder="Status..."
                />
              </PopoverContent>
            </FilterChip>
            {!archived && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddCred(true)}
              >
                + Add credential
              </Button>
            )}
          </header>

          {credsLoading ? (
            <div className="text-fg-subtle text-sm py-4">Loading...</div>
          ) : filteredCreds.length === 0 ? (
            <div className="border border-border rounded-lg px-4 py-8 text-center text-fg-subtle text-sm">
              {credentials.length === 0
                ? "No credentials yet. Connect an MCP server or add a CLI token."
                : "No credentials match the current filter."}
            </div>
          ) : (
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                    <th className="text-left px-4 py-2.5">Name</th>
                    <th className="text-left px-4 py-2.5">ID</th>
                    <th className="text-left px-4 py-2.5">Type</th>
                    <th className="text-left px-4 py-2.5">MCP server URL</th>
                    <th className="text-left px-4 py-2.5">Status</th>
                    <th className="text-left px-4 py-2.5">Updated</th>
                    <th className="text-right px-4 py-2.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCreds.map((c) => {
                    const typeLabel =
                      c.auth.type === "mcp_oauth"
                        ? "OAuth"
                        : c.auth.type === "cap_cli"
                          ? "CLI"
                          : "Bearer";
                    const typeCls =
                      c.auth.type === "mcp_oauth"
                        ? "bg-info-subtle text-info"
                        : c.auth.type === "cap_cli"
                          ? "bg-brand-subtle text-brand"
                          : "bg-success-subtle text-success";
                    return (
                      <tr key={c.id} className="border-t border-border">
                        <td className="px-4 py-3 font-medium text-fg">
                          {c.display_name}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-fg-muted">
                          {c.id}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full ${typeCls}`}
                          >
                            {typeLabel}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-fg-muted truncate max-w-[260px]">
                          {c.auth.mcp_server_url || c.auth.cli_id || "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full ${
                              c.archived_at
                                ? "bg-bg-surface text-fg-subtle"
                                : "bg-success-subtle text-success"
                            }`}
                          >
                            {c.archived_at ? "archived" : "active"}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-fg-muted">
                          {new Date(c.updated_at ?? c.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => deleteCred(c.id)}
                            className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {showAddCred && (
        <AddCredentialModal
          vault={vault}
          onClose={() => setShowAddCred(false)}
          onCreated={() => {
            setShowAddCred(false);
            reloadCredentials();
          }}
        />
      )}
    </Page>
  );
}

// =================================================================
// Add credential modal — unified MCP / CLI (Anthropic-style)
// =================================================================

function AddCredentialModal({
  vault,
  onClose,
  onCreated,
}: {
  vault: Vault;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { api } = useApi();

  // Top-level tab inside the modal: MCP server vs CLI. Folds the two
  // previously separate entry points into one modal; matches Anthropic.
  const [addTab, setAddTab] = useState<"mcp" | "cli">("mcp");
  const [connecting, setConnecting] = useState<string | null>(null);

  // Custom MCP server form — single inline form (Anthropic-style). All
  // fields in one view; refresh-token block reveals only when an access
  // token is filled (RFC 6749 §6: refresh_token requires access_token).
  const [customForm, setCustomForm] = useState({
    name: "",
    type: "oauth" as "oauth" | "bearer",
    url: "",
    pickedName: "",
    pickedIcon: "",
    token: "",
    refreshToken: "",
    tokenEndpoint: "",
    authMethod: "client_secret_post" as
      | "client_secret_basic"
      | "client_secret_post"
      | "none",
    clientId: "",
    clientSecret: "",
  });
  const [tokenSectionOpen, setTokenSectionOpen] = useState(false);
  const [refreshSectionOpen, setRefreshSectionOpen] = useState(false);
  const [clientCredsSectionOpen, setClientCredsSectionOpen] = useState(false);

  // Add-CLI form (cap_cli credentials). Visible under the "CLI" tab.
  const [cliForm, setCliForm] = useState({
    cli_id: "gh",
    display_name: "",
    token: "",
  });

  // OAuth Device Authorization Grant state for cap_cli credentials.
  // Set when "Sign in via OAuth" is clicked; the poll loop fires until
  // ready / failure, then writes a cap_cli credential.
  const [deviceFlow, setDeviceFlow] = useState<{
    cli_id: string;
    session_id: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete?: string;
    interval_seconds: number;
    expires_at_ms: number;
    status: "polling" | "ready" | "expired" | "denied" | "error";
    error?: string;
  } | null>(null);

  // Listen for OAuth popup completion. Two transports because COOP
  // severs window.opener for providers like Sentry (which set
  // Cross-Origin-Opener-Policy: same-origin on their authorize page) —
  // postMessage from the popup back to us doesn't work in that case.
  // BroadcastChannel is same-origin and survives COOP, so use it as a
  // parallel channel; the popup posts to both. Either firing is enough.
  const handleOAuthMessage = useCallback(
    (event: MessageEvent | { data: unknown }) => {
      const data = (
        event as {
          data?: {
            type?: string;
            service?: string;
            probe_ok?: boolean;
            probe_message?: string | null;
          };
        }
      ).data;
      if (data?.type === "oauth_complete") {
        setConnecting(null);
        onCreated();
        // Surface the MCP probe result so the user knows whether the just-
        // stored credential will actually work. Same toasts as the legacy
        // VaultsList modal.
        const svc = data.service ?? "MCP server";
        if (data.probe_ok === true) {
          toast.success(`Connected to ${svc} — token verified.`);
        } else if (data.probe_ok === false) {
          toast.warning(
            data.probe_message
              ? `Connected to ${svc}, but: ${data.probe_message}`
              : `Connected to ${svc}, but the server rejected our token.`,
          );
        }
      }
    },
    [onCreated],
  );

  useEffect(() => {
    window.addEventListener("message", handleOAuthMessage);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel("openma-oauth");
      bc.addEventListener("message", handleOAuthMessage);
    } catch {
      // Old browser without BroadcastChannel — fall back to postMessage only.
    }
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      if (bc) {
        bc.removeEventListener("message", handleOAuthMessage);
        bc.close();
      }
    };
  }, [handleOAuthMessage]);

  const connectMcp = (
    entry: McpRegistryEntry | { name: string; url: string },
    opts?: { clientId?: string; clientSecret?: string },
  ) => {
    setConnecting(entry.name);
    const params = new URLSearchParams({
      mcp_server_url: entry.url,
      vault_id: vault.id,
      redirect_uri: window.location.href,
    });
    if (opts?.clientId) params.set("client_id", opts.clientId);
    if (opts?.clientSecret) params.set("client_secret", opts.clientSecret);
    window.open(
      `/v1/oauth/authorize?${params.toString()}`,
      "oauth",
      "width=600,height=700,popup=yes",
    );
  };

  const createBearerCred = async () => {
    setConnecting("custom");
    try {
      // OAuth-standard credential auth shape:
      //   - access_token + refresh_token + token_endpoint → mcp_oauth
      //     (server can refresh on 401 via vault-forward.refreshMcpOAuth).
      //   - access_token only → static_bearer (no auto-refresh).
      const hasRefresh = customForm.refreshToken && customForm.tokenEndpoint;
      const auth: Record<string, unknown> = hasRefresh
        ? {
            type: "mcp_oauth",
            access_token: customForm.token,
            refresh_token: customForm.refreshToken,
            token_endpoint: customForm.tokenEndpoint,
            token_endpoint_auth_method: customForm.authMethod,
            mcp_server_url: customForm.url,
          }
        : {
            type: "static_bearer",
            token: customForm.token,
            mcp_server_url: customForm.url,
          };
      await api(`/v1/vaults/${vault.id}/credentials`, {
        method: "POST",
        body: JSON.stringify({
          display_name:
            customForm.name || customForm.pickedName || "Custom MCP",
          auth,
        }),
      });
      onCreated();
    } finally {
      setConnecting(null);
    }
  };

  const submitCustom = () => {
    // Submit rules for the unified Add-credential MCP form:
    //   - Bearer type or Access token filled → POST a credential
    //     immediately (mcp_oauth if refresh_token present, else
    //     static_bearer). Button reads "Add credential".
    //   - Otherwise → start /v1/oauth/authorize popup. Button reads
    //     "Connect". Picking a registry row only fills the MCP Server
    //     field, never auto-connects.
    if (!customForm.url) return;
    if (customForm.type === "bearer" || customForm.token) {
      void createBearerCred();
    } else {
      connectMcp(
        {
          name:
            customForm.name || customForm.pickedName || customForm.url,
          url: customForm.url,
        },
        { clientId: customForm.clientId, clientSecret: customForm.clientSecret },
      );
    }
  };

  const createCapCliCred = async () => {
    const defaultName =
      CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ?? cliForm.cli_id;
    await api(`/v1/vaults/${vault.id}/credentials`, {
      method: "POST",
      body: JSON.stringify({
        display_name: cliForm.display_name || defaultName,
        auth: {
          type: "cap_cli",
          cli_id: cliForm.cli_id,
          token: cliForm.token,
        },
      }),
    });
    onCreated();
  };

  // Drive cap's OAuth Device Authorization Grant for the selected CLI.
  // Sequence: POST /initiate → show user_code + URL → poll /poll until
  // ready / terminal failure → write cap_cli credential and close modal.
  const startDeviceFlow = async () => {
    setDeviceFlow(null);
    try {
      const init = await api<{
        session_id: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        interval_seconds: number;
        expires_at_ms: number;
      }>(`/v1/cap-cli/oauth/initiate`, {
        method: "POST",
        body: JSON.stringify({ vault_id: vault.id, cli_id: cliForm.cli_id }),
      });
      const flow = { ...init, cli_id: cliForm.cli_id, status: "polling" as const };
      setDeviceFlow(flow);
      void pollDeviceFlow(flow);
    } catch (err) {
      setDeviceFlow({
        cli_id: cliForm.cli_id,
        session_id: "",
        user_code: "",
        verification_uri: "",
        interval_seconds: 0,
        expires_at_ms: 0,
        status: "error",
        error: (err as Error).message,
      });
    }
  };

  const pollDeviceFlow = async (flow: {
    session_id: string;
    interval_seconds: number;
    expires_at_ms: number;
  }) => {
    let interval = flow.interval_seconds;
    while (Date.now() < flow.expires_at_ms) {
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        const r = await api<{
          status:
            | "pending"
            | "slow_down"
            | "ready"
            | "expired"
            | "denied"
            | "error";
          new_interval_seconds?: number;
          oauth_error?: string;
          description?: string;
          credential_id?: string;
        }>(`/v1/cap-cli/oauth/poll`, {
          method: "POST",
          body: JSON.stringify({ session_id: flow.session_id }),
        });
        if (r.status === "pending") continue;
        if (r.status === "slow_down") {
          interval = r.new_interval_seconds ?? interval + 5;
          continue;
        }
        if (r.status === "ready") {
          setDeviceFlow((prev) => (prev ? { ...prev, status: "ready" } : null));
          // Trigger a refetch so the new credential shows up; close after
          // a short delay so the user gets visual confirmation first.
          onCreated();
          setTimeout(() => {
            setDeviceFlow(null);
          }, 1500);
          return;
        }
        // expired / denied / error
        setDeviceFlow((prev) =>
          prev
            ? {
                ...prev,
                status: r.status as "expired" | "denied" | "error",
                error: r.description ?? r.oauth_error,
              }
            : null,
        );
        return;
      } catch (err) {
        setDeviceFlow((prev) =>
          prev
            ? { ...prev, status: "error", error: (err as Error).message }
            : null,
        );
        return;
      }
    }
    setDeviceFlow((prev) => (prev ? { ...prev, status: "expired" } : null));
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add credential"
      maxWidth="max-w-lg"
      footer={
        addTab === "cli" ? (
          deviceFlow?.status === "polling" ? (
            <Button variant="ghost" onClick={() => setDeviceFlow(null)}>
              Cancel
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button onClick={createCapCliCred} disabled={!cliForm.token}>
                Create
              </Button>
            </>
          )
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={submitCustom}
              disabled={
                !customForm.url ||
                !!connecting ||
                (customForm.type === "bearer" && !customForm.token)
              }
            >
              {customForm.token || customForm.type === "bearer"
                ? "Add credential"
                : "Connect"}
            </Button>
          </>
        )
      }
    >
      <Tabs
        value={addTab}
        onValueChange={(v) => setAddTab(v as "mcp" | "cli")}
        aria-label="Add credential"
      >
        <TabsList className="mb-3">
          <TabsTrigger value="mcp">MCP server</TabsTrigger>
          <TabsTrigger value="cli">CLI</TabsTrigger>
        </TabsList>

        <TabsContent value="mcp" className="space-y-4">
          <div className="text-sm text-fg-muted">
            Authorize an MCP server for delegated user authentication.
          </div>

          <div>
            <label
              htmlFor="vault-mcp-name"
              className="text-sm font-medium text-fg block mb-1"
            >
              Name{" "}
              <span className="text-xs text-fg-muted ml-1 px-1.5 py-0.5 rounded bg-bg-surface">
                Optional
              </span>
            </label>
            <input
              id="vault-mcp-name"
              value={customForm.name}
              onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
              placeholder="Example MCP"
              className={inputCls}
            />
          </div>

          <div>
            <label className="text-sm font-medium text-fg block mb-1">Type</label>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(["oauth", "bearer"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setCustomForm({ ...customForm, type: t })}
                  className={`inline-flex items-center justify-center px-3 py-1 min-h-11 sm:min-h-0 text-sm rounded ${customForm.type === t ? "bg-bg-surface text-fg font-medium" : "text-fg-muted"}`}
                >
                  {t === "oauth" ? "OAuth" : "Bearer token"}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-fg block mb-1">
              MCP Server
            </label>
            {/* Combobox: input filters the registry as you type. Pick a
                row to fill the URL + show the favicon as a left-side
                prefix; type a custom URL to ignore the registry. The
                dropdown renders into document.body via portal so it
                escapes Modal's overflow-y-auto clipping. */}
            <LocalCombobox
              value={customForm.url}
              onChange={(text) =>
                setCustomForm({
                  ...customForm,
                  url: text,
                  pickedName: "",
                  pickedIcon: "",
                })
              }
              onPick={(entry) =>
                setCustomForm({
                  ...customForm,
                  url: entry.url,
                  pickedName: entry.name,
                  pickedIcon: entry.icon ?? "",
                })
              }
              options={MCP_REGISTRY}
              filter={(entry, q) =>
                !q ||
                entry.name.toLowerCase().includes(q) ||
                entry.url.toLowerCase().includes(q)
              }
              getKey={(entry) => entry.id}
              renderItem={(entry) => (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  {entry.icon ? (
                    <img
                      src={entry.icon}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="w-5 h-5 rounded shrink-0"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="w-5 h-5 rounded bg-bg-surface shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-fg">
                      {entry.name}
                    </div>
                    <div className="text-xs text-fg-muted font-mono truncate">
                      {entry.url}
                    </div>
                  </div>
                </div>
              )}
              prefix={
                customForm.pickedIcon ? (
                  <img
                    src={customForm.pickedIcon}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="w-4 h-4 rounded shrink-0"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : null
              }
              placeholder="Search Anthropic's MCP registry or enter a custom URL"
              emptyHint="No matches — keep typing for a custom URL"
            />
          </div>

          {/* Access token — collapsed Optional. Filling this switches the
              submit path to POST static_bearer + button label changes to
              "Add credential". Visible regardless of Type so the user can
              supply a pre-issued OAuth access_token without a handshake. */}
          <Disclosure
            title="Access token"
            meta={
              <span className="px-1.5 py-0.5 rounded bg-bg-surface">
                Optional
              </span>
            }
            open={tokenSectionOpen}
            onOpenChange={setTokenSectionOpen}
          >
            <input
              value={customForm.token}
              onChange={(e) =>
                setCustomForm({ ...customForm, token: e.target.value })
              }
              type="password"
              placeholder="••••••••"
              aria-label="Access token"
              className={inputCls}
            />
            <div className="text-xs text-fg-subtle mt-1">
              If filled, the credential is stored as a static bearer token (no
              OAuth handshake).
            </div>
          </Disclosure>

          {/* Refresh token block (Optional) — only meaningful when an
              Access token is also set (RFC 6749 §6 refresh_token grant). */}
          {customForm.token && (
            <Disclosure
              title="Refresh token"
              meta={
                <span className="px-1.5 py-0.5 rounded bg-bg-surface">
                  Optional
                </span>
              }
              open={refreshSectionOpen}
              onOpenChange={setRefreshSectionOpen}
              className="space-y-3"
            >
              <div className="space-y-3">
                <div>
                  <input
                    value={customForm.refreshToken}
                    onChange={(e) =>
                      setCustomForm({
                        ...customForm,
                        refreshToken: e.target.value,
                      })
                    }
                    placeholder="OAuth refresh token"
                    aria-label="Refresh token"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label
                    htmlFor="vault-token-endpoint"
                    className="text-sm font-medium text-fg block mb-1"
                  >
                    Token endpoint
                  </label>
                  <input
                    id="vault-token-endpoint"
                    value={customForm.tokenEndpoint}
                    onChange={(e) =>
                      setCustomForm({
                        ...customForm,
                        tokenEndpoint: e.target.value,
                      })
                    }
                    placeholder="https://auth.example.com/oauth/token"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label
                    htmlFor="vault-auth-method"
                    className="text-sm font-medium text-fg block mb-1"
                  >
                    Auth method
                  </label>
                  <select
                    id="vault-auth-method"
                    value={customForm.authMethod}
                    onChange={(e) =>
                      setCustomForm({
                        ...customForm,
                        authMethod: e.target
                          .value as typeof customForm.authMethod,
                      })
                    }
                    className={inputCls}
                  >
                    <option value="client_secret_post">client_secret_post</option>
                    <option value="client_secret_basic">client_secret_basic</option>
                    <option value="none">none</option>
                  </select>
                </div>
                <div className="text-xs text-fg-subtle">
                  RFC 8414 token_endpoint_auth_methods_supported. Used when the
                  server refreshes on 401.
                </div>
              </div>
            </Disclosure>
          )}
          {/* OAuth client credentials (Optional) — only shown for the
              OAuth flow. Lets the user override the server's preset
              client_id/secret on a per-credential basis (GitHub, Feishu,
              any provider that doesn't support DCR). */}
          {customForm.type === "oauth" && !customForm.token && (
            <Disclosure
              title="OAuth client credentials"
              meta={
                <span className="px-1.5 py-0.5 rounded bg-bg-surface">
                  Optional
                </span>
              }
              open={clientCredsSectionOpen}
              onOpenChange={setClientCredsSectionOpen}
            >
              <div className="space-y-2">
                <input
                  value={customForm.clientId}
                  onChange={(e) =>
                    setCustomForm({ ...customForm, clientId: e.target.value })
                  }
                  placeholder="Client ID"
                  aria-label="OAuth client ID"
                  className={inputCls}
                />
                <input
                  value={customForm.clientSecret}
                  onChange={(e) =>
                    setCustomForm({
                      ...customForm,
                      clientSecret: e.target.value,
                    })
                  }
                  type="password"
                  placeholder="Client secret"
                  aria-label="OAuth client secret"
                  className={inputCls}
                />
                <div className="text-xs text-fg-subtle">
                  For OAuth providers that don't support Dynamic Client
                  Registration (GitHub, Feishu) — supply a client_id/secret from
                  a pre-registered app.
                </div>
              </div>
            </Disclosure>
          )}
        </TabsContent>

        <TabsContent value="cli" className="space-y-3">
          <div>
            <label
              htmlFor="vault-cli-id"
              className="text-sm text-fg-muted block mb-1"
            >
              CLI
            </label>
            <select
              id="vault-cli-id"
              value={cliForm.cli_id}
              onChange={(e) => {
                setCliForm({ ...cliForm, cli_id: e.target.value });
                setDeviceFlow(null);
              }}
              className={inputCls}
              disabled={deviceFlow?.status === "polling"}
            >
              {CAP_CLIS.map((c) => (
                <option key={c.cli_id} value={c.cli_id}>
                  {c.label}
                  {c.oauth ? " (OAuth supported)" : ""}
                </option>
              ))}
            </select>
            <div className="text-xs text-fg-subtle mt-1">
              {CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.helper}
            </div>
          </div>

          {CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.oauth && (
            <div className="border border-border rounded-md p-3 bg-bg-surface">
              {!deviceFlow && (
                <Button variant="outline" size="sm" onClick={startDeviceFlow}>
                  Sign in via {cliForm.cli_id} OAuth
                </Button>
              )}
              {deviceFlow?.status === "polling" && (
                <div className="space-y-2 text-sm">
                  <div className="text-fg-muted">
                    Open{" "}
                    <a
                      href={
                        deviceFlow.verification_uri_complete ??
                        deviceFlow.verification_uri
                      }
                      target="_blank"
                      rel="noreferrer"
                      className="text-brand underline"
                    >
                      {deviceFlow.verification_uri_complete ??
                        deviceFlow.verification_uri}
                    </a>{" "}
                    and enter:
                  </div>
                  <div className="font-mono text-2xl text-center tracking-widest text-fg py-2 select-all">
                    {deviceFlow.user_code}
                  </div>
                  <div className="text-xs text-fg-subtle text-center">
                    Waiting for confirmation… (polls every{" "}
                    {deviceFlow.interval_seconds}s)
                  </div>
                </div>
              )}
              {deviceFlow?.status === "ready" && (
                <div className="text-sm text-success">
                  ✓ Token acquired and stored.
                </div>
              )}
              {(deviceFlow?.status === "expired" ||
                deviceFlow?.status === "denied" ||
                deviceFlow?.status === "error") && (
                <div className="text-sm text-danger">
                  {deviceFlow.status === "denied"
                    ? "Access denied by user."
                    : deviceFlow.status === "expired"
                      ? "Code expired — try again."
                      : `OAuth error: ${deviceFlow.error ?? "unknown"}`}
                </div>
              )}
            </div>
          )}

          <div>
            <label
              htmlFor="vault-cli-display-name"
              className="text-sm text-fg-muted block mb-1"
            >
              Display Name{" "}
              <span className="text-fg-subtle">(optional)</span>
            </label>
            <TextInput
              id="vault-cli-display-name"
              value={cliForm.display_name}
              onChange={(e) =>
                setCliForm({ ...cliForm, display_name: e.target.value })
              }
              className={inputCls}
              placeholder={
                CAP_CLIS.find((c) => c.cli_id === cliForm.cli_id)?.label ??
                cliForm.cli_id
              }
              disabled={deviceFlow?.status === "polling"}
            />
          </div>
          <div>
            <label
              htmlFor="vault-cli-token"
              className="text-sm text-fg-muted block mb-1"
            >
              Token{" "}
              <span className="text-fg-subtle">
                (write-only — leave blank to use OAuth above)
              </span>
            </label>
            <SecretInput
              id="vault-cli-token"
              value={cliForm.token}
              onChange={(e) =>
                setCliForm({ ...cliForm, token: e.target.value })
              }
              className={inputCls}
              placeholder="••••••••"
              disabled={deviceFlow?.status === "polling"}
            />
          </div>
        </TabsContent>
      </Tabs>
    </Modal>
  );
}
