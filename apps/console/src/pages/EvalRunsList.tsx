import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { TrashIcon, XCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { useI18n } from "../i18n";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import {
  BENCHMARKS_BASE,
  EVALS_BASE,
  benchmarkApiPath,
  StatusBadge,
  durationStr,
  formatReward,
  isActiveStatus,
  statusLabel,
  timeAgo,
  type AgentOption,
  type EvalBenchmark,
  type EvalRun,
  type EvalRunStatus,
} from "./evals/shared";

type StatusValue = "any" | EvalRunStatus;

const STATUS_VALUES: StatusValue[] = ["any", "pending", "running", "completed", "failed", "cancelled"];

export function EvalRunsList() {
  const nav = useNavigate();
  const { api } = useApi();
  const { t } = useI18n();
  const m = t.evals;
  const [showCreate, setShowCreate] = useState(false);

  // Server-driven status filter. "any" omits the param entirely.
  const [status, setStatus] = useState<StatusValue>("any");
  // ?benchmark=<id> (linked from a benchmark page) preselects the benchmark filter.
  const [searchParams, setSearchParams] = useSearchParams();
  const benchmarkFilter = searchParams.get("benchmark") ?? "";
  const setBenchmarkFilter = (id: string) =>
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set("benchmark", id); else next.delete("benchmark");
      return next;
    }, { replace: true });
  const params = useMemo(
    () => ({
      limit: "100",
      ...(status !== "any" ? { status } : {}),
      ...(benchmarkFilter ? { benchmark_id: benchmarkFilter } : {}),
    }),
    [status, benchmarkFilter],
  );

  // Poll every 5s only while at least one run is still pending or running.
  const { data: runsRes, isLoading: loading, refetch } = useApiQuery<{ data: EvalRun[] }>(
    `${EVALS_BASE}/runs`,
    params,
    {
      refetchInterval: (query) => {
        const data = query.state.data as { data: EvalRun[] } | undefined;
        return data?.data.some((r) => isActiveStatus(r.status)) ? 5_000 : false;
      },
    },
  );
  const runs = runsRes?.data ?? [];

  // Name lookups for the benchmark / agent columns.
  const { data: benchmarksRes } = useApiQuery<{ data: EvalBenchmark[] }>(BENCHMARKS_BASE);
  const agentsParams = useMemo(() => ({ limit: "200" }), []);
  const { data: agentsRes } = useApiQuery<{ data: AgentOption[] }>("/v1/agents", agentsParams);
  const benchmarkNames = useMemo(
    () => new Map((benchmarksRes?.data ?? []).map((d) => [d.id, d.name])),
    [benchmarksRes],
  );
  const agentNames = useMemo(
    () => new Map((agentsRes?.data ?? []).map((a) => [a.id, a.name])),
    [agentsRes],
  );

  const columns = useMemo<ColumnDef<EvalRun>[]>(
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
        id: "kind",
        accessorKey: "kind",
        header: m.kind,
        cell: ({ row }) => <span className="text-xs text-fg-muted">{row.original.kind ?? "messages"}</span>,
      },
      {
        id: "benchmark",
        accessorFn: (r) => r.benchmark_id ?? "",
        header: m.benchmark,
        cell: ({ row }) => {
          const id = row.original.benchmark_id;
          if (!id) return <span className="text-fg-subtle">—</span>;
          return (
            <Link
              to={`/evals/benchmarks/${id}`}
              onClick={(e) => e.stopPropagation()}
              className="text-brand hover:underline text-sm"
              title={id}
            >
              {benchmarkNames.get(id) ?? id}
            </Link>
          );
        },
      },
      {
        id: "mode",
        accessorFn: (r) => r.mode ?? "",
        header: m.mode,
        cell: ({ row }) => (
          <span className="text-xs text-fg-muted">
            {row.original.kind === "harbor"
              ? row.original.mode === "oracle" ? m.modeOracle : m.modeAgent
              : "—"}
          </span>
        ),
      },
      {
        id: "agent",
        accessorFn: (r) => r.agent_id ?? "",
        header: m.agent,
        cell: ({ row }) => {
          const id = row.original.agent_id;
          if (!id) return <span className="text-fg-subtle">—</span>;
          return (
            <span className="text-xs text-fg-muted" title={id}>
              {agentNames.get(id) ?? <span className="font-mono">{id}</span>}
            </span>
          );
        },
      },
      {
        id: "status",
        accessorKey: "status",
        header: t.common.status,
        cell: ({ row }) => <StatusBadge status={row.original.status} t={t} />,
        enableHiding: false,
      },
      {
        id: "progress",
        accessorFn: (r) => `${r.completed_count + r.failed_count}/${r.task_count}`,
        header: m.progress,
        cell: ({ row }) => {
          const r = row.original;
          return (
            <span className="text-fg-muted tabular-nums">
              {r.completed_count + r.failed_count}/{r.task_count}
              {r.failed_count > 0 && (
                <span className="text-danger ml-1">({r.failed_count} {m.failedSuffix})</span>
              )}
            </span>
          );
        },
      },
      {
        id: "score",
        accessorFn: (r) => r.score ?? null,
        header: m.score,
        cell: ({ row }) => (
          <span className="text-fg font-medium tabular-nums">{formatReward(row.original.score)}</span>
        ),
      },
      {
        id: "started",
        accessorFn: (r) => r.started_at ?? r.created_at,
        header: m.started,
        cell: ({ row }) => {
          const iso = row.original.started_at ?? row.original.created_at;
          return <span title={iso} className="text-fg-muted">{timeAgo(iso)}</span>;
        },
      },
      {
        id: "duration",
        accessorFn: (r) => durationStr(r.started_at, r.ended_at),
        header: m.duration,
        cell: ({ row }) => (
          <span className="text-fg-muted">{durationStr(row.original.started_at, row.original.ended_at)}</span>
        ),
      },
    ],
    [t, m, benchmarkNames, agentNames],
  );

  const statusOptions = STATUS_VALUES.map((value) => ({
    value,
    label: value === "any" ? t.common.all : statusLabel(t, value),
  }));

  const benchmarkOptions = [
    { value: "", label: m.allBenchmarks },
    ...(benchmarksRes?.data ?? []).map((b) => ({ value: b.id, label: b.name })),
  ];
  const filters = (
    <>
    <FilterChip
      label={m.benchmark}
      active={benchmarkFilter !== ""}
      display={benchmarkFilter ? benchmarkNames.get(benchmarkFilter) ?? benchmarkFilter : undefined}
      onClear={() => setBenchmarkFilter("")}
    >
      <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-56 p-0">
        <FacetedFilter
          options={benchmarkOptions}
          value={benchmarkFilter}
          onValueChange={(v) => setBenchmarkFilter(v)}
          searchPlaceholder={m.benchmark}
        />
      </PopoverContent>
    </FilterChip>
    <FilterChip
      label={t.common.status}
      active={status !== "any"}
      display={status === "any" ? undefined : statusLabel(t, status)}
      onClear={() => setStatus("any")}
    >
      <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-48 p-0">
        <FacetedFilter
          options={statusOptions}
          value={status}
          onValueChange={(v) => setStatus(v as StatusValue)}
          searchPlaceholder={t.common.status}
        />
      </PopoverContent>
    </FilterChip>
    </>
  );

  return (
    <DataTable<EvalRun>
      createLabel={m.newEvalRun}
      onCreate={() => setShowCreate(true)}
      filters={filters}
      data={runs}
      loading={loading}
      getRowId={(r) => r.id}
      onRowClick={(r) => nav(`/evals/${r.id}`)}
      rowActions={(run) => [
        {
          label: m.cancelRun,
          icon: <XCircleIcon className="size-4" />,
          disabled: !isActiveStatus(run.status),
          onSelect: async () => {
            if (!confirm(m.confirmCancelRun)) return;
            try {
              await api(`${EVALS_BASE}/runs/${run.id}/cancel`, { method: "POST" });
              void refetch();
            } catch { /* toasted by useApi */ }
          },
        },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: async () => {
            if (!confirm(m.confirmDeleteRun)) return;
            try {
              await api(`${EVALS_BASE}/runs/${run.id}`, { method: "DELETE" });
              void refetch();
            } catch { /* toasted by useApi */ }
          },
        },
      ]}
      columns={columns}
      emptyTitle={status === "any" && !benchmarkFilter ? m.noEvalRunsYet : m.noMatchingEvalRuns}
      emptyKind="eval"
      emptySubtitle={status === "any" && !benchmarkFilter ? m.noEvalRunsHint : m.tryClearingFilter}
      emptyAction={
        status === "any" && !benchmarkFilter && <Button onClick={() => setShowCreate(true)}>{m.newEvalRun}</Button>
      }
    >
      <NewEvalRunDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </DataTable>
  );
}
