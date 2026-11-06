import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { EyeIcon, PencilIcon, PlayIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/types";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { RenameBenchmarkDialog, ReplaceHarborCaseDialog } from "./evals/BenchmarkDialogs";
import { HarborSourceDialog } from "./evals/HarborSourceDialog";
import { MessagesCaseDialog, rewardTypeOf } from "./evals/MessagesCaseForm";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import {
  benchmarkApiPath,
  caseApiPath,
  casePath,
  describeError,
  formatDateTime,
  invalidateBenchmarks,
  kindLabel,
  sourceLabel,
  timeAgo,
  type EvalBenchmark,
  type EvalCase,
  type HarborEvalCase,
  type MessagesEvalCase,
} from "./evals/shared";

export function secs(n: number | null | undefined): string {
  return typeof n === "number" ? `${n}s` : "—";
}

/** Image alias pill: the alias, or a warning when the operator catalog has none. */
export function AliasCell({ alias, t }: { alias: string | null; t: Messages }) {
  return alias ? (
    <span className="font-mono text-fg-muted">{alias}</span>
  ) : (
    <span className="text-xs px-2 py-0.5 rounded-full bg-warning-subtle text-warning whitespace-nowrap">
      {t.evals.noAliasWarning}
    </span>
  );
}

export function SupportedCell({ c, t }: { c: HarborEvalCase; t: Messages }) {
  return c.supported ? (
    <span className="text-success">{t.evals.supported}</span>
  ) : (
    <span className="text-danger" title={c.unsupported_reason}>
      {t.evals.unsupported}
      {c.unsupported_reason && <span className="block text-fg-muted">{c.unsupported_reason}</span>}
    </span>
  );
}

function IconAction({ label, onClick, children, to }: { label: string; onClick?: () => void; children: ReactNode; to?: string }) {
  if (to) {
    return (
      <Button asChild variant="ghost" size="icon-xs" aria-label={label} title={label}>
        <Link to={to}>{children}</Link>
      </Button>
    );
  }
  return (
    <Button type="button" variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={onClick}>
      {children}
    </Button>
  );
}

export function EvalBenchmarkDetail() {
  const { benchmarkId } = useParams<{ benchmarkId: string }>();
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [showRun, setShowRun] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<MessagesEvalCase | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: benchmark, isLoading, error } = useApiQuery<EvalBenchmark>(
    benchmarkId ? benchmarkApiPath(benchmarkId) : null,
  );

  const remove = async () => {
    if (!benchmark || !confirm(m.confirmDeleteBenchmark)) return;
    setActionError(null);
    try {
      await api(benchmarkApiPath(benchmark.id), { method: "DELETE" });
      invalidateBenchmarks(queryClient);
      nav("/evals/benchmarks");
    } catch (e) {
      setActionError(describeError(t, e));
    }
  };

  const removeCase = async (name: string) => {
    if (!benchmark || !confirm(m.confirmDeleteCase)) return;
    setActionError(null);
    try {
      await api(caseApiPath(benchmark.id, name), { method: "DELETE" });
      invalidateBenchmarks(queryClient);
    } catch (e) {
      setActionError(describeError(t, e));
    }
  };

  if (isLoading) return <div className="text-center py-16 text-fg-subtle">{t.common.loading}</div>;
  if (error) {
    return <div className="text-center py-16 text-danger">{error instanceof Error ? error.message : String(error)}</div>;
  }
  if (!benchmark) return <div className="text-center py-16 text-fg-subtle">{m.benchmarkNotFound}</div>;

  const cases = benchmark.cases ?? [];
  const isHarbor = benchmark.kind === "harbor";
  const sep = <span className="text-fg-subtle">·</span>;
  const th = "text-left px-3";

  const actions = (c: EvalCase) => (
    <div className="flex items-center gap-0.5">
      <IconAction label={`${m.viewCase} ${c.name}`} to={casePath(benchmark.id, c.name)}>
        <EyeIcon className="size-3.5" />
      </IconAction>
      {c.kind === "messages" ? (
        <IconAction label={`${m.editCase} ${c.name}`} onClick={() => setEditing(c)}>
          <PencilIcon className="size-3.5" />
        </IconAction>
      ) : (
        <IconAction label={`${m.replaceCase} ${c.name}`} onClick={() => setReplacing(c.name)}>
          <RefreshCwIcon className="size-3.5" />
        </IconAction>
      )}
      <IconAction label={`${t.common.delete} ${c.name}`} onClick={() => removeCase(c.name)}>
        <TrashIcon className="size-3.5" />
      </IconAction>
    </div>
  );

  const nameCell = (c: EvalCase) => (
    <Link to={casePath(benchmark.id, c.name)} className="font-mono text-xs text-fg hover:text-brand">
      {c.name}
    </Link>
  );

  return (
    <Page>
      <div className="console-detail-stack">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="font-display text-base font-semibold tracking-tight truncate">{benchmark.name}</h1>
            <span className="text-xs text-fg-muted">{kindLabel(t, benchmark.kind)}</span>
            <div className="flex-1" />
            <Button size="sm" onClick={() => setShowRun(true)} disabled={benchmark.runnable_count === 0}>
              <PlayIcon className="size-4" />
              {m.run}
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`/evals?benchmark=${encodeURIComponent(benchmark.id)}`}>{m.viewRuns}</Link>
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
              <PlusIcon className="size-4" />
              {m.addCase}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowRename(true)}>
              <PencilIcon className="size-4" />
              {m.rename}
            </Button>
            <Button size="sm" variant="outline" onClick={remove}>
              <TrashIcon className="size-4" />
              {t.common.delete}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <span>{m.source} <span className="text-fg">{sourceLabel(t, benchmark.source)}</span></span>
            {sep}
            <span>{m.cases} <span className="text-fg font-medium">{benchmark.case_count}</span></span>
            {sep}
            <span>
              {m.runnable}{" "}
              <span className={`font-medium ${benchmark.runnable_count < benchmark.case_count ? "text-warning" : "text-fg"}`}>
                {benchmark.runnable_count}
              </span>
            </span>
            {sep}
            <span>{m.updated} <span className="text-fg">{formatDateTime(benchmark.updated_at)}</span></span>
            {sep}
            <span className="font-mono text-xs">{benchmark.id}</span>
          </div>
        </div>

        {actionError && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {actionError}
          </div>
        )}

        {cases.length === 0 ? (
          <div className="text-center py-12 text-sm text-fg-subtle space-y-3">
            <p>{m.noCasesYet}</p>
            <Button size="sm" onClick={() => setShowAdd(true)}>{m.addCase}</Button>
          </div>
        ) : (
          <div className="console-detail-table-wrap" data-testid="eval-benchmark-cases">
            <Table className="console-detail-table">
              <TableHeader variant="wireless">
                {isHarbor ? (
                  <TableRow variant="wireless">
                    <TableHead className={th}>{t.common.name}</TableHead>
                    <TableHead className={th}>{m.image}</TableHead>
                    <TableHead className={th}>{m.imageAlias}</TableHead>
                    <TableHead className={th}>{m.supported}</TableHead>
                    <TableHead className={th}>{m.timeouts}</TableHead>
                    <TableHead className={th}>{m.resources}</TableHead>
                    <TableHead className={th}>{m.hasSolution}</TableHead>
                    <TableHead className={th}>{m.updated}</TableHead>
                    <TableHead className={th} />
                  </TableRow>
                ) : (
                  <TableRow variant="wireless">
                    <TableHead className={th}>{t.common.name}</TableHead>
                    <TableHead className={th}>{m.messageCount}</TableHead>
                    <TableHead className={th}>{m.firstMessage}</TableHead>
                    <TableHead className={th}>{m.rewardType}</TableHead>
                    <TableHead className={th}>{m.updated}</TableHead>
                    <TableHead className={th} />
                  </TableRow>
                )}
              </TableHeader>
              <TableBody>
                {cases.map((c) =>
                  c.kind === "harbor" ? (
                    <TableRow variant="wireless" key={c.name} data-testid={`eval-case-${c.name}`} className="bg-bg-surface/60">
                      <TableCell className="px-3 py-2 rounded-l-lg align-top">{nameCell(c)}</TableCell>
                      <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted align-top whitespace-normal break-all">{c.image}</TableCell>
                      <TableCell className="px-3 py-2 text-xs align-top"><AliasCell alias={c.image_alias} t={t} /></TableCell>
                      <TableCell className="px-3 py-2 text-xs align-top"><SupportedCell c={c} t={t} /></TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top">
                        {secs(c.agent_timeout_sec)} / {secs(c.verifier_timeout_sec)}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top">
                        {c.cpus ?? "—"} CPU · {c.memory_mb != null ? `${c.memory_mb} MB` : "—"}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted align-top">{c.has_solution ? m.yes : m.no}</TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted align-top" title={c.updated_at}>{timeAgo(c.updated_at)}</TableCell>
                      <TableCell className="px-3 py-1 align-top rounded-r-lg">{actions(c)}</TableCell>
                    </TableRow>
                  ) : (
                    <TableRow variant="wireless" key={c.name} data-testid={`eval-case-${c.name}`} className="bg-bg-surface/60">
                      <TableCell className="px-3 py-2 rounded-l-lg align-top">{nameCell(c)}</TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top">{c.messages.length}</TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted align-top whitespace-normal break-words max-w-md">
                        <span className="line-clamp-2">{c.messages[0] ?? "—"}</span>
                      </TableCell>
                      <TableCell className="px-3 py-2 text-xs font-mono text-fg-muted align-top">{rewardTypeOf(c.reward) ?? "—"}</TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted align-top" title={c.updated_at}>{timeAgo(c.updated_at)}</TableCell>
                      <TableCell className="px-3 py-1 align-top rounded-r-lg">{actions(c)}</TableCell>
                    </TableRow>
                  ),
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <NewEvalRunDialog open={showRun} onClose={() => setShowRun(false)} initialBenchmarkId={benchmark.id} />
      <RenameBenchmarkDialog open={showRename} onClose={() => setShowRename(false)} benchmark={benchmark} />
      {isHarbor ? (
        <HarborSourceDialog open={showAdd} onClose={() => setShowAdd(false)} benchmarkId={benchmark.id} />
      ) : (
        <MessagesCaseDialog open={showAdd} onClose={() => setShowAdd(false)} benchmarkId={benchmark.id} />
      )}
      <MessagesCaseDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        benchmarkId={benchmark.id}
        existing={editing ?? undefined}
      />
      <ReplaceHarborCaseDialog
        open={replacing !== null}
        onClose={() => setReplacing(null)}
        benchmarkId={benchmark.id}
        caseName={replacing ?? ""}
      />
    </Page>
  );
}
