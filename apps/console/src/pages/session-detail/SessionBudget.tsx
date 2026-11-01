import { useState } from "react";
import { useI18n } from "../../i18n";
import {
  budgetUpdateBody,
  centsToDollars,
  costLabel,
  dollarsToCents,
  readBudgetCap,
} from "./budget";

/** Session budget (dollar cap) + accumulated list cost. The cap is enforced
 * only when the model card also has pricing; otherwise cost shows "unpriced". */
export function SessionBudget({
  budget,
  usage,
  onSave,
}: {
  budget: unknown;
  usage: unknown;
  onSave: (body: { budget: unknown }) => Promise<void>;
}) {
  const { t } = useI18n();
  const cap = readBudgetCap(budget);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const save = async (cents: string | null) => {
    setError(null);
    try {
      await onSave(budgetUpdateBody(cents));
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted flex-wrap" data-testid="session-budget">
      <span>
        {t.sessions.budgetCost}: <span className="text-fg">{costLabel(usage, t.sessions.budgetUnpriced)}</span>
      </span>
      {editing ? (
        <>
          <input
            aria-label={t.sessions.budgetCap}
            className="w-24 rounded border border-border bg-bg px-1 py-0.5"
            value={draft}
            placeholder="$10.00"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="button"
            onClick={() => {
              const cents = dollarsToCents(draft);
              if (cents === null) setError(t.sessions.budgetInvalid);
              else void save(cents);
            }}
          >
            {t.common.save}
          </button>
          <button type="button" onClick={() => setEditing(false)}>{t.common.cancel}</button>
        </>
      ) : cap ? (
        <>
          <span>
            {t.sessions.budgetCap}: <span className="text-fg">{centsToDollars(cap.amount)}</span>
          </span>
          <button type="button" onClick={() => { setDraft(centsToDollars(cap.amount)); setEditing(true); }}>
            {t.sessions.budgetEdit}
          </button>
          <button type="button" onClick={() => void save(null)}>{t.sessions.budgetRemove}</button>
        </>
      ) : (
        <span>{t.sessions.budgetNone}</span>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
