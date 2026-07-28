import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, TrashIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";

interface Vault { id: string; name: string; created_at: string; archived_at?: string; }

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function VaultsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [showCreateVault, setShowCreateVault] = useState(false);
  const [vaultName, setVaultName] = useState("");

  // Server-driven filter state. Any change to these flows into vaultParams
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});

  const vaultParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
    }),
    [status, created.after, created.before],
  );

  const {
    items: vaults,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Vault>("/v1/vaults", { limit: 20, params: vaultParams });

  const createVault = async () => {
    await api("/v1/vaults", { method: "POST", body: JSON.stringify({ name: vaultName }) });
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
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
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
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const v = row.original;
          const archived = !!v.archived_at;
          return (
            <RowActionsMenu
              label={`Actions for ${v.name}`}
              actions={[
                {
                  label: "Archive",
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    if (!confirm(`Archive vault ${v.name}? All its credentials will also be archived. Archive is one-way.`)) return;
                    try {
                      await api(`/v1/vaults/${v.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      load();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (!confirm(`Delete vault ${v.name}? This can't be undone.`)) return;
                    try {
                      await api(`/v1/vaults/${v.id}`, { method: "DELETE" });
                      load();
                    } catch {}
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    [api, load],
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
      createLabel="+ New vault"
      onCreate={() => setShowCreateVault(true)}
      filters={filters}
      data={vaults}
      loading={loading}
      getRowId={(v) => v.id}
      onRowClick={(v) => nav(`/vaults/${v.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle="No vaults yet"
      emptyKind="vault"
      emptyAction={
        <Button onClick={() => setShowCreateVault(true)}>+ New vault</Button>
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
            <label htmlFor="vault-name" className="text-sm text-fg-muted block mb-1">Name</label>
            <input
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
