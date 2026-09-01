import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMemo, useState } from "react";
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
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function EnvironmentsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });

  // Server-driven filter state. Each piece flows into envsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  const envsParams = useMemo(
    () => ({
      ...(status !== "active" ? { include_archived: "true" } : {}),
    }),
    [status],
  );

  const {
    items: envs,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Env>("/v1/environments", { limit: 20, params: envsParams });
  const visibleEnvs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return envs.filter((environment) => {
      if (status === "active" && environment.archived_at) return false;
      if (status === "archived" && !environment.archived_at) return false;
      const createdAt = Date.parse(environment.created_at);
      if (created.after !== undefined && createdAt < created.after) return false;
      if (created.before !== undefined && createdAt > created.before) return false;
      return !needle || `${environment.name}\n${environment.id}`.toLocaleLowerCase().includes(needle);
    });
  }, [created.after, created.before, envs, search, status]);

  const create = async () => {
    await managedApi.environments.create({
      name: form.name,
      config: { type: "cloud" },
      description: form.description || undefined,
    });
    setShowCreate(false); setForm({ name: "", description: "" }); load();
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu.
  const columns = useMemo<ColumnDef<Env>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
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
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "type",
        accessorFn: (e) => (e.config?.type as string) || "cloud",
        header: "Type",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {(row.original.config?.type as string) || "cloud"}
          </span>
        ),
      },
      {
        id: "status",
        accessorFn: (e) => (e.archived_at ? "archived" : "active"),
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.archived_at
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.archived_at ? "archived" : "active"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (e) => e.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [load],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾".
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
    <>
      <FilterChip
        label="Status"
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
            options={STATUS_OPTIONS}
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
            searchPlaceholder="Status..."
          />
        </PopoverContent>
      </FilterChip>

      <CreatedFilterChip value={created} onChange={setCreated} />
    </>
  );

  return (
    <DataTable<Env>
      createLabel={t.environments.newEnvironment}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.environments.searchEnvironments}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={visibleEnvs}
      loading={loading}
      getRowId={(e) => e.id}
      onRowClick={(e) => nav(`/environments/${e.id}`)}
      rowActions={(environment) => [
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
      ]}
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
        subtitle="Environments provide isolated sandboxes for code execution."
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={create} disabled={!form.name}>Create</Button>
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
            <span className="text-sm text-fg-muted block mb-1">Hosting Type</span>
            <Select value="cloud" onValueChange={() => {}} disabled>
              <SelectOption value="cloud">Cloud</SelectOption>
            </Select>
            <p className="text-xs text-fg-subtle mt-1">This cannot be changed after creation.</p>
          </div>
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
