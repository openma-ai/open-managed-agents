import type { QueryClient } from "@tanstack/react-query";
import type {
  EvalCase,
  EvalRunStatus,
  HarborCaseSource,
} from "@open-managed-agents/api-types";

import type { Messages } from "../../i18n/types";
import { ApiError } from "../../lib/api";

export type {
  AddEvalCasesRequest,
  BuiltinEvalBenchmark,
  CreateEvalBenchmarkRequest,
  CreateEvalRunRequest,
  CreateEvalRunResponse,
  EvalBenchmark,
  EvalBenchmarkKind,
  EvalCase,
  EvalCaseDetail,
  EvalRun,
  EvalRunStatus,
  EvalRunTask,
  EvalTrial,
  HarborCaseSource,
  HarborEvalCase,
  MessagesCaseInput,
  MessagesEvalCase,
  ReplaceEvalCaseRequest,
} from "@open-managed-agents/api-types";

export const EVALS_BASE = "/v1/oma/evals";

export const BENCHMARKS_BASE = `${EVALS_BASE}/benchmarks`;

export function benchmarkPath(id: string): string {
  return `/evals/benchmarks/${encodeURIComponent(id)}`;
}

export function casePath(benchmarkId: string, name: string): string {
  return `${benchmarkPath(benchmarkId)}/cases/${encodeURIComponent(name)}`;
}

export function benchmarkApiPath(id: string): string {
  return `${BENCHMARKS_BASE}/${id}`;
}

export function caseApiPath(benchmarkId: string, name: string): string {
  return `${benchmarkApiPath(benchmarkId)}/cases/${encodeURIComponent(name)}`;
}

/** Refetch every benchmark list/detail/case query after a write. */
export function invalidateBenchmarks(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith(BENCHMARKS_BASE),
  });
}

/** Readable text for a failed write. 409s (a run of the benchmark is active,
 *  or the case name is taken) get a prefix so the cause is obvious. */
export function describeError(t: Messages, e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ApiError && e.status === 409) return `${t.evals.conflict}: ${msg}`;
  return msg;
}

/** Minimal environment shape for the run dialog's environment picker. */
export interface EnvironmentOption {
  id: string;
  name: string;
  archived_at?: string | null;
}

/** Minimal agent shape the eval pages need from GET /v1/agents. */
export interface AgentOption {
  id: string;
  name: string;
  archived_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * The agent the eval runner creates to host oracle-mode Sessions
 * (metadata oma_eval_role = "oracle"). It never runs, so it is not a choice
 * for agent-mode runs.
 */
export function isEvalOracleAgent(agent: AgentOption): boolean {
  return agent.metadata?.oma_eval_role === "oracle";
}

export function isActiveStatus(s: string | undefined): boolean {
  return s === "pending" || s === "running";
}

/** Status pill colors, shared by runs, tasks and trials. */
export function statusCls(s: string): string {
  switch (s) {
    case "completed": return "bg-success-subtle text-success";
    case "failed":    return "bg-danger-subtle text-danger";
    case "running":   return "bg-info-subtle text-info";
    case "cancelled": return "bg-warning-subtle text-warning";
    default:          return "bg-bg-surface text-fg-muted";
  }
}

export function statusLabel(t: Messages, s: EvalRunStatus | string): string {
  switch (s) {
    case "pending":   return t.evals.statusPending;
    case "running":   return t.evals.statusRunning;
    case "completed": return t.evals.statusCompleted;
    case "failed":    return t.evals.statusFailed;
    case "cancelled": return t.evals.statusCancelled;
    default:          return s;
  }
}

export function StatusBadge({ status, t }: { status: string; t: Messages }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${statusCls(status)}`}>
      {statusLabel(t, status)}
    </span>
  );
}

export function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function durationStr(start?: string, end?: string): string {
  if (!start) return "—";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const sec = Math.max(0, Math.round((e - s) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function formatReward(n: number | undefined | null): string {
  return typeof n === "number" && Number.isFinite(n) ? n.toFixed(2) : "—";
}

export function formatDateTime(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Contract: a harbor case is runnable when supported and resolved to a
 *  SANDBOX_IMAGES alias; every messages case is runnable. */
export function isRunnableCase(c: EvalCase): boolean {
  return c.kind === "messages" || (c.supported && c.image_alias !== null);
}

export function kindLabel(t: Messages, kind: string | undefined): string {
  return kind === "harbor" ? t.evals.kindHarbor : t.evals.kindMessages;
}

export function sourceLabel(t: Messages, source: HarborCaseSource | null | undefined): string {
  if (!source) return t.evals.sourceNone;
  switch (source.type) {
    case "builtin": return `${t.evals.sourceBuiltin} · ${source.name}`;
    case "registry":
      return `${t.evals.sourceRegistry} · ${source.name}${source.version ? `@${source.version}` : ""}`;
    case "upload": return t.evals.sourceUpload;
  }
}
