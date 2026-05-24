import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { TrashIcon, XCircleIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { PopoverContent } from "@/components/ui/popover";

interface EvalRunSummary {
  id: string;
  agent_id: string;
  environment_id: string;
  status: "pending" | "running" | "completed" | "failed";
  started_at: string;
  ended_at?: string;
  error?: string;
  task_count: number;
  completed_count: number;
  failed_count: number;
  tasks: Array<{
    id: string;
    status: string;
    trial_pass_count?: number;
    trial_total?: number;
  }>;
}

type StatusValue = "any" | "pending" | "running" | "completed" | "failed";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "running", label: "Running" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    default:          return "bg-bg-surface text-fg-muted";
  }
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function durationStr(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.round((e - s) / 1000);
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function passRateStr(r: EvalRunSummary): string {
  let pass = 0;
  let total = 0;
  for (const t of r.tasks) {
    pass += t.trial_pass_count ?? 0;
    total += t.trial_total ?? 0;
  }
  if (total === 0) return "—";
  return `${pass}/${total}`;
}

export function EvalRunsList() {
  const nav = useNavigate();
  const { api } = useApi();

  // Server-driven status filter. "any" → omit the param entirely so the
  // server returns all runs; anything else is whitelisted by the route's
  // strict enum validator (400 on typo).
  const [status, setStatus] = useState<StatusValue>("any");

  const params = useMemo(
    () => ({
      limit: "100",
      ...(status !== "any" ? { status } : {}),
    }),
    [status],
  );

  // Auto-poll every 5s only while at least one run is still pending or
  // running. TQ inspects the cached `data` on each tick to decide, so a
  // run reaching a terminal state pauses the poll on its own — matches
  // the previous `anyActive` guard without the manual setInterval +
  // cancelled flag dance.
  const { data: runsRes, isLoading: loading, refetch } = useApiQuery<{ data: EvalRunSummary[] }>(
    "/v1/evals/runs",
    params,
    {
      refetchInterval: (query) => {
        const data = query.state.data as { data: EvalRunSummary[] } | undefined;
        const anyActive = !!data?.data.some(
          (r) => r.status === "pending" || r.status === "running",
        );
        return anyActive ? 5_000 : false;
      },
    },
  );
  const runs = runsRes?.data ?? [];

  // TanStack column defs. Order, filtering, and search all flow through
  // server params — no per-column sort/filter UI. Required columns (id,
  // status) opt out of the Columns hide menu so the user can't end up
  // with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<EvalRunSummary>[]>(
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
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(row.original.status)}`}
          >
            {row.original.status}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "pass_rate",
        accessorFn: (r) => passRateStr(r),
        header: "Pass rate",
        cell: ({ row }) => (
          <span className="text-fg font-medium">{passRateStr(row.original)}</span>
        ),
      },
      {
        id: "tasks",
        accessorFn: (r) => `${r.completed_count}/${r.task_count}`,
        header: "Tasks",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {row.original.completed_count}/{row.original.task_count}
            {row.original.failed_count > 0 && (
              <span className="text-danger ml-1">({row.original.failed_count} fail)</span>
            )}
          </span>
        ),
      },
      {
        id: "duration",
        accessorFn: (r) => durationStr(r.started_at, r.ended_at),
        header: "Duration",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {durationStr(row.original.started_at, row.original.ended_at)}
          </span>
        ),
      },
      {
        id: "started",
        accessorFn: (r) => r.started_at,
        header: "Started",
        cell: ({ row }) => (
          <span title={row.original.started_at} className="text-fg-muted">
            {timeAgo(row.original.started_at)}
          </span>
        ),
      },
      {
        id: "agent",
        accessorKey: "agent_id",
        header: "Agent",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">{row.original.agent_id}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const r = row.original;
          const isActive = r.status === "pending" || r.status === "running";
          return (
            <RowActionsMenu
              label={`Actions for ${r.id}`}
              actions={[
                {
                  label: "Cancel",
                  icon: <XCircleIcon className="size-4" />,
                  // Cancel and Delete both hit the same DELETE endpoint
                  // (it cancels in-flight runs by flipping status to
                  // failed, then deletes the row). The two menu items
                  // give the user the right verb for the row's state.
                  disabled: !isActive,
                  onSelect: async () => {
                    if (!confirm(`Cancel eval run ${r.id}? In-flight tasks will be marked failed.`)) return;
                    try {
                      await api(`/v1/evals/runs/${r.id}`, { method: "DELETE" });
                      void refetch();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (!confirm(`Delete eval run ${r.id}? This can't be undone.`)) return;
                    try {
                      await api(`/v1/evals/runs/${r.id}`, { method: "DELETE" });
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

  // Active-filter chip display — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾". The clear-X
  // only renders when the chip is in non-default state.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;

  const filters = (
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
  );

  return (
    <DataTable<EvalRunSummary>
      filters={filters}
      data={runs}
      loading={loading}
      getRowId={(r) => r.id}
      onRowClick={(r) => nav(`/evals/${r.id}`)}
      columns={columns}
      emptyTitle={status === "any" ? "No eval runs yet" : "No matching eval runs"}
      emptyKind="eval"
      emptySubtitle={
        status === "any" ? (
          <p>
            Submit one with{" "}
            <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">POST /v1/evals/runs</code>{" "}
            or{" "}
            <code className="px-1 py-0.5 bg-bg-surface rounded text-fg-muted">npx tsx rl/tasks/terminal-bench/run-cloud.ts</code>.
          </p>
        ) : (
          "Try clearing the status filter."
        )
      }
    />
  );
}
