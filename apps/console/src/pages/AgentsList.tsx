import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ArchiveIcon, PencilIcon, TrashIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip, CreatedFilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";
import { useI18n } from "../i18n";

type Runtime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  /** Skills daemon detected locally on the user's machine, keyed by acp
   *  agent id. Source for the blocklist multi-select that appears when
   *  the user picks an acp agent. */
  local_skills?: Record<
    string,
    Array<{
      id: string;
      name?: string;
      description?: string;
      source?: string;
      source_label?: string;
    }>
  >;
};

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const { t } = useI18n();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  // Server-driven filter state. Each piece flows into agentsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  // Main agents table — paginated. Any change to these params resets to
  // page 0 automatically (paramsKey is part of the query key).
  const agentsParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, created.after, created.before, search],
  );
  const {
    items: agents,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshAgents,
  } = useInfiniteApiQuery<Agent>("/v1/agents", { limit: 20, params: agentsParams });

  // Aux fetches that aren't paginated UI surfaces — refreshed on mount and
  // after agent CRUD. Pull all agents (for the callable-agents dropdown)
  // separately so it isn't constrained by the main list's page size.
  //
  // Failures of the secondary fetches (skills / model cards / runtimes) are
  // tolerated and logged: missing data degrades a dropdown but shouldn't
  // block agent CRUD. Failures of the primary `/v1/agents` call surface
  // via the toast that `useApi` raises automatically; setting `auxLoading`
  // back to false in `finally` keeps the spinner from getting stuck.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any");
      setAllAgents(all.data ?? []);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          setCustomSkills(sk.data ?? []);
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          setModelCards(mc.data ?? []);
        })().catch((e) => console.warn("[AgentsList] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<{ runtimes: Runtime[] }>("/v1/runtimes");
          setRuntimes(rt.runtimes ?? []);
        })().catch((e) => console.warn("[AgentsList] /v1/runtimes aux fetch failed", e)),
      ]);
    } finally {
      setAuxLoading(false);
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  const modelStr = (m: Agent["model"]) => (typeof m === "string" ? m : m?.id || "");

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end
  // up with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
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
        id: "model",
        accessorFn: (a) => modelStr(a.model),
        header: t.common.model,
        cell: ({ row }) => (
          <span className="text-fg-muted">{modelStr(row.original.model)}</span>
        ),
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
        header: t.common.status,
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.archived_at
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.archived_at ? t.common.archived : t.common.active}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: t.common.created,
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
          const a = row.original;
          const archived = !!a.archived_at;
          return (
            <RowActionsMenu
              label={`${t.common.actions} for ${a.name}`}
              actions={[
                {
                  label: t.agents.editAgent,
                  icon: <PencilIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    try {
                      // Fetch fresh so the form has full config + current
                      // version (list rows can be stale within TQ staleTime).
                      const fresh = await api<Agent>(`/v1/agents/${a.id}`);
                      setEditingAgent(fresh);
                    } catch {
                      setEditingAgent(a);
                    }
                  },
                },
                {
                  label: archived ? t.common.unarchive : t.common.archive,
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  onSelect: async () => {
                    try {
                      await api(`/v1/agents/${a.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      refreshAgents();
                    } catch {}
                  },
                },
                {
                  label: t.common.delete,
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (!confirm(`${t.agents.deleteAgent} ${a.name}? ${t.agents.confirmDelete}`)) return;
                    try {
                      await api(`/v1/agents/${a.id}`, { method: "DELETE" });
                      refreshAgents();
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
    [api, refreshAgents],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾". The clear-X
  // only renders when the chip is in non-default state.
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
        {/* Status uses the shadcn faceted-filter pattern (Command
            inside Popover). The Command primitive gives type-ahead
            search even for 3 options — pays off the moment a page
            picks an enum with 10+ values. */}
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
    <DataTable<Agent>
      createLabel={t.agents.newAgent}
      onCreate={() => setShowCreate(true)}
      searchPlaceholder={t.agents.searchAgents}
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={agents}
      loading={loading}
      getRowId={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? t.agents.noMatchingAgents : t.agents.noAgentsYet}
      emptyKind="agent"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>{t.agents.newAgent}</Button>
      }
      emptySubtitle={
        search ? (
          t.agents.tryDifferentSearch
        ) : (
          <>
            <p>{t.agents.createFirstAgent}</p>
            <button
              onClick={() => nav("/")}
              className="inline-flex items-center min-h-11 sm:min-h-0 mt-3 text-sm text-brand hover:underline"
            >
              {t.agents.getStartedGuide}
            </button>
          </>
        )
      }
      columns={columns}
    >
      <AgentFormDialog
        open={showCreate || !!editingAgent}
        onClose={() => {
          setShowCreate(false);
          setEditingAgent(null);
        }}
        onCreated={() => {
          setShowCreate(false);
          refreshAgents();
          void loadAux();
        }}
        agent={editingAgent}
        onUpdated={() => {
          setEditingAgent(null);
          refreshAgents();
          void loadAux();
        }}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
        runtimes={runtimes}
      />
    </DataTable>
  );
}
