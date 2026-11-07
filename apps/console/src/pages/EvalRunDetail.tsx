import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Fragment, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import { XCircleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { shortenId } from "../lib/format";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/types";
import {
  BENCHMARKS_BASE,
  EVALS_BASE,
  benchmarkApiPath,
  StatusBadge,
  durationStr,
  formatDateTime,
  formatReward,
  isActiveStatus,
  type AgentOption,
  type EvalBenchmark,
  type EvalRun,
  type EvalRunTask,
  type EvalTrial,
} from "./evals/shared";

/** Legacy "messages" runs recorded before the shared contract may still carry
 *  the task spec and the old verify-script tail; render them when present. */
type LegacyTask = EvalRunTask & {
  spec?: { messages?: string[]; setup_script?: string };
};
type LegacyTrial = EvalTrial & { output_tail?: string; exit_code?: number };

function trialOutput(tr: LegacyTrial): string | undefined {
  return tr.verifier_output_tail ?? tr.output_tail;
}

function rewardCls(r: number | undefined): string {
  if (r == null) return "text-fg-subtle";
  if (r >= 0.99) return "text-success font-semibold";
  if (r <= 0) return "text-danger font-semibold";
  return "text-fg";
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span>{label}</span>
      <span className="text-fg font-medium">{children}</span>
    </span>
  );
}

export function EvalRunDetail() {
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [cancelling, setCancelling] = useState(false);

  // Poll every 5s while the run is unfinished; stops on a terminal status.
  const {
    data: run,
    isLoading: loading,
    error: queryError,
    refetch,
  } = useApiQuery<EvalRun>(
    id ? `${EVALS_BASE}/runs/${id}` : null,
    undefined,
    {
      refetchInterval: (query) => {
        const r = query.state.data as EvalRun | undefined;
        return r && isActiveStatus(r.status) ? 5_000 : false;
      },
    },
  );
  const error = queryError instanceof Error ? queryError.message : queryError ? String(queryError) : null;

  const { data: benchmark } = useApiQuery<EvalBenchmark>(
    run?.benchmark_id ? benchmarkApiPath(run.benchmark_id) : null,
  );
  const { data: agent } = useApiQuery<AgentOption>(
    run?.agent_id ? `/v1/agents/${run.agent_id}` : null,
    undefined,
    { retry: false },
  );

  function toggleExpand(taskId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  async function cancel() {
    if (!run || !confirm(m.confirmCancelRun)) return;
    setCancelling(true);
    try {
      await api(`${EVALS_BASE}/runs/${run.id}/cancel`, { method: "POST" });
      void refetch();
    } catch { /* toasted by useApi */ }
    setCancelling(false);
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <svg className="animate-spin h-5 w-5 text-fg-subtle" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }
  if (error) return <div className="text-center py-16 text-danger">{error}</div>;
  if (!run) return <div className="text-center py-16 text-fg-subtle">{m.runNotFound}</div>;

  const isHarbor = run.kind === "harbor";
  const tasks = (run.tasks ?? []) as LegacyTask[];
  const sep = <span className="text-fg-subtle">·</span>;

  return (
    <Page>
      <div className="console-detail-stack">
        {/* Status row + one horizontal metadata strip (SessionDetail style). */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <StatusBadge status={run.status} t={t} />
            <span className="text-xs text-fg-muted">{run.kind ?? "messages"}</span>
            <div className="flex-1" />
            {isActiveStatus(run.status) && (
              <Button variant="outline" size="sm" onClick={cancel} disabled={cancelling}>
                <XCircleIcon className="size-4" />
                {m.cancelRun}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <Meta label={m.score}>{formatReward(run.score)}</Meta>
            {sep}
            <Meta label={m.tasks}>
              {run.completed_count + run.failed_count}/{run.task_count}
              {run.failed_count > 0 && (
                <span className="text-danger font-normal"> ({run.failed_count} {m.failedSuffix})</span>
              )}
            </Meta>
            {isHarbor && (
              <>
                {sep}
                <Meta label={m.mode}>{run.mode === "oracle" ? m.modeOracle : m.modeAgent}</Meta>
              </>
            )}
            {run.benchmark_id && (
              <>
                {sep}
                <span className="inline-flex items-center gap-1">
                  <span>{m.benchmark}</span>
                  <Link
                    to={`/evals/benchmarks/${run.benchmark_id}`}
                    className="text-fg hover:text-brand"
                    title={run.benchmark_id}
                  >
                    {benchmark?.name ?? shortenId(run.benchmark_id)}
                  </Link>
                  {run.benchmark_revision != null && (
                    <Link
                      to={`/evals/benchmarks/${run.benchmark_id}?revision=${run.benchmark_revision}`}
                      className="text-fg-muted hover:text-brand"
                      data-testid="eval-run-benchmark-revision"
                    >
                      {m.revisionN.replace("{n}", String(run.benchmark_revision))}
                    </Link>
                  )}
                </span>
              </>
            )}
            {run.agent_id && (
              <>
                {sep}
                <span className="inline-flex items-center gap-1">
                  <span>{m.agent}</span>
                  <Link to={`/agents/${run.agent_id}`} className="text-fg hover:text-brand" title={run.agent_id}>
                    {agent?.name ?? <span className="font-mono text-xs">{shortenId(run.agent_id)}</span>}
                  </Link>
                </span>
              </>
            )}
            {run.environment_id && (
              <>
                {sep}
                <span className="inline-flex items-center gap-1">
                  <span>{m.environment}</span>
                  <Link
                    to={`/environments/${run.environment_id}`}
                    className="font-mono text-xs text-fg hover:text-brand"
                    title={run.environment_id}
                  >
                    {shortenId(run.environment_id)}
                  </Link>
                </span>
              </>
            )}
            {sep}
            <Meta label={m.submitted}>{formatDateTime(run.created_at ?? run.started_at)}</Meta>
            {run.started_at && (
              <>
                {sep}
                <Meta label={m.started}>{formatDateTime(run.started_at)}</Meta>
              </>
            )}
            {run.ended_at && (
              <>
                {sep}
                <Meta label={m.ended}>{formatDateTime(run.ended_at)}</Meta>
              </>
            )}
            {sep}
            <Meta label={m.duration}>{durationStr(run.started_at, run.ended_at)}</Meta>
          </div>
        </div>

        {run.error && (
          <div className="bg-danger-subtle/40 rounded-lg p-3">
            <div className="text-sm font-semibold text-danger mb-1">{m.runError}</div>
            <pre className="text-xs whitespace-pre-wrap text-fg">{run.error}</pre>
          </div>
        )}

        <div className="console-detail-table-wrap" data-testid="eval-results-table">
          <Table className="console-detail-table">
            <TableHeader variant="wireless">
              <TableRow variant="wireless">
                <TableHead className="w-8 px-3 text-left" />
                <TableHead className="text-left px-3">{m.task}</TableHead>
                <TableHead className="text-left px-3">{t.common.status}</TableHead>
                <TableHead className="text-left px-3">{m.meanReward}</TableHead>
                <TableHead className="text-left px-3">{m.pass}</TableHead>
                {isHarbor && <TableHead className="text-left px-3">{m.imageAlias}</TableHead>}
                <TableHead className="text-left px-3">{m.trials}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tasks.map((task) => {
                const isOpen = expanded.has(task.id);
                return (
                  <Fragment key={task.id}>
                    <TableRow
                      variant="wireless"
                      data-testid={`eval-task-${task.id}`}
                      aria-expanded={isOpen}
                      className="bg-bg-surface/60 hover:bg-bg-surface cursor-pointer transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                      onClick={() => toggleExpand(task.id)}
                    >
                      <TableCell className="text-fg-subtle px-3 py-2 text-center rounded-l-lg">{isOpen ? "▾" : "▸"}</TableCell>
                      <TableCell className="px-3 py-2 font-mono text-xs text-fg">{task.id}</TableCell>
                      <TableCell className="px-3 py-2"><StatusBadge status={task.status} t={t} /></TableCell>
                      <TableCell className={`px-3 py-2 tabular-nums ${rewardCls(task.mean_reward)}`}>
                        {formatReward(task.mean_reward)}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-fg font-medium tabular-nums">
                        {task.trial_pass_count ?? 0}/{task.trial_total ?? task.trials.length}
                      </TableCell>
                      {isHarbor && (
                        <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted">{task.image_alias ?? "—"}</TableCell>
                      )}
                      <TableCell className="px-3 py-2 text-xs text-fg-muted rounded-r-lg">
                        {task.trials.map((tr) => tr.status).join(", ") || "—"}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <TableRow className="bg-bg-surface/30">
                        <TableCell className="rounded-l-lg" />
                        <TableCell colSpan={isHarbor ? 6 : 5} className="px-3 py-3 space-y-3 rounded-r-lg">
                          {task.error && <div className="text-xs text-danger">{task.error}</div>}
                          {task.trials.length === 0 ? (
                            <div className="text-xs text-fg-subtle">{m.noTrials}</div>
                          ) : (
                            <TrialsTable trials={task.trials as LegacyTrial[]} isHarbor={isHarbor} t={t} />
                          )}
                          {task.spec?.setup_script && (
                            <details>
                              <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">{m.setupScript}</summary>
                              <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-48 text-fg">
                                {task.spec.setup_script}
                              </pre>
                            </details>
                          )}
                          {task.spec?.messages?.[0] && (
                            <details>
                              <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">{m.firstMessage}</summary>
                              <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-xs overflow-auto max-h-48 whitespace-pre-wrap text-fg">
                                {task.spec.messages[0]}
                              </pre>
                            </details>
                          )}
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </Page>
  );
}

function TrialsTable({ trials, isHarbor, t }: { trials: LegacyTrial[]; isHarbor: boolean; t: Messages }) {
  const m = t.evals;
  const th = "text-left py-1 pr-3 font-medium";
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table className="w-full text-xs">
          <TableHeader>
            <TableRow className="text-fg-subtle">
              <TableHead className={th}>#</TableHead>
              <TableHead className={th}>{t.common.status}</TableHead>
              {isHarbor && <TableHead className={th}>{m.phase}</TableHead>}
              <TableHead className={th}>{m.reward}</TableHead>
              <TableHead className={th}>{m.rewards}</TableHead>
              <TableHead className={th}>{m.exitCode}</TableHead>
              {!isHarbor && <TableHead className={th}>{m.messageIndex}</TableHead>}
              {!isHarbor && <TableHead className={th}>{m.trajectory}</TableHead>}
              <TableHead className={th}>{m.duration}</TableHead>
              <TableHead className={th}>{m.session}</TableHead>
              <TableHead className="text-left py-1 font-medium">{m.error}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {trials.map((tr) => {
              const exit = tr.test_exit_code ?? tr.exit_code;
              const rewards = tr.rewards ? Object.entries(tr.rewards) : [];
              return (
                <TableRow key={tr.trial_index} data-testid={`eval-trial-${tr.trial_index}`}>
                  <TableCell className="py-1 pr-3 text-fg-subtle">{tr.trial_index}</TableCell>
                  <TableCell className="py-1 pr-3">
                    <span className="inline-flex items-center gap-1">
                      <StatusBadge status={tr.status} t={t} />
                      {tr.agent_timed_out && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-warning-subtle text-warning">
                          {m.agentTimedOut}
                        </span>
                      )}
                    </span>
                  </TableCell>
                  {isHarbor && <TableCell className="py-1 pr-3 text-fg-muted">{tr.phase ?? "—"}</TableCell>}
                  <TableCell className={`py-1 pr-3 tabular-nums ${rewardCls(tr.reward)}`}>{formatReward(tr.reward)}</TableCell>
                  <TableCell className="py-1 pr-3 font-mono text-fg-muted">
                    {rewards.length === 0
                      ? "—"
                      : rewards.map(([k, v]) => (
                          <div key={k}>{k}={Number.isFinite(v) ? v : String(v)}</div>
                        ))}
                  </TableCell>
                  <TableCell className="py-1 pr-3 font-mono text-fg-muted">{exit ?? "—"}</TableCell>
                  {!isHarbor && <TableCell className="py-1 pr-3 text-fg-muted">{tr.current_message_index ?? "—"}</TableCell>}
                  {!isHarbor && (
                    <TableCell className="py-1 pr-3 font-mono text-fg-muted" title={tr.trajectory_id}>
                      {tr.trajectory_id ? shortenId(tr.trajectory_id) : "—"}
                    </TableCell>
                  )}
                  <TableCell className="py-1 pr-3 text-fg-muted">{durationStr(tr.started_at, tr.ended_at)}</TableCell>
                  <TableCell className="py-1 pr-3">
                    {tr.session_id ? (
                      <Link to={`/sessions/${tr.session_id}`} className="text-brand hover:underline font-mono">
                        {tr.session_id}
                      </Link>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </TableCell>
                  <TableCell className="py-1 text-danger whitespace-pre-wrap">{tr.error ?? ""}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {trials.filter((tr) => trialOutput(tr)).map((tr) => (
        <details key={tr.trial_index}>
          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
            {m.verifierOutput} · #{tr.trial_index}
          </summary>
          <pre className="mt-1 p-2 bg-bg-surface/60 rounded font-mono text-xs overflow-auto max-h-64 whitespace-pre-wrap text-fg">
            {trialOutput(tr)}
          </pre>
        </details>
      ))}
    </div>
  );
}
