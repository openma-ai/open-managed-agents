import { useState } from "react";
import { Link, useParams } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { shortenId } from "../lib/format";
import type { Trajectory } from "../lib/trajectory";
import { rewardHeadline } from "../lib/trajectory";

interface EvalTrial {
  trial_index: number;
  status: "pending" | "running" | "completed" | "failed";
  session_id?: string;
  trajectory_id?: string;
  current_message_index?: number;
  error?: string;
  started_at?: string;
  ended_at?: string;
  finalize_attempts?: number;
  reward?: number;
  exit_code?: number;
  duration_seconds?: number;
  turns?: number;
  output_tail?: string;
}

interface EvalTask {
  id: string;
  spec: {
    id: string;
    messages: string[];
    setup_files?: { path: string; content: string }[];
    setup_script?: string;
    timeout_ms?: number;
    trials?: number;
  };
  status: "pending" | "running" | "completed" | "failed";
  trials: EvalTrial[];
  trial_pass_count?: number;
  trial_total?: number;
}

interface EvalRunDetail {
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
  tasks: EvalTask[];
}

function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    default:          return "bg-bg-surface text-fg-muted";
  }
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

export function EvalRunDetail() {
  const { id } = useParams<{ id: string }>();
  const { api } = useApi();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Cache of trajectory fetches keyed by session_id. Populated lazily when
   *  the user expands a task row — we don't pull every trial's trajectory
   *  on initial page load (could be hundreds of trials per run). The
   *  sentinel "loading" / "error" states keep the UI honest while inflight
   *  / after a failure (404 = trajectory not built yet, 5xx = sandbox flaky)
   *  so we don't retry on every render. */
  const [trajectories, setTrajectories] = useState<
    Map<string, Trajectory | "loading" | "error">
  >(new Map());

  // Run detail with auto-poll while the run is unfinished. Using TQ's
  // refetchInterval so we don't have to hand-roll the cleanup-on-unmount
  // dance the previous useEffect did. Returning `false` stops the poll
  // once the run reaches a terminal state.
  const {
    data: run,
    isLoading: loading,
    error: queryError,
  } = useApiQuery<EvalRunDetail>(
    id ? `/v1/evals/runs/${id}` : null,
    undefined,
    {
      refetchInterval: (query) => {
        const r = query.state.data as EvalRunDetail | undefined;
        if (!r) return false;
        return r.status === "pending" || r.status === "running" ? 5_000 : false;
      },
    },
  );
  const error = queryError instanceof Error ? queryError.message : queryError ? String(queryError) : null;

  function toggleExpand(taskId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
    // Lazy-fetch trajectories for any trial in this task that has a
    // session_id and hasn't been requested yet. The fetch result lands in
    // `trajectories` keyed by session_id; render reads from that map.
    const task = run?.tasks.find(t => t.id === taskId);
    if (!task) return;
    for (const tr of task.trials) {
      if (!tr.session_id) continue;
      // Avoid re-fetching anything already in flight, completed, or failed.
      if (trajectories.has(tr.session_id)) continue;
      void fetchTrajectory(tr.session_id);
    }
  }

  async function fetchTrajectory(sessionId: string) {
    setTrajectories(prev => {
      if (prev.has(sessionId)) return prev;
      const next = new Map(prev);
      next.set(sessionId, "loading");
      return next;
    });
    try {
      const traj = await api<Trajectory>(`/v1/sessions/${sessionId}/trajectory`);
      setTrajectories(prev => {
        const next = new Map(prev);
        next.set(sessionId, traj);
        return next;
      });
    } catch {
      setTrajectories(prev => {
        const next = new Map(prev);
        next.set(sessionId, "error");
        return next;
      });
    }
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
  if (!run) return <div className="text-center py-16 text-fg-subtle">Run not found.</div>;

  let totalPass = 0;
  let totalTrials = 0;
  for (const t of run.tasks) {
    totalPass += t.trial_pass_count ?? 0;
    totalTrials += t.trial_total ?? 0;
  }

  return (
    <div className="pl-3 pr-4 pt-3 pb-4 space-y-6">
      {/* Page header — AppBreadcrumb above renders `Eval Runs > <run.id>`,
          so the previous `← All runs` back-link + duplicated `<h1>{run.id}</h1>`
          have been removed.

          Wireless treatment (matches SessionDetail): a status pill row,
          then ONE horizontal metadata strip — no card outlines, no
          per-metric framed boxes, no dividers between sections. Submitted
          timestamp + pass/tasks/duration/agent/env all collapse into the
          single strip below the pill. */}
      <div className="space-y-2">
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(run.status)}`}>
          {run.status}
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
          <span>
            Submitted{" "}
            <span className="text-fg">
              {new Date(run.started_at).toLocaleString(undefined, {
                year: "numeric",
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Pass{" "}
            <span className="text-fg font-medium">
              {totalTrials > 0 ? `${totalPass}/${totalTrials}` : "—"}
            </span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Tasks{" "}
            <span className="text-fg font-medium">
              {run.completed_count}/{run.task_count}
            </span>
            {run.failed_count > 0 && (
              <span className="text-danger"> ({run.failed_count} failed)</span>
            )}
          </span>
          <span className="text-fg-subtle">·</span>
          <span>
            Duration{" "}
            <span className="text-fg font-medium">{durationStr(run.started_at, run.ended_at)}</span>
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="inline-flex items-center gap-1">
            <span>Agent</span>
            <Link
              to={`/agents/${run.agent_id}`}
              className="font-mono text-xs text-fg hover:text-brand"
              title={run.agent_id}
            >
              {shortenId(run.agent_id)}
            </Link>
          </span>
          <span className="text-fg-subtle">·</span>
          <span className="inline-flex items-center gap-1">
            <span>Env</span>
            <Link
              to={`/environments/${run.environment_id}`}
              className="font-mono text-xs text-fg hover:text-brand"
              title={run.environment_id}
            >
              {shortenId(run.environment_id)}
            </Link>
          </span>
        </div>
      </div>

      {run.error && (
        <div className="bg-danger-subtle/40 rounded-lg p-3">
          <div className="text-sm font-semibold text-danger mb-1">Run-level error</div>
          <pre className="text-xs whitespace-pre-wrap text-fg">{run.error}</pre>
        </div>
      )}

      {/* Task list — pill-row recipe lifted from DataTable: border-separate
          + border-spacing-y-1.5, body rows tinted bg-bg-surface/60 with
          rounded first/last cells, no row borders, no table outline.
          Header row is plain <thead> with small muted text — no border-b. */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-separate border-spacing-y-1.5">
          <thead>
            <tr className="text-fg-muted text-xs font-medium">
              <th className="w-8 px-3 text-left" />
              <th className="text-left px-3">Task</th>
              <th className="text-left px-3">Status</th>
              <th className="text-left px-3">Pass</th>
              <th className="text-left px-3">Trials</th>
            </tr>
          </thead>
          <tbody>
            {run.tasks.map(t => {
              const isOpen = expanded.has(t.id);
              return [
                <tr
                  key={t.id}
                  className="bg-bg-surface/60 hover:bg-bg-surface cursor-pointer transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                  onClick={() => toggleExpand(t.id)}
                >
                  <td className="text-fg-subtle px-3 py-2 text-center rounded-l-lg">{isOpen ? "▾" : "▸"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-fg">{t.id}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(t.status)}`}>
                      {t.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-fg font-medium">
                    {(t.trial_pass_count ?? 0)}/{t.trial_total ?? t.trials.length}
                  </td>
                  <td className="px-3 py-2 text-xs text-fg-muted rounded-r-lg">
                    {t.trials.map(tr => tr.status).join(", ")}
                  </td>
                </tr>,
                isOpen && (
                  // Expansion sits as its own subtle pill directly below the
                  // task pill — 6 px row gap (from border-spacing-y-1.5) is
                  // enough proximity to read as "detail of the row above"
                  // without needing a connecting border.
                  <tr key={`${t.id}-trials`} className="bg-bg-surface/30">
                    <td className="rounded-l-lg" />
                    <td colSpan={4} className="px-3 py-3 space-y-3 rounded-r-lg">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                        <thead>
                          <tr className="text-fg-subtle">
                            <th className="text-left py-1 pr-3 font-medium">#</th>
                            <th className="text-left py-1 pr-3 font-medium">Status</th>
                            <th className="text-left py-1 pr-3 font-medium">Reward</th>
                            <th className="text-left py-1 pr-3 font-medium">Exit</th>
                            <th className="text-left py-1 pr-3 font-medium">Dur</th>
                            <th className="text-left py-1 pr-3 font-medium">Turns</th>
                            <th className="text-left py-1 font-medium">Session</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.trials.map(tr => (
                            <tr key={tr.trial_index}>
                              <td className="py-1 pr-3 text-fg-subtle">{tr.trial_index}</td>
                              <td className="py-1 pr-3">
                                <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(tr.status)}`}>
                                  {tr.status}
                                </span>
                              </td>
                              <td className="py-1 pr-3">
                                <TrialReward
                                  fallback={tr.reward}
                                  trajectory={tr.session_id ? trajectories.get(tr.session_id) : undefined}
                                />
                              </td>
                              <td className="py-1 pr-3 font-mono text-fg-muted">{tr.exit_code ?? "—"}</td>
                              <td className="py-1 pr-3 text-fg-muted">{durationStr(tr.started_at, tr.ended_at)}</td>
                              <td className="py-1 pr-3 text-fg-muted">{tr.turns ?? "—"}</td>
                              <td className="py-1">
                                {tr.session_id ? (
                                  <Link
                                    to={`/sessions/${tr.session_id}`}
                                    className="text-brand hover:underline font-mono"
                                  >
                                    {tr.session_id}
                                  </Link>
                                ) : (
                                  <span className="text-fg-subtle">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>

                      {t.trials.some(tr => tr.session_id && trajectories.get(tr.session_id) && trajectories.get(tr.session_id) !== "loading" && trajectories.get(tr.session_id) !== "error") && (
                        <details>
                          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                            reward breakdown
                          </summary>
                          <div className="mt-1 space-y-2">
                            {t.trials.map(tr => {
                              if (!tr.session_id) return null;
                              const traj = trajectories.get(tr.session_id);
                              if (!traj || traj === "loading" || traj === "error") return null;
                              if (!traj.reward) return null;
                              return (
                                <RewardBreakdown
                                  key={tr.trial_index}
                                  trialIndex={tr.trial_index}
                                  reward={traj.reward}
                                />
                              );
                            })}
                          </div>
                        </details>
                      )}

                      {t.trials.some(tr => tr.error) && (
                        <div className="text-xs text-danger space-y-0.5">
                          {t.trials
                            .filter(tr => tr.error)
                            .map(tr => (
                              <div key={tr.trial_index}>trial {tr.trial_index}: {tr.error}</div>
                            ))}
                        </div>
                      )}

                      {t.trials.some(tr => tr.output_tail) && (
                        <details>
                          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                            verify_script output (tail)
                          </summary>
                          {t.trials
                            .filter(tr => tr.output_tail)
                            .map(tr => (
                              <pre
                                key={tr.trial_index}
                                className="mt-1 p-2 bg-bg-surface/60 rounded text-[11px] overflow-auto max-h-64 text-fg"
                              >
                                trial {tr.trial_index}:{"\n"}
                                {tr.output_tail}
                              </pre>
                            ))}
                        </details>
                      )}

                      {t.spec.setup_script && (
                        <details>
                          <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                            setup_script
                          </summary>
                          <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-[11px] overflow-auto max-h-48 text-fg">
                            {t.spec.setup_script}
                          </pre>
                        </details>
                      )}

                      <details>
                        <summary className="cursor-pointer text-xs text-fg-subtle hover:text-fg">
                          first message
                        </summary>
                        <pre className="mt-1 p-2 bg-bg-surface/60 rounded text-[11px] overflow-auto max-h-48 whitespace-pre-wrap text-fg">
                          {t.spec.messages[0]}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ),
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Reward cell on a trial row.
 *
 *  Prefers `Trajectory.reward.final_reward` (the unified Verifier output)
 *  when the lazy-fetched trajectory is available — that's the v1 story.
 *  Falls back to the legacy `EvalTrialResult.reward` (from when the eval
 *  runner stamped a single number directly on the trial) so trials whose
 *  trajectory isn't built yet still render something useful.
 *
 *  Sentinel handling:
 *   - "loading" → small dim placeholder (no extra chrome)
 *   - "error"   → fallback + "trajectory unavailable" tooltip
 *   - undefined → fallback only (parent task wasn't expanded yet) */
function TrialReward({
  fallback,
  trajectory,
}: {
  fallback: number | undefined;
  trajectory: Trajectory | "loading" | "error" | undefined;
}) {
  if (trajectory && trajectory !== "loading" && trajectory !== "error" && trajectory.reward) {
    const r = trajectory.reward;
    const headline = rewardHeadline(r);
    const isPass = r.final_reward >= 0.99;
    const isFail = r.final_reward <= 0;
    const cls = isPass
      ? "text-success font-semibold"
      : isFail
      ? "text-danger font-semibold"
      : "text-fg";
    return (
      <div className="leading-tight">
        <div className={cls}>{headline}</div>
        {r.verifier_id && (
          <div className="text-[10px] text-fg-subtle font-mono">graded by {r.verifier_id}</div>
        )}
      </div>
    );
  }
  if (trajectory === "loading") {
    return <span className="text-fg-subtle text-[10px]">loading…</span>;
  }
  if (fallback != null) {
    const tooltip = trajectory === "error" ? "trajectory unavailable; using legacy reward" : undefined;
    return (
      <span
        className={fallback >= 1 ? "text-success font-semibold" : "text-fg-subtle"}
        title={tooltip}
      >
        {fallback}
      </span>
    );
  }
  if (trajectory === "error") {
    return <span className="text-fg-subtle text-[10px]" title="trajectory fetch failed">trajectory unavailable</span>;
  }
  return <span className="text-fg-subtle">—</span>;
}

/** Per-trial raw_rewards table. Renders one row per criterion in
 *  `RewardResult.raw_rewards`. Hidden in a <details> in the parent so
 *  large multi-criterion verifiers don't blow out the row height. */
function RewardBreakdown({
  trialIndex,
  reward,
}: {
  trialIndex: number;
  reward: { raw_rewards: Record<string, number>; final_reward: number; verifier_id?: string };
}) {
  const entries = Object.entries(reward.raw_rewards);
  return (
    <div className="rounded p-2 bg-bg-surface/60">
      <div className="text-[11px] text-fg-subtle mb-1 flex items-baseline gap-2">
        <span>trial {trialIndex}</span>
        {reward.verifier_id && (
          <span className="font-mono">{reward.verifier_id}</span>
        )}
        <span className="ml-auto text-fg">
          final = <span className="font-semibold">{reward.final_reward.toFixed(2)}</span>
        </span>
      </div>
      {entries.length === 0 ? (
        <div className="text-[11px] text-fg-subtle italic">no raw_rewards recorded</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k}>
                  <td className="py-0.5 pr-2 font-mono text-fg-muted">{k}</td>
                  <td className="py-0.5 text-right text-fg">{Number.isFinite(v) ? v.toFixed(2) : String(v)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
