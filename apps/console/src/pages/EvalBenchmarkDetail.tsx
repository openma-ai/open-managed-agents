import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { EyeIcon, PencilIcon, PlayIcon, PlusIcon, RefreshCwIcon, TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import type { Messages } from "../i18n/types";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { RenameBenchmarkDialog, SyncBenchmarkDialog } from "./evals/BenchmarkDialogs";
import { MessagesCaseDialog, rewardTypeOf } from "./evals/MessagesCaseForm";
import { NewEvalRunDialog } from "./evals/NewEvalRunDialog";
import {
  benchmarkApiPath,
  benchmarkRevisionPath,
  caseApiPath,
  casePath,
  commitUrl,
  describeError,
  formatDateTime,
  invalidateBenchmarks,
  kindLabel,
  parseRevision,
  shortCommit,
  shortDigest,
  sourceLabel,
  timeAgo,
  type EvalBenchmark,
  type EvalCase,
  type EvalSourcePin,
  type HarborCaseSource,
  type HarborEvalCase,
  type MessagesEvalCase,
  type SyncEvalBenchmarkResponse,
} from "./evals/shared";

export function secs(n: number | null | undefined): string {
  return typeof n === "number" ? `${n}s` : "—";
}

/** Image alias pill: the alias, or a warning when the operator catalog has none. */
export function AliasCell({ alias, t }: { alias: string | null; t: Messages }) {
  return alias ? (
    <span className="font-mono text-fg-muted">{alias}</span>
  ) : (
    <span className="inline-block max-w-full text-xs px-2 py-0.5 rounded-md bg-warning-subtle text-warning [overflow-wrap:anywhere]">
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

/** Pinned commit(s) of a revision, linked to the repository at that commit. */
export function PinList({ pins }: { pins: EvalSourcePin[] }) {
  if (pins.length === 0) return <span className="text-fg-subtle">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-x-2">
      {pins.map((p) => {
        const href = commitUrl(p.url, p.commit);
        const label = shortCommit(p.commit);
        return href ? (
          <a key={`${p.url}@${p.commit}`} href={href} target="_blank" rel="noreferrer" title={`${p.url} @ ${p.commit}`} className="font-mono text-xs text-fg hover:text-brand">
            {label}
          </a>
        ) : (
          <span key={`${p.url}@${p.commit}`} title={`${p.url} @ ${p.commit}`} className="font-mono text-xs text-fg">{label}</span>
        );
      })}
    </span>
  );
}

function sourceRef(source: HarborCaseSource | null | undefined): string | undefined {
  if (source?.type === "git") return source.ref ?? "HEAD";
  if (source?.type === "registry") return source.version;
  return undefined;
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
  const [searchParams] = useSearchParams();
  const requestedRevision = parseRevision(searchParams.get("revision"));
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [showRun, setShowRun] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<MessagesEvalCase | null>(null);
  const [showSync, setShowSync] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncEvalBenchmarkResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // A sync notice belongs to the view it was made in, not to another revision.
  useEffect(() => { setSyncResult(null); }, [requestedRevision]);

  const { data: benchmark, isLoading, error } = useApiQuery<EvalBenchmark>(
    benchmarkId ? benchmarkApiPath(benchmarkId, requestedRevision) : null,
  );

  const onSynced = (res: SyncEvalBenchmarkResponse) => {
    setSyncResult(res);
    if (requestedRevision !== undefined) nav(benchmarkRevisionPath(res.benchmark.id));
  };

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
  const revisions = benchmark.revisions ?? [];
  const shownRevision = benchmark.cases_revision ?? benchmark.revision;
  const shown = revisions.find((r) => r.revision === shownRevision);
  const shownSource = shown?.source ?? benchmark.source;
  const isOld = isHarbor && shownRevision != null && benchmark.revision != null && shownRevision !== benchmark.revision;
  // Keep the revision in case links only when the URL asked for one.
  const linkRevision = requestedRevision !== undefined ? shownRevision : undefined;
  const ref = sourceRef(shownSource);
  const sep = <span className="text-fg-subtle">·</span>;
  // Harbor rows have many columns; let headers and badges wrap instead of overlapping.
  const th = "text-left px-3 whitespace-normal leading-tight";

  const actions = (c: EvalCase) => (
    <div className="flex items-center gap-0.5">
      <IconAction label={`${m.viewCase} ${c.name}`} to={casePath(benchmark.id, c.name, linkRevision)}>
        <EyeIcon className="size-3.5" />
      </IconAction>
      {c.kind === "messages" && (
        <>
          <IconAction label={`${m.editCase} ${c.name}`} onClick={() => setEditing(c)}>
            <PencilIcon className="size-3.5" />
          </IconAction>
          <IconAction label={`${t.common.delete} ${c.name}`} onClick={() => removeCase(c.name)}>
            <TrashIcon className="size-3.5" />
          </IconAction>
        </>
      )}
    </div>
  );

  const nameCell = (c: EvalCase) => (
    <Link to={casePath(benchmark.id, c.name, linkRevision)} className="font-mono text-xs text-fg hover:text-brand">
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
            <Button size="sm" onClick={() => setShowRun(true)} disabled={benchmark.runnable_count === 0 || isOld}>
              <PlayIcon className="size-4" />
              {m.run}
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`/evals?benchmark=${encodeURIComponent(benchmark.id)}`}>{m.viewRuns}</Link>
            </Button>
            {isHarbor ? (
              !isOld && (
                <Button size="sm" variant="outline" onClick={() => setShowSync(true)}>
                  <RefreshCwIcon className="size-4" />
                  {m.syncFromSource}
                </Button>
              )
            ) : (
              <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
                <PlusIcon className="size-4" />
                {m.addCase}
              </Button>
            )}
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
            <span>{m.source} <span className="text-fg break-all">{sourceLabel(t, shownSource)}</span></span>
            {sep}
            {isHarbor && (
              <>
                {ref && (
                  <>
                    <span>{m.ref} <span className="font-mono text-xs text-fg">{ref}</span></span>
                    {sep}
                  </>
                )}
                {shown && shown.pins.length > 0 && (
                  <>
                    <span data-testid="eval-benchmark-pins">{m.pinnedCommits} <PinList pins={shown.pins} /></span>
                    {sep}
                  </>
                )}
                <span>
                  {m.revision} <span className="text-fg font-medium tabular-nums">{shownRevision ?? "—"}</span>
                  {isOld && benchmark.revision != null && <span className="text-fg-subtle"> / {benchmark.revision}</span>}
                </span>
                {sep}
              </>
            )}
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

        {isOld && (
          <div role="note" data-testid="eval-old-revision" className="rounded-md bg-warning-subtle/40 p-3 text-sm text-warning flex items-center gap-3">
            <span className="flex-1">
              {m.viewingOldRevision.replace("{n}", String(shownRevision)).replace("{latest}", String(benchmark.revision))}
            </span>
            <Link to={benchmarkRevisionPath(benchmark.id)} className="text-fg hover:text-brand">{m.viewLatest}</Link>
          </div>
        )}

        {syncResult && syncResult.benchmark.id === benchmark.id && (
          <div role="status" data-testid="eval-sync-result" className="rounded-md bg-bg-surface p-3 text-sm text-fg">
            {(syncResult.changed ? m.syncCreated : m.syncNoChanges).replace("{n}", String(syncResult.benchmark.revision ?? "—"))}
          </div>
        )}

        {isHarbor && !isOld && <p className="text-xs text-fg-subtle">{m.harborReadOnly}</p>}

        {actionError && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {actionError}
          </div>
        )}

        {cases.length === 0 ? (
          <div className="text-center py-12 text-sm text-fg-subtle space-y-3">
            <p>{isHarbor ? m.noCasesInRevision : m.noCasesYet}</p>
            {!isHarbor && <Button size="sm" onClick={() => setShowAdd(true)}>{m.addCase}</Button>}
          </div>
        ) : (
          <div className="console-detail-table-wrap" data-testid="eval-benchmark-cases">
            <Table className="console-detail-table">
              <TableHeader variant="wireless">
                {isHarbor ? (
                  <TableRow variant="wireless">
                    <TableHead className={th}>{t.common.name}</TableHead>
                    <TableHead className={th}>{m.digest}</TableHead>
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
                      <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted align-top" title={c.digest}>{shortDigest(c.digest)}</TableCell>
                      <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted align-top whitespace-normal break-all">{c.image}</TableCell>
                      <TableCell className="px-3 py-2 text-xs align-top whitespace-normal"><AliasCell alias={c.image_alias} t={t} /></TableCell>
                      <TableCell className="px-3 py-2 text-xs align-top whitespace-normal"><SupportedCell c={c} t={t} /></TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top whitespace-normal">
                        {secs(c.agent_timeout_sec)} / {secs(c.verifier_timeout_sec)}
                      </TableCell>
                      <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums align-top whitespace-normal">
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

        {isHarbor && revisions.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-medium text-fg">{m.revisions}</h2>
            <div className="console-detail-table-wrap" data-testid="eval-benchmark-revisions">
              <Table className="console-detail-table">
                <TableHeader variant="wireless">
                  <TableRow variant="wireless">
                    <TableHead className={th}>{m.revision}</TableHead>
                    <TableHead className={th}>{m.created}</TableHead>
                    <TableHead className={th}>{m.cases}</TableHead>
                    <TableHead className={th}>{m.digest}</TableHead>
                    <TableHead className={th}>{m.pinnedCommits}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {revisions.map((r) => {
                    const isLatest = r.revision === benchmark.revision;
                    const isShown = r.revision === shownRevision;
                    return (
                      <TableRow variant="wireless" key={r.revision} data-testid={`eval-revision-${r.revision}`} className="bg-bg-surface/60">
                        <TableCell className="px-3 py-2 rounded-l-lg text-xs">
                          <Link
                            to={benchmarkRevisionPath(benchmark.id, isLatest ? undefined : r.revision)}
                            className={`tabular-nums hover:text-brand ${isShown ? "text-fg font-medium" : "text-fg-muted"}`}
                            aria-current={isShown ? "page" : undefined}
                          >
                            {m.revisionN.replace("{n}", String(r.revision))}
                          </Link>
                          {isLatest && <span className="ml-2 text-fg-subtle">{m.latestRevision}</span>}
                          {isShown && !isLatest && <span className="ml-2 text-warning">{m.viewingRevision}</span>}
                        </TableCell>
                        <TableCell className="px-3 py-2 text-xs text-fg-muted" title={r.created_at}>{formatDateTime(r.created_at)}</TableCell>
                        <TableCell className="px-3 py-2 text-xs text-fg-muted tabular-nums">{r.case_count}</TableCell>
                        <TableCell className="px-3 py-2 font-mono text-xs text-fg-muted" title={r.digest}>{shortDigest(r.digest)}</TableCell>
                        <TableCell className="px-3 py-2 rounded-r-lg text-xs"><PinList pins={r.pins} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </section>
        )}
      </div>

      <NewEvalRunDialog open={showRun} onClose={() => setShowRun(false)} initialBenchmarkId={benchmark.id} />
      <RenameBenchmarkDialog open={showRename} onClose={() => setShowRename(false)} benchmark={benchmark} />
      {isHarbor ? (
        <SyncBenchmarkDialog open={showSync} onClose={() => setShowSync(false)} benchmark={benchmark} onSynced={onSynced} />
      ) : (
        <MessagesCaseDialog open={showAdd} onClose={() => setShowAdd(false)} benchmarkId={benchmark.id} />
      )}
      <MessagesCaseDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        benchmarkId={benchmark.id}
        existing={editing ?? undefined}
      />
    </Page>
  );
}
