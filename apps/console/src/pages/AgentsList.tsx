import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Button } from "@/components/ui/button";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";

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

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");

  // Main agents table — paginated. Filter changes (showArchived) reset to
  // page 0 automatically.
  const agentsParams = useMemo(
    () => ({ include_archived: showArchived ? "true" : undefined }),
    [showArchived],
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
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200");
      setAllAgents(all.data);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          setCustomSkills(sk.data);
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          setModelCards(mc.data);
        })().catch((e) => console.warn("[AgentsList] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<{ runtimes: Runtime[] }>("/v1/runtimes");
          setRuntimes(rt.runtimes);
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

  // TanStack column defs. Sorting / per-column filtering operate on
  // loaded rows; server-side filters still flow through the toolbar
  // search box + `agentsParams`. Required columns (id, name) opt out
  // of hiding so the "Columns" dropdown can't accidentally leave the
  // table with nothing identifying. Status / Created are date-y /
  // enum-y enough that text-filter is mostly noise — disable their
  // column filter; sorting is still meaningful so leave that on.
  const columns = useMemo<ColumnDef<Agent>[]>(
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
        id: "model",
        accessorFn: (a) => modelStr(a.model),
        header: "Model",
        cell: ({ row }) => (
          <span className="text-fg-muted">{modelStr(row.original.model)}</span>
        ),
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
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
        enableColumnFilter: false,
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
        enableColumnFilter: false,
      },
    ],
    [],
  );

  const displayed = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  return (
    <DataTable<Agent>
      title="Agents"
      subtitle="Create and manage autonomous agents."
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Go to agent ID..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={
        <label className="flex items-center gap-2 text-sm text-fg-muted cursor-pointer select-none shrink-0">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="accent-brand"
          />
          Show archived
        </label>
      }
      data={displayed}
      loading={loading}
      getRowId={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching agents" : "No agents yet"}
      emptyKind="agent"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>+ New agent</Button>
      }
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>Create your first agent to get started.</p>
            <button
              onClick={() => nav("/")}
              className="inline-flex items-center min-h-11 sm:min-h-0 mt-3 text-sm text-brand hover:underline"
            >
              Get started with the quickstart guide →
            </button>
          </>
        )
      }
      columns={columns}
    >
      <AgentFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refreshAgents}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
        runtimes={runtimes}
      />
    </DataTable>
  );
}
