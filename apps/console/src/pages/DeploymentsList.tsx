import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ArchiveIcon,
  CalendarClockIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RotateCcwIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { RowActionsMenu } from "../components/TableRowActions";
import { PopoverContent } from "@/components/ui/popover";

import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import type { RowAction } from "../components/RowContextMenu";
import { useI18n } from "../i18n";
import { useInfiniteApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useManagedApi } from "../lib/useManagedApi";
import {
  deploymentCreator,
  deploymentState,
  fill,
  TriggerSummary,
  type Deployment,
} from "./deployments/shared";

type StatusValue = "active" | "paused" | "all";

interface AgentLite {
  id: string;
  name: string;
}

export function DeploymentsList() {
  const managedApi = useManagedApi();
  const queryClient = useQueryClient();
  const nav = useNavigate();
  const { t, locale } = useI18n();
  const m = t.deployments;

  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusValue>("active");
  const [agentId, setAgentId] = useState("");
  const [createdBy, setCreatedBy] = useState("");
  const [agents, setAgents] = useState<AgentLite[]>([]);

  useEffect(() => {
    let cancelled = false;
    managedApi.agents
      .list({ limit: 200, include_archived: true })
      .then((page) => {
        if (!cancelled) setAgents(page.data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [managedApi]);

  // Status and agent are server filters; archived deployments stay hidden
  // because the list never asks for `include_archived`.
  const params = useMemo(
    () => ({
      ...(status !== "all" ? { status } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
    }),
    [status, agentId],
  );
  const {
    items: deployments,
    isLoading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    error,
  } = useInfiniteApiQuery<Deployment>("/v1/deployments", { limit: 20, params });

  useEffect(() => {
    if ((search.trim() || createdBy) && hasMore && !isLoadingMore && !error) loadMore();
  }, [search, createdBy, hasMore, isLoadingMore, error, loadMore]);

  const agentNames = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents],
  );

  // The API has no author filter, so "Created by" narrows the loaded page
  // by the creator the Console stamped into metadata.
  const creators = useMemo(() => {
    const seen = new Set<string>();
    for (const deployment of deployments) {
      const creator = deploymentCreator(deployment);
      if (creator) seen.add(creator);
    }
    return [...seen].sort();
  }, [deployments]);

  const visible = useMemo(() => {
    const needle = search.trim();
    const lowered = needle.toLocaleLowerCase();
    return deployments.filter((deployment) => {
      if (createdBy && deploymentCreator(deployment) !== createdBy) return false;
      if (!needle) return true;
      return deployment.id === needle || deployment.name.toLocaleLowerCase().includes(lowered);
    });
  }, [createdBy, deployments, search]);

  const runNow = async (deployment: Deployment) => {
    try {
      await managedApi.deployments.run(deployment.id);
      toast.success(m.runStarted);
    } catch {
      // The API client already toasts the failure.
    }
  };

  const setPaused = async (deployment: Deployment, paused: boolean) => {
    try {
      if (paused) await managedApi.deployments.pause(deployment.id);
      else await managedApi.deployments.unpause(deployment.id);
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
    } catch {
      // The API client already toasts the failure.
    }
  };

  const archive = async (deployment: Deployment) => {
    if (!window.confirm(fill(m.confirmArchive, { name: deployment.name }))) return;
    try {
      await managedApi.deployments.archive(deployment.id);
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
    } catch {
      // The API client already toasts the failure.
    }
  };

  const actionsFor = (deployment: Deployment): RowAction[] => {
    const state = deploymentState(deployment);
    return [
      {
        label: m.runNow,
        icon: <PlayIcon className="size-4" />,
        disabled: state !== "active",
        onSelect: () => void runNow(deployment),
      },
      state === "paused"
        ? {
            label: m.resume,
            icon: <RotateCcwIcon className="size-4" />,
            onSelect: () => void setPaused(deployment, false),
          }
        : {
            label: m.pause,
            icon: <PauseIcon className="size-4" />,
            disabled: state === "archived",
            onSelect: () => void setPaused(deployment, true),
          },
      {
        label: m.archive,
        icon: <ArchiveIcon className="size-4" />,
        destructive: true,
        disabled: state === "archived",
        onSelect: () => void archive(deployment),
      },
    ];
  };

  const columns: ColumnDef<Deployment>[] = [
    {
      id: "id",
      accessorKey: "id",
      header: t.common.id,
      size: 240,
      enableHiding: false,
      cell: ({ row }) => (
        <span title={row.original.id} className="font-mono text-xs text-fg-muted">
          {row.original.id}
        </span>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: t.common.name,
      enableHiding: false,
      cell: ({ row }) => (
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-fg">{row.original.name}</span>
          {row.original.status === "paused" && (
            <span className="inline-flex items-center text-xs px-2 py-0.5 rounded-full bg-warning-subtle text-warning">
              {m.paused}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "agent",
      accessorFn: (deployment) => deployment.agent.id,
      header: m.agent,
      cell: ({ row }) => {
        const { id } = row.original.agent;
        return (
          <span className="truncate text-fg-muted" title={id}>
            {agentNames.get(id) ?? <span className="font-mono text-xs">{id}</span>}
          </span>
        );
      },
    },
    {
      id: "trigger",
      accessorFn: (deployment) => deployment.schedule?.expression ?? "manual",
      header: m.trigger,
      cell: ({ row }) => <TriggerSummary deployment={row.original} m={m} />,
    },
    {
      id: "created_by",
      accessorFn: (deployment) => deploymentCreator(deployment) ?? "",
      header: m.createdBy,
      cell: ({ row }) => (
        <span className="truncate text-fg-muted">{deploymentCreator(row.original) ?? "—"}</span>
      ),
    },
    {
      id: "created",
      accessorFn: (deployment) => deployment.created_at,
      header: t.common.created,
      size: 120,
      cell: ({ row }) => (
        <span className="text-fg-muted" title={row.original.created_at}>
          {new Date(row.original.created_at).toLocaleDateString(locale)}
        </span>
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">{t.common.actions}</span>,
      size: 56,
      enableHiding: false,
      cell: ({ row }) => (
        <RowActionsMenu
          label={`${t.common.actions}: ${row.original.name}`}
          actions={actionsFor(row.original)}
        />
      ),
    },
  ];

  const statusOptions = [
    { value: "active", label: m.active },
    { value: "paused", label: m.paused },
    { value: "all", label: m.all },
  ];
  const agentOptions = agents.map((agent) => ({ value: agent.id, label: `${agent.name} (${agent.id})` }));
  const creatorOptions = [{ value: "", label: m.anyone }, ...creators.map((c) => ({ value: c, label: c }))];

  const filters = (
    <>
      <FilterChip
        label={m.createdBy}
        active={Boolean(createdBy)}
        display={createdBy || m.anyone}
        onClear={() => setCreatedBy("")}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-64 p-0">
          <FacetedFilter
            options={creatorOptions}
            value={createdBy}
            onValueChange={setCreatedBy}
            searchPlaceholder={`${m.createdBy}...`}
          />
        </PopoverContent>
      </FilterChip>
      <FilterChip
        label={m.agent}
        active={Boolean(agentId)}
        display={agentId ? agentNames.get(agentId) ?? agentId : m.all}
        onClear={() => setAgentId("")}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-72 p-0">
          <FacetedFilter
            options={agentOptions}
            value={agentId}
            onValueChange={setAgentId}
            searchPlaceholder={`${m.agent}...`}
          />
        </PopoverContent>
      </FilterChip>
      <FilterChip
        label={m.status}
        active={status !== "active"}
        display={statusOptions.find((option) => option.value === status)?.label}
        onClear={() => setStatus("active")}
      >
        <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
          <FacetedFilter
            options={statusOptions}
            value={status}
            onValueChange={(value) => setStatus(value as StatusValue)}
            searchPlaceholder={`${m.status}...`}
          />
        </PopoverContent>
      </FilterChip>
    </>
  );

  const filtered = Boolean(search.trim() || createdBy || agentId || status !== "active");
  const create = () => nav("/deployments/new");

  return (
    <div className="flex h-full min-h-0 flex-col">
      {error && (
        <div role="alert" className="pl-[var(--list-content-inset)] pr-[var(--list-frame-inset)] py-3 text-sm text-danger">
          {m.loadFailed} <Button variant="outline" size="sm" onClick={refresh}>{m.retry}</Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <DataTable<Deployment>
          selectable
          title={t.nav.deployments}
          subtitle={m.subtitle}
          createLabel={m.createDeployment}
          onCreate={create}
          searchPlaceholder={m.searchPlaceholder}
          searchValue={search}
          onSearchChange={setSearch}
          filters={filters}
          columns={columns}
          data={visible}
          loading={isLoading}
          getRowId={(deployment) => deployment.id}
          onRowClick={(deployment) => nav(`/deployments/${deployment.id}`)}
          rowActions={actionsFor}
          hasMore={hasMore}
          loadingMore={isLoadingMore}
          onLoadMore={loadMore}
          emptyTitle={filtered ? m.noMatching : m.emptyTitle}
          emptySubtitle={filtered ? m.tryDifferentFilters : m.emptyBody}
          emptyIcon={<CalendarClockIcon className="size-9" aria-hidden="true" />}
          emptyAction={!filtered && <Button variant="outline" onClick={create}><PlusIcon className="size-4" aria-hidden="true" />{m.createDeployment}</Button>}
        />
      </div>
    </div>
  );
}
