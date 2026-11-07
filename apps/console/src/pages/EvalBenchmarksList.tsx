import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { PlayIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { useI18n } from "../i18n";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { CreateBenchmarkDialog } from "./evals/BenchmarkDialogs";
import { HarborSourceDialog } from "./evals/HarborSourceDialog";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import {
  BENCHMARKS_BASE,
  benchmarkApiPath,
  benchmarkPath,
  invalidateBenchmarks,
  kindLabel,
  sourceLabel,
  timeAgo,
  type EvalBenchmark,
} from "./evals/shared";

export function EvalBenchmarksList() {
  const nav = useNavigate();
  const { api } = useApi();
  const { t } = useI18n();
  const m = t.evals;
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [runBenchmarkId, setRunBenchmarkId] = useState<string | null>(null);

  const { data, isLoading } = useApiQuery<{ data: EvalBenchmark[] }>(BENCHMARKS_BASE);
  const benchmarks = data?.data ?? [];

  const columns = useMemo<ColumnDef<EvalBenchmark>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: t.common.name,
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "kind",
        accessorKey: "kind",
        header: m.kind,
        cell: ({ row }) => <span className="text-xs text-fg-muted">{kindLabel(t, row.original.kind)}</span>,
      },
      {
        id: "source",
        accessorFn: (b) => b.source?.type ?? "",
        header: m.source,
        cell: ({ row }) => <span className="text-xs text-fg-muted">{sourceLabel(t, row.original.source)}</span>,
      },
      {
        id: "cases",
        accessorKey: "case_count",
        header: m.cases,
        cell: ({ row }) => <span className="tabular-nums text-fg-muted">{row.original.case_count}</span>,
      },
      {
        id: "runnable",
        accessorKey: "runnable_count",
        header: m.runnable,
        cell: ({ row }) => {
          const b = row.original;
          return (
            <span className={`tabular-nums ${b.runnable_count < b.case_count ? "text-warning" : "text-fg-muted"}`}>
              {b.runnable_count}
            </span>
          );
        },
      },
      {
        id: "updated",
        accessorKey: "updated_at",
        header: m.updated,
        cell: ({ row }) => (
          <span className="text-fg-muted" title={row.original.updated_at}>{timeAgo(row.original.updated_at)}</span>
        ),
      },
    ],
    [t, m],
  );

  return (
    <DataTable<EvalBenchmark>
      createLabel={m.newBenchmark}
      onCreate={() => setShowCreate(true)}
      filters={<Button variant="outline" onClick={() => setShowImport(true)}>{m.importBenchmark}</Button>}
      data={benchmarks}
      loading={isLoading}
      getRowId={(b) => b.id}
      onRowClick={(b) => nav(benchmarkPath(b.id))}
      rowActions={(b) => [
        {
          label: m.run,
          icon: <PlayIcon className="size-4" />,
          disabled: b.runnable_count === 0,
          onSelect: () => setRunBenchmarkId(b.id),
        },
        {
          label: t.common.delete,
          icon: <TrashIcon className="size-4" />,
          destructive: true,
          onSelect: async () => {
            if (!confirm(m.confirmDeleteBenchmark)) return;
            try {
              await api(benchmarkApiPath(b.id), { method: "DELETE" });
              invalidateBenchmarks(queryClient);
            } catch { /* toasted by useApi (409 while a run is active) */ }
          },
        },
      ]}
      columns={columns}
      emptyTitle={m.noBenchmarksYet}
      emptyKind="eval"
      emptySubtitle={m.noBenchmarksHint}
      emptyAction={<Button onClick={() => setShowCreate(true)}>{m.newBenchmark}</Button>}
    >
      <CreateBenchmarkDialog open={showCreate} onClose={() => setShowCreate(false)} />
      <HarborSourceDialog open={showImport} onClose={() => setShowImport(false)} />
      <NewEvalRunDialog
        open={runBenchmarkId !== null}
        onClose={() => setRunBenchmarkId(null)}
        initialBenchmarkId={runBenchmarkId ?? undefined}
      />
    </DataTable>
  );
}
