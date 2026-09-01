import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import type {
  BetaEnvironment,
  BetaLimitedNetworkParams,
  BetaPackages,
  BetaPackagesParams,
  BetaUnrestrictedNetwork,
  EnvironmentUpdateParams,
} from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { useApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "../components/Select";
import { toast } from "sonner";
import { Page } from "../components/Page";
import { Field } from "../components/Field";

// =================================================================
// Types
// =================================================================

/** Package managers exposed in the UI dropdown.
 *  NOTE: `gem` exists in the schema but is intentionally omitted —
 *  OMA's sandbox-base doesn't have ruby installed yet. If the env
 *  already carries gem packages we round-trip them on save so we
 *  don't silently drop user data. */
const MANAGERS = ["apt", "cargo", "go", "npm", "pip"] as const;
type Manager = (typeof MANAGERS)[number];
const ALL_MANAGERS = [...MANAGERS, "gem"] as const;
type AnyManager = (typeof ALL_MANAGERS)[number];

interface NetworkingConfig {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

type Env = BetaEnvironment;

// Local editor row shapes — packages and metadata both use ordered
// row arrays so the UI keeps a stable visual position while editing,
// rather than reshuffling whenever the underlying object's key order
// changes during normalize-on-save.
interface PackageRow {
  manager: Manager;
  /** Space-separated package specs, e.g. `pandas numpy==2.0` */
  packages: string;
}
interface MetadataRow {
  key: string;
  value: string;
}

// =================================================================
// Page
// =================================================================

export function EnvironmentDetail() {
  const { id } = useParams<{ id: string }>();
  const managedApi = useManagedApi();
  const nav = useNavigate();

  const [env, setEnv] = useState<Env | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Editable form state (kept separate from `env` so Cancel can revert
  // without re-fetching, and so we can diff to detect "dirty" later if
  // we ever want to show an unsaved-changes guard).
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [networking, setNetworking] = useState<NetworkingConfig>({
    type: "unrestricted",
    allow_mcp_servers: false,
    allow_package_managers: false,
    allowed_hosts: [],
  });
  const [allowedHostsText, setAllowedHostsText] = useState("");
  const [packageRows, setPackageRows] = useState<PackageRow[]>([]);
  const [metadataRows, setMetadataRows] = useState<MetadataRow[]>([]);
  // Initial load via TQ. Re-renders when the cache is populated; the
  // applyEnv side-effect below seeds the editable form state once per
  // fetched payload (id changes between renders → form re-seeds).
  const { data: fetchedEnv, error: fetchError } = useApiQuery<Env>(
    id ? `/v1/environments/${id}` : null,
  );
  useEffect(() => {
    if (fetchedEnv) applyEnv(fetchedEnv);
    // applyEnv only depends on `fetchedEnv` (it's a closure over the
    // setters which are stable from useState). Disabled the lint rule
    // because pulling applyEnv into deps would require memoizing every
    // setter chain — simpler to keep this an "on data arrival" effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchedEnv]);
  useEffect(() => {
    if (fetchError) {
      setLoadError(fetchError instanceof Error ? fetchError.message : "load failed");
    }
  }, [fetchError]);

  function applyEnv(e: Env) {
    setEnv(e);
    setName(e.name);
    setDescription(e.description ?? "");

    const cloud = e.config.type === "cloud" ? e.config : null;
    const net = cloud?.networking ?? { type: "unrestricted" as const };
    setNetworking({
      type: net.type,
      allow_mcp_servers:
        net.type === "limited" ? net.allow_mcp_servers : false,
      allow_package_managers:
        net.type === "limited" ? net.allow_package_managers : false,
      allowed_hosts: net.type === "limited" ? net.allowed_hosts : [],
    });
    setAllowedHostsText(
      net.type === "limited" ? net.allowed_hosts.join(", ") : "",
    );

    setPackageRows(packagesToRows(cloud?.packages));

    setMetadataRows(metadataToRows(e.metadata));
  }

  async function save() {
    if (!id || !env) return;
    setSaving(true);
    try {
      const config: EnvironmentUpdateParams["config"] =
        env.config.type === "cloud"
          ? {
              type: "cloud",
              packages: rowsToPackagesPatch(env.config.packages, packageRows),
              networking: buildNetworking(networking, allowedHostsText),
            }
          : { type: "self_hosted" };

      const body: EnvironmentUpdateParams = {
        name: name.trim(),
        description: description.trim() || null,
        config,
        metadata: rowsToMetadataPatch(env.metadata, metadataRows),
      };

      const updated = await managedApi.environments.update(id, body);
      applyEnv(updated);
      toast.success("Environment saved");
    } catch (err) {
      // useApi already toasts the underlying error; no duplicate here.
      void err;
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    nav("/environments");
  }

  if (loadError) {
    return (
      <div className="flex-1 p-8">
        <div className="bg-danger-subtle border border-danger/30 rounded-lg p-4 text-danger text-sm">
          {loadError}
        </div>
      </div>
    );
  }
  if (!env) {
    return <div className="flex-1 p-8 text-fg-muted">Loading...</div>;
  }

  return (
    <Page className="console-settings-page">
      <div className="console-settings-layout" data-testid="settings-layout">
        {/* Header: name input + Cloud badge + status */}
        <section className="console-settings-intro">
          <h1>{env.name || "Environment"}</h1>
          <div className="flex items-center gap-3 flex-wrap">
            <Label className="sr-only" htmlFor="env-name">Environment name</Label>
            <Input
              id="env-name"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 50))}
              className="border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] w-full sm:w-72"
              placeholder="environment name"
            />
            <span className="text-xs px-2 py-0.5 rounded border border-border bg-bg-surface text-fg-muted font-medium uppercase tracking-wider">
              {env.config.type === "cloud" ? "Cloud" : "Self hosted"}
            </span>
            <span className="text-fg-subtle" aria-hidden="true">
              <GlobeIcon />
            </span>
            {/* Status chip + build_error banner removed — env is stateless
                post setup-on-warmup migration; status is always "ready"
                (and the field is no longer surfaced on the wire). Package
                install errors surface on the first session that uses the
                env, not at env-creation time. */}
          </div>

          <div>
            <Label className="block text-sm font-medium text-fg mb-1.5" htmlFor="env-description">
              Description
            </Label>
            <Textarea
              id="env-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle resize-y"
              placeholder="What is this environment for?"
            />
          </div>
        </section>

        {/* Networking */}
        <SectionCard
          title="Networking"
          subtitle="Configure network access policies for sandboxes built from this environment."
        >
          <div className="space-y-4">
            <Field label="Type">
              <div className="w-48">
                <Select
                  value={networking.type}
                  onValueChange={(v) =>
                    setNetworking({
                      ...networking,
                      type: v as NetworkingConfig["type"],
                    })
                  }
                >
                  <SelectOption value="unrestricted">Unrestricted</SelectOption>
                  <SelectOption value="limited">Limited</SelectOption>
                </Select>
              </div>
            </Field>

            <Toggle
              label="Allow MCP server network access"
              checked={!!networking.allow_mcp_servers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_mcp_servers: v })
              }
            />
            <Toggle
              label="Allow package manager network access"
              checked={!!networking.allow_package_managers}
              onChange={(v) =>
                setNetworking({ ...networking, allow_package_managers: v })
              }
            />

            {networking.type === "limited" && (
              <Field
                label="Allowed Hosts"
                hint="Comma-separated hostnames (e.g. www.example1.com, api.example2.com)"
              >
                <Textarea
                  value={allowedHostsText}
                  onChange={(e) => setAllowedHostsText(e.target.value)}
                  rows={2}
                  className="w-full border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle resize-y"
                  placeholder="www.example1.com, www.example2.com"
                />
              </Field>
            )}
          </div>
        </SectionCard>

        {/* Packages */}
        <SectionCard
          title="Packages"
          subtitle="Specify packages and their versions to install when sandboxes are built."
          action={
            <IconButton
              label="Add package row"
              onClick={() =>
                setPackageRows((rows) => [...rows, { manager: "pip", packages: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          {packageRows.length === 0 ? (
            <p className="text-sm text-fg-subtle italic">
              No packages configured.
            </p>
          ) : (
            <div className="space-y-2">
              {packageRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <div className="w-24 shrink-0">
                    <Select
                      value={row.manager}
                      onValueChange={(v) =>
                        setPackageRows((rows) =>
                          rows.map((r, j) =>
                            j === i ? { ...r, manager: v as Manager } : r,
                          ),
                        )
                      }
                    >
                      {MANAGERS.map((m) => (
                        <SelectOption key={m} value={m}>{m}</SelectOption>
                      ))}
                    </Select>
                  </div>
                  <Input
                    value={row.packages}
                    onChange={(e) =>
                      setPackageRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, packages: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="package package==1.0.0"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono"
                  />
                  <IconButton
                    label="Remove package row"
                    onClick={() =>
                      setPackageRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {env.config.type === "cloud" && env.config.packages.gem.length > 0 && (
            <p className="text-sm text-fg-subtle mt-3 pt-3 border-t border-border">
              {env.config.packages.gem.length} legacy gem package(s) preserved (not editable
              — Ruby is not in sandbox-base yet).
            </p>
          )}
        </SectionCard>

        {/* Metadata */}
        <SectionCard
          title="Metadata"
          subtitle="Add custom key-value pairs to tag this environment."
          action={
            <IconButton
              label="Add metadata row"
              onClick={() =>
                setMetadataRows((rows) => [...rows, { key: "", value: "" }])
              }
            >
              <PlusIcon />
            </IconButton>
          }
        >
          {metadataRows.length === 0 ? (
            <p className="text-sm text-fg-subtle italic">No metadata.</p>
          ) : (
            <div className="space-y-2">
              {metadataRows.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) =>
                      setMetadataRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, key: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="client_key"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) =>
                      setMetadataRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, value: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="Value"
                    className="flex-1 min-w-0 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
                  />
                  <IconButton
                    label="Remove metadata row"
                    onClick={() =>
                      setMetadataRows((rows) => rows.filter((_, j) => j !== i))
                    }
                  >
                    <TrashIcon />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Footer actions */}
        <div className="console-settings-actions" data-testid="settings-actions">
          <Button onClick={save} loading={saving} disabled={!name.trim()}>
            Save changes
          </Button>
          <Button variant="ghost" onClick={cancel} disabled={saving}>
            Cancel
          </Button>
          <span className="text-xs text-fg-subtle ml-auto font-mono">
            {env.id}
          </span>
        </div>
      </div>
    </Page>
  );
}

// =================================================================
// Section / form primitives
// =================================================================

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="console-settings-section" data-testid="settings-section">
      <header className="console-settings-section-header">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold text-fg">{title}</h2>
          {subtitle && (
            <p className="text-sm text-fg-muted mt-0.5">{subtitle}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </header>
      <div className="console-settings-section-body">{children}</div>
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Label className="flex items-center justify-between gap-4 min-h-11 sm:min-h-0 cursor-pointer">
      <span className="text-sm text-fg">{label}</span>
      <Button variant="ghost"
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
          checked ? "bg-brand" : "bg-bg-surface border border-border"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-bg shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </Button>
    </Label>
  );
}

function IconButton({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
}) {
  return (
    <Button variant="ghost"
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 p-1.5 rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
    >
      {children}
    </Button>
  );
}

// =================================================================
// Icons
// =================================================================

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8h-7A2 2 0 0 1 6.5 20L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18" />
    </svg>
  );
}

// =================================================================
// Pure helpers — kept module-level so they can be unit-tested without
// pulling React in. They handle the schema <-> editor-row mapping for
// packages and metadata.
// =================================================================

function packagesToRows(packages: BetaPackages | undefined): PackageRow[] {
  if (!packages) return [];
  const rows: PackageRow[] = [];
  for (const m of MANAGERS) {
    const list = packages[m];
    if (list && list.length > 0) {
      rows.push({ manager: m, packages: list.join(" ") });
    }
  }
  return rows;
}

function rowsToPackagesPatch(
  original: BetaPackages,
  rows: PackageRow[],
): BetaPackagesParams {
  const out: BetaPackagesParams = { type: "packages" };
  for (const row of rows) {
    const specs = row.packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) continue;
    // Multiple rows with the same manager merge — user-friendly default
    // since the UI doesn't enforce uniqueness.
    const existing = out[row.manager] ?? [];
    out[row.manager] = [...existing, ...specs];
  }
  for (const manager of MANAGERS) {
    if (original[manager].length > 0 && out[manager] === undefined) {
      out[manager] = null;
    }
  }
  return out;
}

function metadataToRows(
  metadata: Record<string, string> | undefined,
): MetadataRow[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value,
  }));
}

function rowsToMetadataPatch(
  original: Record<string, string>,
  rows: MetadataRow[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  for (const key of Object.keys(original)) {
    if (!(key in out)) out[key] = null;
  }
  return out;
}

function buildNetworking(
  net: NetworkingConfig,
  allowedHostsText: string,
): BetaUnrestrictedNetwork | BetaLimitedNetworkParams {
  const hosts = allowedHostsText
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (net.type === "unrestricted") {
    return { type: "unrestricted" };
  }
  return {
    type: "limited",
    allow_mcp_servers: !!net.allow_mcp_servers,
    allow_package_managers: !!net.allow_package_managers,
    allowed_hosts: hosts,
  };
}
