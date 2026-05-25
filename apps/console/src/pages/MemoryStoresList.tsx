import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, TrashIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";

interface MemoryStore {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  archived_at?: string;
}

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function MemoryStoresList() {
  const { api } = useApi();
  const nav = useNavigate();

  // Server-driven filter state. Each piece flows into storesParams below
  // → useApiQuery refetches on params change → the list reflects exactly
  // what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  // Search box state is wired but not sent to the server: /v1/memory_stores
  // has no `q` column yet (name lives only in the row itself, no JSON
  // blob like /v1/agents). The input stays visible so the toolbar shape
  // matches every other list page; the moment the backend gets a hot
  // column, drop it into `storesParams` and this comment with it. No
  // client-side filter() — that would lie about which rows the server
  // actually returned.
  const [search, setSearch] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const storesParams = useMemo(
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
    data: resp,
    isLoading: loading,
    refetch,
  } = useApiQuery<{ data: MemoryStore[] }>("/v1/memory_stores", storesParams);
  const stores = resp?.data ?? [];

  const createStore = async () => {
    setFormError(null);
    try {
      await api("/v1/memory_stores", {
        method: "POST",
        body: JSON.stringify({ name: formName, description: formDesc || undefined }),
      });
      setShowCreate(false);
      setFormName("");
      setFormDesc("");
      void refetch();
    } catch (e) {
      setFormError(errMsg(e));
    }
  };

  // TanStack column defs. Required columns (name) opt out of the Columns
  // hide menu so the user can't end up with a table that has nothing
  // identifying.
  const columns = useMemo<ColumnDef<MemoryStore>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <span className="font-medium text-fg">{row.original.name}</span>
        ),
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
      },
      {
        id: "status",
        accessorFn: (s) => (s.archived_at ? "archived" : "active"),
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
        accessorFn: (s) => s.created_at,
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
          const s = row.original;
          const archived = !!s.archived_at;
          return (
            <RowActionsMenu
              label={`Actions for ${s.name}`}
              actions={[
                {
                  label: "Archive",
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    try {
                      await api(`/v1/memory_stores/${s.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      void refetch();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (!confirm(`Delete memory store ${s.name}? This can't be undone.`)) return;
                    try {
                      await api(`/v1/memory_stores/${s.id}`, { method: "DELETE" });
                      void refetch();
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
    [api, refetch],
  );

  // Active-filter chip display — kept undefined when matching the default
  // so the chip reads "Status ▾" rather than "Status: All ▾".
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

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  return (
    <DataTable<MemoryStore>
      createLabel="+ New store"
      onCreate={() => {
        setShowCreate(true);
        setFormError(null);
      }}
      searchPlaceholder="Search memory stores..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={stores}
      loading={loading}
      getRowId={(s) => s.id}
      onRowClick={(s) => nav(`/memory/${s.id}`)}
      emptyTitle="No memory stores"
      emptyKind="memory"
      emptyAction={
        <Button
          onClick={() => {
            setShowCreate(true);
            setFormError(null);
          }}
        >
          + New store
        </Button>
      }
      emptySubtitle="Create a memory store to give your agents long-term context across sessions."
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setFormError(null);
        }}
        title="New Memory Store"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setShowCreate(false);
                setFormError(null);
              }}
            >
              Cancel
            </Button>
            <Button onClick={createStore} disabled={!formName}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {formError}
            </div>
          )}
          <div>
            <label
              htmlFor="memory-store-name"
              className="text-sm text-fg-muted block mb-1"
            >
              Name
            </label>
            <input
              id="memory-store-name"
              placeholder="e.g. User Preferences"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label
              htmlFor="memory-store-description"
              className="text-sm text-fg-muted block mb-1"
            >
              Description <span className="text-fg-subtle">(optional)</span>
            </label>
            <input
              id="memory-store-description"
              placeholder="What's stored here?"
              value={formDesc}
              onChange={(e) => setFormDesc(e.target.value)}
              className={inputCls}
            />
          </div>
        </div>
      </Modal>
    </DataTable>
  );
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unknown error";
}
