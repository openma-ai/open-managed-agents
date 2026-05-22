import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { ListPage } from "../components/ListPage";
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

  const displayed = agents.filter((a) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return a.id.toLowerCase().includes(q) || a.name.toLowerCase().includes(q);
  });

  return (
    <ListPage<Agent>
      title="Agents"
      subtitle="Create and manage autonomous agents."
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Go to agent ID..."
      searchValue={search}
      onSearchChange={setSearch}
      showArchived={showArchived}
      onShowArchivedChange={setShowArchived}
      data={displayed}
      loading={loading}
      getRowKey={(a) => a.id}
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
      columns={[
        {
          key: "id",
          label: "ID",
          className: "font-mono text-xs text-fg-muted truncate max-w-[180px]",
          render: (a) => <span title={a.id}>{a.id}</span>,
        },
        { key: "name", label: "Name", className: "font-medium text-fg" },
        {
          key: "model",
          label: "Model",
          className: "text-fg-muted",
          render: (a) => modelStr(a.model),
        },
        {
          key: "status",
          label: "Status",
          render: (a) => (
            <span
              className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
                a.archived_at
                  ? "bg-bg-surface text-fg-subtle"
                  : "bg-success-subtle text-success"
              }`}
            >
              {a.archived_at ? "archived" : "active"}
            </span>
          ),
        },
        {
          key: "created",
          label: "Created",
          className: "text-fg-muted",
          render: (a) => new Date(a.created_at).toLocaleDateString(),
        },
      ]}
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
    </ListPage>
  );
}
