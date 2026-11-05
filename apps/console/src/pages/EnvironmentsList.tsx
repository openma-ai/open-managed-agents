import { RowActionsMenu } from "../components/TableRowActions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, TrashIcon } from "lucide-react";
import type { BetaEnvironment as Env } from "@anthropic-ai/sdk/resources/beta/environments/environments";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { Select, SelectOption } from "../components/Select";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";
import {
  DEFAULT_SANDBOX_IMAGE,
  SandboxImageSelect,
  useSandboxImages,
} from "../components/SandboxImageSelect";
import { RuntimeAttachmentFields } from "../components/RuntimeAttachmentFields";
import { parseEnvOverlay } from "../lib/env-overlay";
import type { OpenMaEnvironment } from "../lib/managed-api";

type StatusValue = "any" | "active" | "archived";
type Hosting = "cloud" | "runtime";

const EMPTY_FORM = {
  name: "",
  description: "",
  hosting: "cloud" as Hosting,
  sandboxImage: DEFAULT_SANDBOX_IMAGE,
  runtimeId: "",
  placement: "host" as "host" | "sandbox",
  envText: "",
};

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

/** "runtime" for an Environment attached to a paired machine, else the CMA type. */
function hostingLabel(environment: Env): string {
  const runtime = (environment as OpenMaEnvironment)._oma?.runtime;
  if (runtime) return `runtime · ${runtime.placement ?? "host"}`;
  return (environment.config?.type as string) || "cloud";
}

export function EnvironmentsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const sandboxImages = useSandboxImages();
  const overlay = parseEnvOverlay(form.envText);
  const canCreate =
    form.name.trim() !== "" &&
    (form.hosting === "cloud" || (form.runtimeId !== "" && overlay.errors.length === 0));

  // Server-driven filter state. Each piece flows into envsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [search, setSearch] = useState("");

  const envsParams = useMemo(
    () => status !== "active" ? { include_archived: "true" } : {},
    [status],
  );

  const {
    items: envs,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
    error,
  } = useInfiniteApiQuery<Env>("/v1/environments", { limit: 20, params: envsParams });
  useEffect(() => { if ((search.trim() || status === "archived") && hasMore && !isLoadingMore && !error) loadMore(); }, [search, status, hasMore, isLoadingMore, error, loadMore]);
  const visibleEnvs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return envs.filter((environment) => {
      if (status === "active" && environment.archived_at) return false;
      if (status === "archived" && !environment.archived_at) return false;
      return !needle || `${environment.name}\n${environment.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [envs, search, status]);

  const create = async () => {
    await managedApi.environments.create(
      form.hosting === "runtime"
        ? {
            // The paired Runtime owns both host and sandbox execution.
            name: form.name,
            config: { type: "self_hosted" },
            description: form.description || undefined,
            _oma: { runtime: { runtime_id: form.runtimeId, placement: form.placement, env: overlay.env } },
          }
        : {
            name: form.name,
            config: { type: "cloud" },
            description: form.description || undefined,
            // Omitted for the default image so the request stays plain CMA.
            ...(form.sandboxImage !== DEFAULT_SANDBOX_IMAGE && {
              _oma: { sandbox_image: form.sandboxImage },
            }),
          },
    );
    setShowCreate(false);
    setForm(EMPTY_FORM);
    load();
  };

  const actionsFor = (environment: Env) => [
    {
      label: "Archive",
      icon: <ArchiveIcon className="size-4" />,
      disabled: Boolean(environment.archived_at),
      onSelect: async () => {
        try {
          await managedApi.environments.archive(environment.id);
          load();
        } catch {}
      },
    },
    {
      label: "Delete",
      icon: <TrashIcon className="size-4" />,
      destructive: true,
      onSelect: async () => {
        if (!confirm(`Delete environment ${environment.name}? This can't be undone.`)) return;
        try {
          await managedApi.environments.delete(environment.id);
          load();
        } catch {}
      },
    },
  ];

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu.
  const columns: ColumnDef<Env>[] = [
    {
      id: "id",
      accessorKey: "id",
      header: t.common.id,
      cell: ({ row }) => (
        <span title={row.original.id} className="font-mono text-xs text-fg-muted">
          {row.original.id}
        </span>
      ),
      enableHiding: false,
    },
    {
      id: "name",
      accessorKey: "name",
      header: t.common.name,
      cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
      enableHiding: false,
    },
    {
      id: "type",
      accessorFn: hostingLabel,
      header: t.environments.type,
      cell: ({ row }) => (
        <span className="text-fg-muted">{hostingLabel(row.original)}</span>
      ),
    },
    { id: "scope", header: t.environments.scope, cell: ({row}) => row.original.scope === "organization" ? t.deployments.organization : row.original.scope === "account" ? t.deployments.account : "—" },
    { id: "updated", header: t.environments.updatedAt, cell: ({row}) => new Date(row.original.updated_at).toLocaleDateString(undefined, {month: "short", day: "numeric"}) },
    { id: "archived", header: t.environments.archivedAt, cell: ({row}) => row.original.archived_at ? new Date(row.original.archived_at).toLocaleDateString() : "" },
    { id: "actions", header: () => <span className="sr-only">{t.common.actions}</span>, size: 48, cell: ({row}) => <RowActionsMenu label={`${t.common.actions}: ${row.original.name}`} actions={actionsFor(row.original)} /> },
  ];

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾".
  const statusDisplay =
    status === "any" ? undefined : t.deployments[status];

  const filters = (
    <>
      <FilterChip
        label={t.deployments.status}
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-48 p-0"
        >
          <FacetedFilter
            options={STATUS_OPTIONS.map(option => ({...option, label: option.value === "any" ? t.deployments.all : t.deployments[option.value]}))}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder={t.deployments.status}
          />
        </PopoverContent>
      </FilterChip>


    </>
  );

  return (
    <DataTable<Env>
      selectable
      title={t.nav.environments}
      subtitle={t.environments.subtitle}
      createLabel={t.environments.createEnvironment}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.deployments.searchPlaceholder}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleEnvs}
      loading={loading}
      getRowId={(e) => e.id}
      onRowClick={(e) => nav(`/environments/${e.id}`)}
      rowActions={actionsFor}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? t.environments.noMatchingEnvironments : t.environments.noEnvironmentsYet}
      emptyKind="env"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>{t.environments.newEnvironment}</Button>
      }
      emptySubtitle={
        search
          ? t.agents.tryDifferentSearch
          : t.environments.noEnvironmentsYet
      }
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="Add Environment"
        subtitle="Provision an isolated sandbox, or run on a machine you already paired."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!canCreate}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="env-create-name" className="text-sm text-fg-muted block mb-1">Name</Label>
            <Input
              id="env-create-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value.slice(0, 50) })}
              className="w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm outline-none focus:border-brand bg-bg text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
              placeholder="production"
            />
            <p className="text-xs text-fg-subtle mt-1">{form.name.length}/50 characters</p>
          </div>
          <div>
            <Label htmlFor="env-create-hosting" className="text-sm text-fg-muted block mb-1">Hosting Type</Label>
            <Select
              id="env-create-hosting"
              value={form.hosting}
              onValueChange={(hosting) => setForm({ ...form, hosting: hosting as Hosting })}
            >
              <SelectOption value="cloud">Cloud — provision a sandbox</SelectOption>
              <SelectOption value="runtime">Attach to existing Runtime</SelectOption>
            </Select>
            <p className="text-xs text-fg-subtle mt-1">This cannot be changed after creation.</p>
          </div>
          {form.hosting === "runtime" && (
            <RuntimeAttachmentFields
              idPrefix="env-create"
              runtimeId={form.runtimeId}
              placement={form.placement}
              onPlacementChange={(placement) => setForm({ ...form, placement })}
              onRuntimeIdChange={(runtimeId) => setForm({ ...form, runtimeId })}
              envText={form.envText}
              onEnvTextChange={(envText) => setForm({ ...form, envText })}
            />
          )}
          {form.hosting === "cloud" && sandboxImages.length > 0 && (
            <div>
              <Label htmlFor="env-create-sandbox-image" className="text-sm text-fg-muted block mb-1">Sandbox image</Label>
              <SandboxImageSelect
                id="env-create-sandbox-image"
                images={sandboxImages}
                value={form.sandboxImage}
                onValueChange={(sandboxImage) => setForm({ ...form, sandboxImage })}
              />
            </div>
          )}
          <div>
            <Label htmlFor="env-create-description" className="text-sm text-fg-muted block mb-1">Description <span className="text-fg-subtle">(optional)</span></Label>
            <Textarea
              id="env-create-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full border border-border rounded-md px-3 py-2 text-sm outline-none focus:border-brand bg-bg text-fg resize-none transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
              placeholder="Production environment for customer-facing agents..."
            />
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}
