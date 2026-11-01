import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
          <Input
            aria-label={t.sessions.budgetCap}
            className="h-6 w-24 px-1 py-0.5 text-xs"
            value={draft}
            placeholder="$10.00"
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => {
              const cents = dollarsToCents(draft);
              if (cents === null) setError(t.sessions.budgetInvalid);
              else void save(cents);
            }}
          >
            {t.common.save}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>{t.common.cancel}</Button>
        </>
      ) : cap ? (
        <>
          <span>
            {t.sessions.budgetCap}: <span className="text-fg">{centsToDollars(cap.amount)}</span>
          </span>
          <Button type="button" variant="ghost" size="xs" onClick={() => { setDraft(centsToDollars(cap.amount)); setEditing(true); }}>
            {t.sessions.budgetEdit}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={() => void save(null)}>{t.sessions.budgetRemove}</Button>
        </>
      ) : (
        <span>{t.sessions.budgetNone}</span>
      )}
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
