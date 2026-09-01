import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import type {
  BetaManagedAgentsCredential,
  CredentialCreateParams,
  CredentialUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type { BetaManagedAgentsVault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";

import { useApi } from "../lib/api";
import { useApiQuery, useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";

import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Disclosure } from "../components/Disclosure";
import { LocalCombobox } from "../components/LocalCombobox";
import { SecretInput, TextInput } from "../components/Input";
import { Select, SelectOption } from "../components/Select";
import { FilterChip } from "../components/FilterChip";
import { FacetedFilter } from "../components/FacetedFilter";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { MCP_REGISTRY, type McpRegistryEntry } from "../data/mcp-registry";
import { useI18n } from "../i18n";

// =================================================================
// Types
// =================================================================

type Vault = BetaManagedAgentsVault;
type Credential = BetaManagedAgentsCredential;

function credentialTypeView(credential: Credential): {
  label: string;
  className: string;
  target: string;
} {
  switch (credential.auth.type) {
    case "mcp_oauth":
      return {
        label: "OAuth",
        className: "bg-info-subtle text-info",
        target: credential.auth.mcp_server_url,
      };
    case "static_bearer":
      return {
        label: "Bearer",
        className: "bg-success-subtle text-success",
        target: credential.auth.mcp_server_url,
      };
    case "environment_variable":
      return {
        label: "Environment variable",
        className: "bg-brand-subtle text-brand",
        target: credential.auth.secret_name,
      };
  }
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
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useI18n();

  const { data: vault, error: vaultError } = useApiQuery<BetaManagedAgentsVault>(
    id ? `/v1/vaults/${id}` : null,
  );
  const {
    items: credentials,
    isLoading: credsLoading,
    refresh: refetchCreds,
  } = useInfiniteApiQuery<Credential>(
    `/v1/vaults/${id ?? "missing"}/credentials`,
    {
      enabled: !!id,
      limit: 100,
      params: { include_archived: "true" },
    },
  );

  // Status filter applied client-side — the credentials list endpoint
  // doesn't accept a status query param. Transport still follows the Managed
  // `page`/`next_page` contract while the product remains a continuous feed.
  const [status, setStatus] = useState<StatusValue>("active");
  const filteredCreds = useMemo(() => {
    if (status === "any") return credentials;
    if (status === "active") return credentials.filter((c) => !c.archived_at);
    return credentials.filter((c) => !!c.archived_at);
  }, [credentials, status]);

  const [showAddCred, setShowAddCred] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [editingCred, setEditingCred] = useState<Credential | null>(null);

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

  const reloadVault = useCallback(() => {
    if (!id) return;
    void queryClient.invalidateQueries({ queryKey: [`/v1/vaults/${id}`] });
    void queryClient.invalidateQueries({ queryKey: ["/v1/vaults"] });
  }, [id, queryClient]);

  const archive = async () => {
    if (!id) return;
    if (
      !confirm(
        "Archive this vault? All its credentials will also be archived. Archive is one-way.",
      )
    )
      return;
    try {
      await managedApi.vaults.archive(id);
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
      await managedApi.vaults.delete(id);
      nav("/vaults");
    } catch {
      // useApi already toasts the underlying error.
    }
  };

  const deleteCred = async (credId: string) => {
    if (!id) return;
    if (!confirm("Delete this credential?")) return;
    try {
      await managedApi.vaults.credentials.delete(credId, { vault_id: id });
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
  const updatedAt = vault.updated_at;

  // Active-filter chip display — null at the default so the chip reads
  // "Status ▾" rather than "Status: All ▾". Matches the list-page pattern.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  return (
    <Page
      layout="rail"
      header={
        <PageHeader
          actions={
            <>
              {!archived && (
                <Button variant="outline" size="sm" onClick={() => setShowRename(true)}>
                  {t.common.rename}
                </Button>
              )}
              {!archived && (
                <Button variant="outline" size="sm" onClick={archive}>
                  {t.common.archive}
                </Button>
              )}
              <Button variant="destructive" size="sm" onClick={del}>
                {t.common.delete}
              </Button>
            </>
          }
        />
      }
      rail={
        <section className="console-property-group" aria-label="Vault properties">
          <h2 className="console-property-group-title">Properties</h2>
          <dl className="console-property-list">
            <PropertyRow label="ID"><span className="font-mono">{vault.id}</span></PropertyRow>
            <PropertyRow label="Status">
              <span className={archived ? "text-fg-muted" : "text-success"}>
                {archived ? "Archived" : "Active"}
              </span>
            </PropertyRow>
            <PropertyRow label="Created">{new Date(vault.created_at).toLocaleString()}</PropertyRow>
            <PropertyRow label="Updated">{new Date(updatedAt).toLocaleString()}</PropertyRow>
            {archived && (
              <PropertyRow label="Archived">
                {new Date(vault.archived_at!).toLocaleString()}
              </PropertyRow>
            )}
          </dl>
        </section>
      }
    >
      <div className="console-detail-stack">
        <header className="console-detail-title-block">
          <h1>{vault.display_name}</h1>
          <p>Credentials and delegated access available to managed agents.</p>
        </header>
        <section className="console-detail-section">
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

          <div className="console-detail-table-wrap" data-testid="credential-list-surface">
            {credsLoading ? (
              <div className="text-fg-subtle text-sm py-4">Loading...</div>
            ) : filteredCreds.length === 0 ? (
              <div className="rounded-[var(--console-radius-row)] bg-[var(--data-row-bg)] px-3 py-8 text-center text-fg-subtle text-sm">
                {credentials.length === 0
                  ? "No credentials yet. Connect an MCP server or add a CLI token."
                  : "No credentials match the current filter."}
              </div>
            ) : (
              <Table className="console-detail-table">
                <TableHeader variant="wireless">
                  <TableRow variant="wireless">
                    <TableHead>Name</TableHead>
                    <TableHead>ID</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>MCP server URL</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredCreds.map((c) => {
                    const typeView = credentialTypeView(c);
                    return (
                      <TableRow variant="wireless" key={c.id}>
                        <TableCell className="font-medium text-fg">
                          {c.display_name || "Untitled credential"}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-fg-muted">
                          {c.id}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full ${typeView.className}`}
                          >
                            {typeView.label}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-xs text-fg-muted truncate max-w-[260px]">
                          {typeView.target || "—"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
                              c.archived_at
                                ? "bg-bg-surface text-fg-subtle"
                                : "bg-success-subtle text-success"
                            }`}
                          >
                            {c.archived_at ? "archived" : "active"}
                          </span>
                        </TableCell>
                        <TableCell className="text-fg-muted">
                          {new Date(c.updated_at).toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">
                          {!c.archived_at && (
                            <Button variant="ghost"
                              onClick={() => setEditingCred(c)}
                              className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-fg-subtle hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                            >
                              {t.common.edit}
                            </Button>
                          )}
                          <Button variant="ghost"
                            onClick={() => deleteCred(c.id)}
                            className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-xs text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                          >
                            {t.common.delete}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </div>
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

      {showRename && (
        <RenameVaultModal
          vault={vault}
          onClose={() => setShowRename(false)}
          onSaved={() => {
            setShowRename(false);
            reloadVault();
          }}
        />
      )}

      {editingCred && (
        <EditCredentialModal
          vault={vault}
          credential={editingCred}
          onClose={() => setEditingCred(null)}
          onSaved={() => {
            setEditingCred(null);
            reloadCredentials();
          }}
        />
      )}
    </Page>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="console-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

// =================================================================
// Rename vault
// =================================================================

function RenameVaultModal({
  vault,
  onClose,
  onSaved,
}: {
  vault: Vault;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [name, setName] = useState(vault.display_name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError("");
    try {
      await managedApi.vaults.update(vault.id, { display_name: trimmed });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename vault");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.vaults.renameVault}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <Label htmlFor="vault-rename" className="text-sm text-fg-muted block mb-1">
        {t.common.name}
      </Label>
      <Input
        id="vault-rename"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={inputCls}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
    </Modal>
  );
}

// =================================================================
// Edit credential — display name + optional secret rotation
// =================================================================

function EditCredentialModal({
  vault,
  credential,
  onClose,
  onSaved,
}: {
  vault: Vault;
  credential: Credential;
  onClose: () => void;
  onSaved: () => void;
}) {
  const managedApi = useManagedApi();
  const { t } = useI18n();
  const [displayName, setDisplayName] = useState(credential.display_name ?? "");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canRotateToken = credential.auth.type === "static_bearer";

  const save = async () => {
    const trimmed = displayName.trim();
    if (!trimmed) {
      setError(t.common.nameRequired);
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body: Omit<CredentialUpdateParams, "betas"> = {
        vault_id: vault.id,
        display_name: trimmed,
      };
      if (credential.auth.type === "static_bearer" && token.trim()) {
        body.auth = { type: "static_bearer", token: token.trim() };
      }
      await managedApi.vaults.credentials.update(credential.id, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update credential");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t.vaults.editCredential}
      subtitle={
        credential.auth.type === "mcp_oauth" ? t.vaults.oauthEditHint : undefined
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t.common.cancel}
          </Button>
          <Button onClick={save} disabled={saving || !displayName.trim()}>
            {saving ? t.common.saving : t.common.save}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3 text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}
      <div className="space-y-3">
        <div>
          <Label htmlFor="cred-edit-name" className="text-sm text-fg-muted block mb-1">
            {t.vaults.displayName}
          </Label>
          <Input
            id="cred-edit-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className={inputCls}
            autoFocus
          />
        </div>
        <div className="text-xs text-fg-subtle">
          Type: <span className="font-mono">{credential.auth.type}</span>
          {credential.auth.type !== "environment_variable" && (
            <>
              {" · "}
              <span className="font-mono">
                {credential.auth.mcp_server_url}
              </span>
            </>
          )}
          {credential.auth.type === "environment_variable" && (
            <>
              {" · "}
              <span className="font-mono">{credential.auth.secret_name}</span>
            </>
          )}
        </div>
        {canRotateToken && (
          <div>
            <Label htmlFor="cred-edit-token" className="text-sm text-fg-muted block mb-1">
              {t.vaults.newTokenOptional}
            </Label>
            <SecretInput
              id="cred-edit-token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={inputCls}
              placeholder={t.vaults.leaveBlankKeepToken}
            />
          </div>
        )}
      </div>
    </Modal>
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
  const managedApi = useManagedApi();

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
      `/v1/oma/oauth/authorize?${params.toString()}`,
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
      const hasRefresh = !!(customForm.refreshToken && customForm.tokenEndpoint);
      const tokenEndpointAuth: NonNullable<
        Extract<CredentialCreateParams["auth"], { type: "mcp_oauth" }>["refresh"]
      >["token_endpoint_auth"] =
        customForm.authMethod === "none"
          ? { type: "none" }
          : {
              type: customForm.authMethod,
              client_secret: customForm.clientSecret,
            };
      const auth: CredentialCreateParams["auth"] = hasRefresh
        ? {
            type: "mcp_oauth",
            access_token: customForm.token,
            mcp_server_url: customForm.url,
            refresh: {
              client_id: customForm.clientId,
              refresh_token: customForm.refreshToken,
              token_endpoint: customForm.tokenEndpoint,
              token_endpoint_auth: tokenEndpointAuth,
            },
          }
        : {
            type: "static_bearer",
            token: customForm.token,
            mcp_server_url: customForm.url,
          };
      await managedApi.vaults.credentials.create(vault.id, {
        display_name:
          customForm.name || customForm.pickedName || "Custom MCP",
        auth,
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
    //   - Otherwise → start /v1/oma/oauth/authorize popup. Button reads
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
    await api(`/v1/oma/vaults/${vault.id}/credentials`, {
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
      }>(`/v1/oma/cap-cli/oauth/initiate`, {
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
        }>(`/v1/oma/cap-cli/oauth/poll`, {
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
            <Label
              htmlFor="vault-mcp-name"
              className="text-sm font-medium text-fg block mb-1"
            >
              Name{" "}
              <span className="text-xs text-fg-muted ml-1 px-1.5 py-0.5 rounded bg-bg-surface">
                Optional
              </span>
            </Label>
            <Input
              id="vault-mcp-name"
              value={customForm.name}
              onChange={(e) => setCustomForm({ ...customForm, name: e.target.value })}
              placeholder="Example MCP"
              className={inputCls}
            />
          </div>

          <div>
            <Label className="text-sm font-medium text-fg block mb-1">Type</Label>
            <div className="inline-flex rounded-md border border-border p-0.5">
              {(["oauth", "bearer"] as const).map((t) => (
                <Button variant="ghost"
                  key={t}
                  type="button"
                  onClick={() => setCustomForm({ ...customForm, type: t })}
                  className={`inline-flex items-center justify-center px-3 py-1 min-h-11 sm:min-h-0 text-sm rounded ${customForm.type === t ? "bg-bg-surface text-fg font-medium" : "text-fg-muted"}`}
                >
                  {t === "oauth" ? "OAuth" : "Bearer token"}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <Label className="text-sm font-medium text-fg block mb-1">
              MCP Server
            </Label>
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
            <Input
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
                  <Input
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
                  <Label
                    htmlFor="vault-token-endpoint"
                    className="text-sm font-medium text-fg block mb-1"
                  >
                    Token endpoint
                  </Label>
                  <Input
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
                  <Label
                    htmlFor="vault-auth-method"
                    className="text-sm font-medium text-fg block mb-1"
                  >
                    Auth method
                  </Label>
                  <Select
                    id="vault-auth-method"
                    value={customForm.authMethod}
                    onValueChange={(value) =>
                      setCustomForm({
                        ...customForm,
                        authMethod: value as typeof customForm.authMethod,
                      })
                    }
                    className={inputCls}
                  >
                    <SelectOption value="client_secret_post">client_secret_post</SelectOption>
                    <SelectOption value="client_secret_basic">client_secret_basic</SelectOption>
                    <SelectOption value="none">none</SelectOption>
                  </Select>
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
                <Input
                  value={customForm.clientId}
                  onChange={(e) =>
                    setCustomForm({ ...customForm, clientId: e.target.value })
                  }
                  placeholder="Client ID"
                  aria-label="OAuth client ID"
                  className={inputCls}
                />
                <Input
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
            <Label
              htmlFor="vault-cli-id"
              className="text-sm text-fg-muted block mb-1"
            >
              CLI
            </Label>
            <Select
              id="vault-cli-id"
              value={cliForm.cli_id}
              onValueChange={(value) => {
                setCliForm({ ...cliForm, cli_id: value });
                setDeviceFlow(null);
              }}
              className={inputCls}
              disabled={deviceFlow?.status === "polling"}
            >
              {CAP_CLIS.map((c) => (
                <SelectOption key={c.cli_id} value={c.cli_id}>
                  {c.label}
                  {c.oauth ? " (OAuth supported)" : ""}
                </SelectOption>
              ))}
            </Select>
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
                  <div className="font-mono text-xl text-center tracking-widest text-fg py-2 select-all">
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
            <Label
              htmlFor="vault-cli-display-name"
              className="text-sm text-fg-muted block mb-1"
            >
              Display Name{" "}
              <span className="text-fg-subtle">(optional)</span>
            </Label>
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
            <Label
              htmlFor="vault-cli-token"
              className="text-sm text-fg-muted block mb-1"
            >
              Token{" "}
              <span className="text-fg-subtle">
                (write-only — leave blank to use OAuth above)
              </span>
            </Label>
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
