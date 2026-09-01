import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, TrashIcon } from "lucide-react";
import type { BetaManagedAgentsVault as Vault } from "@anthropic-ai/sdk/resources/beta/vaults/vaults";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
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

export function VaultsList() {
  const managedApi = useManagedApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");

  // Server-driven filter state. Any change to these flows into vaultParams
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const vaultParams = useMemo(
    () => ({
      ...(status !== "active" ? { include_archived: "true" } : {}),
    }),
    [status],
  );

  const {
    items: vaults,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Vault>("/v1/vaults", { limit: 20, params: vaultParams });
  const visibleVaults = useMemo(
    () =>
      vaults.filter((vault) => {
        if (status === "active" && vault.archived_at) return false;
        if (status === "archived" && !vault.archived_at) return false;
        const createdAt = Date.parse(vault.created_at);
        if (created.after !== undefined && createdAt < created.after) return false;
        if (created.before !== undefined && createdAt > created.before) return false;
        return true;
      }),
    [created.after, created.before, status, vaults],
  );

  const createVault = async () => {
    await managedApi.vaults.create({ display_name: vaultName });
    setShowCreateVault(false); setVaultName(""); load();
  };

  const inputCls = "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Vault>[]>(
    () => [
      {
        id: "name",
        accessorKey: "display_name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.display_name}</span>,
        enableHiding: false,
      },
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
        id: "status",
        accessorFn: (v) => (v.archived_at ? "archived" : "active"),
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
        accessorFn: (v) => v.created_at,
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

  // Active-filter chip display — null at the default so the chip reads
  // "Status ▾" rather than "Status: All ▾". Mirrors AgentsList.
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
    <DataTable<Vault>
      createLabel={t.vaults.newVault}
      onCreate={() => setShowCreateVault(true)}
      filters={filters}
      data={visibleVaults}
      loading={loading}
      getRowId={(v) => v.id}
      onRowClick={(v) => nav(`/vaults/${v.id}`)}
      rowActions={(vault) => [
        {
          label: "Archive",
          icon: <ArchiveIcon className="size-4" />,
          disabled: Boolean(vault.archived_at),
          onSelect: async () => {
            if (!confirm(`Archive vault ${vault.display_name}? All its credentials will also be archived. Archive is one-way.`)) return;
            try {
              await managedApi.vaults.archive(vault.id);
              load();
            } catch {}
          },
        },
        {
          label: "Delete",
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: async () => {
            if (!confirm(`Delete vault ${vault.display_name}? This can't be undone.`)) return;
            try {
              await managedApi.vaults.delete(vault.id);
              load();
            } catch {}
          },
        },
      ]}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={t.vaults.noVaultsYet}
      emptyKind="vault"
      emptyAction={
        <Button onClick={() => setShowCreateVault(true)}>{t.vaults.newVault}</Button>
      }
      columns={columns}
    >
      {/* Create Vault */}
      <Modal
        open={showCreateVault}
        onClose={() => setShowCreateVault(false)}
        title="New Vault"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCreateVault(false)}>Cancel</Button>
            <Button onClick={createVault} disabled={!vaultName}>Create</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="vault-name" className="text-sm text-fg-muted block mb-1">Name</Label>
            <Input
              id="vault-name"
              value={vaultName}
              onChange={(e) => setVaultName(e.target.value.slice(0, 30))}
              className={inputCls}
              placeholder="My Vault"
            />
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}
