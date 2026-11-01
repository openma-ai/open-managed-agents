import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { useI18n } from "../i18n";
import { useManagedApi } from "../lib/useManagedApi";
import { SessionBudget } from "./session-detail/SessionBudget";
import { centsToDollars, readListCostCents } from "./session-detail/budget";

interface BudgetRow {
  id: string;
  title: string | null;
  model: string;
  budget: unknown;
  usage: unknown;
}

function modelOf(agent: unknown): string {
  if (agent === null || typeof agent !== "object") return "—";
  const model = (agent as { model?: unknown }).model;
  if (typeof model === "string") return model;
  if (model !== null && typeof model === "object") {
    const id = (model as { id?: unknown }).id;
    if (typeof id === "string") return id;
  }
  return "—";
}

/** Budget page: spend (list_cost recorded at model egress) per session and
 * per model, plus the per-session max_list_cost cap editor. */
export function Budget() {
  const { t } = useI18n();
  const managedApi = useManagedApi();
  const [rows, setRows] = useState<BudgetRow[]>([]);
  const [page, setPage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (cursor: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const res = await managedApi.sessions.list({ limit: 50, ...(cursor ? { page: cursor } : {}) });
      const next = res.data.map((s): BudgetRow => ({
        id: s.id,
        title: s.title ?? null,
        model: modelOf(s.agent),
        budget: (s as { budget?: unknown }).budget ?? null,
        usage: s.usage ?? null,
      }));
      setRows((prev) => (cursor ? [...prev, ...next] : next));
      setPage(res.next_page ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [managedApi]);

  useEffect(() => { void load(null); }, [load]);

  const byModel = useMemo(() => {
    const totals = new Map<string, bigint>();
    for (const row of rows) {
      const cents = readListCostCents(row.usage);
      if (cents === null) continue;
      totals.set(row.model, (totals.get(row.model) ?? 0n) + BigInt(cents));
    }
    return [...totals.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  }, [rows]);

  const save = (id: string) => async (body: { budget: unknown }) => {
    const updated = await managedApi.sessions.update(id, body as Parameters<typeof managedApi.sessions.update>[1]);
    setRows((prev) => prev.map((row) => row.id === id
      ? { ...row, budget: (updated as { budget?: unknown }).budget ?? null, usage: updated.usage ?? row.usage }
      : row));
  };

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="budget-page">
      <div>
        <h1 className="text-lg font-semibold text-fg">{t.budget.title}</h1>
        <p className="text-sm text-fg-muted">{t.budget.subtitle}</p>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">{t.budget.byModel}</h2>
        {byModel.length === 0 ? (
          <p className="text-xs text-fg-muted">{t.budget.noSpend}</p>
        ) : (
          <ul className="text-xs text-fg-muted flex flex-col gap-1">
            {byModel.map(([model, cents]) => (
              <li key={model}>
                <span className="text-fg">{model}</span>: {centsToDollars(cents.toString())}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium text-fg">{t.budget.bySession}</h2>
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 py-2">
              <div className="flex items-center gap-2 text-sm">
                <Link to={`/sessions/${row.id}`} className="text-fg hover:underline">{row.title || row.id}</Link>
                <span className="text-xs text-fg-subtle">{row.model}</span>
              </div>
              <SessionBudget budget={row.budget} usage={row.usage} onSave={save(row.id)} />
            </li>
          ))}
        </ul>
        {page && (
          <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load(page)}>
            {t.budget.loadMore}
          </Button>
        )}
      </section>
    </div>
  );
}
