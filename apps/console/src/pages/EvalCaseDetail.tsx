import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { TrashIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { useI18n } from "../i18n";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { MessagesCaseForm } from "./evals/MessagesCaseForm";
import { AliasCell, SupportedCell, secs } from "./EvalBenchmarkDetail";
import {
  benchmarkApiPath,
  benchmarkPath,
  benchmarkRevisionPath,
  caseApiPath,
  describeError,
  formatDateTime,
  invalidateBenchmarks,
  kindLabel,
  parseRevision,
  shortDigest,
  type EvalBenchmark,
  type EvalCaseDetail,
  type MessagesCaseInput,
} from "./evals/shared";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One case of a benchmark: harbor shows its instruction and stored files
 *  (read-only, of ?revision=N or the latest); messages shows the editable form. */
export function EvalCaseDetail() {
  const { benchmarkId = "", caseName = "" } = useParams<{ benchmarkId: string; caseName: string }>();
  const { t } = useI18n();
  const m = t.evals;
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const requestedRevision = parseRevision(searchParams.get("revision"));
  const [actionError, setActionError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { data: benchmark } = useApiQuery<EvalBenchmark>(benchmarkId ? benchmarkApiPath(benchmarkId) : null);
  const { data: c, isLoading, error } = useApiQuery<EvalCaseDetail>(
    benchmarkId && caseName ? caseApiPath(benchmarkId, caseName, requestedRevision) : null,
  );

  const remove = async () => {
    if (!confirm(m.confirmDeleteCase)) return;
    setActionError(null);
    try {
      await api(caseApiPath(benchmarkId, caseName), { method: "DELETE" });
      invalidateBenchmarks(queryClient);
      nav(benchmarkPath(benchmarkId));
    } catch (e) {
      setActionError(describeError(t, e));
    }
  };

  const save = async (input: MessagesCaseInput) => {
    setSaved(false);
    await api(caseApiPath(benchmarkId, caseName), { method: "PUT", body: JSON.stringify(input) });
    invalidateBenchmarks(queryClient);
    setSaved(true);
  };

  if (isLoading) return <div className="text-center py-16 text-fg-subtle">{t.common.loading}</div>;
  if (error) {
    return <div className="text-center py-16 text-danger">{error instanceof Error ? error.message : String(error)}</div>;
  }
  if (!c) return <div className="text-center py-16 text-fg-subtle">{m.caseNotFound}</div>;

  const sep = <span className="text-fg-subtle">·</span>;

  return (
    <Page>
      <div className="console-detail-stack">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <h1 className="font-mono text-base font-semibold truncate">{c.name}</h1>
            <span className="text-xs text-fg-muted">{kindLabel(t, c.kind)}</span>
            <div className="flex-1" />
            {c.kind === "messages" && (
              <Button size="sm" variant="outline" onClick={remove}>
                <TrashIcon className="size-4" />
                {t.common.delete}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <span>
              {m.benchmark}{" "}
              <Link
                to={benchmarkRevisionPath(benchmarkId, requestedRevision)}
                className="text-fg hover:text-brand"
              >
                {benchmark?.name ?? benchmarkId}
              </Link>
            </span>
            {sep}
            {c.kind === "harbor" && (
              <>
                <span data-testid="eval-case-revision">
                  {m.revision} <span className="text-fg tabular-nums">{c.revision}</span>
                  {benchmark?.revision != null && c.revision !== benchmark.revision && (
                    <span className="text-fg-subtle"> / {benchmark.revision}</span>
                  )}
                </span>
                {sep}
                <span>{m.digest} <span className="font-mono text-xs text-fg" title={c.digest}>{shortDigest(c.digest)}</span></span>
                {sep}
              </>
            )}
            <span>{m.updated} <span className="text-fg">{formatDateTime(c.updated_at)}</span></span>
            {c.kind === "harbor" && (
              <>
                {sep}
                <span className="font-mono text-xs break-all">{c.image}</span>
                {sep}
                <AliasCell alias={c.image_alias} t={t} />
                {sep}
                <span className="text-xs"><SupportedCell c={c} t={t} /></span>
                {sep}
                <span>{m.timeouts} <span className="text-fg tabular-nums">{secs(c.agent_timeout_sec)} / {secs(c.verifier_timeout_sec)}</span></span>
                {sep}
                <span>{m.hasSolution} <span className="text-fg">{c.has_solution ? m.yes : m.no}</span></span>
              </>
            )}
          </div>
        </div>

        {actionError && (
          <div role="alert" className="rounded-md bg-danger-subtle/40 p-3 text-sm text-danger whitespace-pre-wrap">
            {actionError}
          </div>
        )}

        {c.kind === "harbor" ? (
          <div className="space-y-6">
            <p className="text-xs text-fg-subtle">{m.harborReadOnly}</p>
            <section>
              <h2 className="text-sm font-medium text-fg mb-2">{m.instruction}</h2>
              <pre data-testid="eval-case-instruction" className="rounded-md bg-bg-surface p-3 text-xs whitespace-pre-wrap break-words max-h-[28rem] overflow-y-auto">
                {c.instruction}
              </pre>
            </section>
            <section>
              <h2 className="text-sm font-medium text-fg mb-2">{m.files}</h2>
              <ul data-testid="eval-case-files" className="rounded-md bg-bg-surface p-3 text-xs font-mono space-y-1">
                {c.files.map((f) => (
                  <li key={f.path} className="flex gap-3">
                    <span className="flex-1 break-all">{f.path}</span>
                    <span className="text-fg-muted tabular-nums">{formatSize(f.size)}</span>
                    {f.executable && <span className="text-fg-muted">{m.executable}</span>}
                  </li>
                ))}
              </ul>
            </section>
          </div>
        ) : (
          <div className="max-w-2xl space-y-3">
            {saved && <div role="status" className="text-sm text-success">{m.caseSaved}</div>}
            <MessagesCaseForm
              key={c.updated_at}
              initial={c}
              nameLocked
              submitLabel={m.save}
              busyLabel={m.saving}
              onSubmit={save}
            />
          </div>
        )}
      </div>

    </Page>
  );
}
