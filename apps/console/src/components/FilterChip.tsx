import { useState, type ReactNode } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Compact chip-style filter trigger used by every list page's toolbar.
 *
 * Decoration follows selection: nothing visible at rest (just `Label ▾`
 * text on transparent), only the actually-selected chip shows the
 * brand pill outline + bg + clear-X. Same principle as the sidebar
 * nav — an empty filter row visually weighs nothing.
 *
 * Built on shadcn Popover (Radix + Floating UI). PopoverContent hosts
 * whatever the caller wants — `<FacetedFilter>` for enum search-and-
 * pick, a hand-rolled preset list for time buckets, etc. Earlier
 * iteration used DropdownMenu but cmdk Command nested inside Radix
 * Menu fights for focus / keyboard control. Popover has identical
 * collision avoidance + auto-flip via the same Floating-UI primitive,
 * just without the menu semantics in the way.
 */
export function FilterChip({
  label,
  active,
  display,
  onClear,
  children,
}: {
  label: string;
  active: boolean;
  display?: string;
  onClear?: () => void;
  children: ReactNode;
}) {
  return (
    <Popover>
      <div
        className={cn(
          "inline-flex items-center gap-1 h-8 text-sm shrink-0 transition-colors",
          active
            ? "rounded-full border border-brand text-brand bg-brand-subtle"
            : "text-fg-muted hover:text-fg",
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex items-center gap-1 h-full outline-none",
              active ? "pl-3 pr-2" : "px-2",
            )}
          >
            <span className="font-medium">{label}</span>
            {display && (
              <>
                <span className="text-fg-subtle">:</span>
                <span>{display}</span>
              </>
            )}
            {!active && <ChevronDownIcon className="size-3.5 opacity-60" />}
          </button>
        </PopoverTrigger>
        {active && onClear && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="inline-flex items-center justify-center size-5 mr-1.5 rounded-full hover:bg-brand/10"
            aria-label={`Clear ${label} filter`}
          >
            <XIcon className="size-3" />
          </button>
        )}
      </div>
      {children}
    </Popover>
  );
}

// ── Created-at filter ───────────────────────────────────────────────
// Reusable across every list page that wants to slice by created_at.
// Internal state owns the preset choice + custom-range bounds; the
// page only sees the resolved `(after, before)` epoch-ms tuple via
// onChange. Both bounds nullable → "no bound on this side".

export type CreatedPreset =
  | "any"
  | "today"
  | "last-hour"
  | "last-day"
  | "last-7d"
  | "last-30d"
  | "custom";

export const CREATED_PRESET_LABELS: Record<CreatedPreset, string> = {
  any: "All time",
  today: "Today",
  "last-hour": "Last hour",
  "last-day": "Last day",
  "last-7d": "Last 7 days",
  "last-30d": "Last 30 days",
  custom: "Custom range",
};

function computePresetRange(
  preset: Exclude<CreatedPreset, "any" | "custom">,
): { after?: number; before?: number } {
  const now = Date.now();
  switch (preset) {
    case "today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { after: start.getTime() };
    }
    case "last-hour":
      return { after: now - 60 * 60 * 1000 };
    case "last-day":
      return { after: now - 24 * 60 * 60 * 1000 };
    case "last-7d":
      return { after: now - 7 * 24 * 60 * 60 * 1000 };
    case "last-30d":
      return { after: now - 30 * 24 * 60 * 60 * 1000 };
  }
}

/** Format epoch ms → YYYY-MM-DD for the native `<input type="date">`
 *  value attribute. Date pickers store local-tz dates as strings; we
 *  convert back to ms via `new Date(str).getTime()` (also local). The
 *  precision mismatch (day vs ms) is fine because the chip presets
 *  themselves resolve to coarse boundaries (today 00:00, etc). */
export function msToDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Drop-in Created-at chip. Owns its preset choice internally; surfaces
 * the resolved (after, before) epoch-ms bounds to the parent via
 * onChange so the parent can drop them straight into a server query
 * param.
 *
 * Label is configurable — pass "Created" / "Updated" / "Submitted"
 * etc. depending on the resource.
 */
export function CreatedFilterChip({
  label = "Created",
  value,
  onChange,
}: {
  label?: string;
  /** Currently-resolved bounds. `{}` = no filter. */
  value: { after?: number; before?: number };
  onChange: (v: { after?: number; before?: number }) => void;
}) {
  const [preset, setPreset] = useState<CreatedPreset>("any");
  const [customAfter, setCustomAfter] = useState<number | undefined>(value.after);
  const [customBefore, setCustomBefore] = useState<number | undefined>(value.before);

  const active = value.after !== undefined || value.before !== undefined;
  const display = preset === "any" ? undefined : CREATED_PRESET_LABELS[preset];

  const apply = (next: CreatedPreset, opts?: { after?: number; before?: number }) => {
    setPreset(next);
    if (next === "any") {
      onChange({});
      return;
    }
    if (next === "custom") {
      onChange({ after: opts?.after ?? customAfter, before: opts?.before ?? customBefore });
      return;
    }
    onChange(computePresetRange(next));
  };

  return (
    <FilterChip
      label={label}
      active={active}
      display={display}
      onClear={() => {
        setPreset("any");
        setCustomAfter(undefined);
        setCustomBefore(undefined);
        onChange({});
      }}
    >
      <PopoverContent
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="w-60 p-1"
      >
        {(Object.keys(CREATED_PRESET_LABELS) as CreatedPreset[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => apply(p)}
            className={cn(
              "w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm",
              "hover:bg-bg-surface",
              preset === p && "text-fg font-medium",
            )}
          >
            {CREATED_PRESET_LABELS[p]}
            {preset === p && <CheckIcon className="size-3.5 text-brand" />}
          </button>
        ))}
        {preset === "custom" && (
          <div className="mt-1 pt-2 border-t border-border space-y-2 px-1 pb-1">
            <label className="block">
              <span className="text-xs text-fg-muted mb-1 block">From</span>
              <Input
                type="date"
                value={msToDateInput(customAfter)}
                onChange={(e) => {
                  const v = e.target.value;
                  const next = v ? new Date(v).getTime() : undefined;
                  setCustomAfter(next);
                  apply("custom", { after: next, before: customBefore });
                }}
              />
            </label>
            <label className="block">
              <span className="text-xs text-fg-muted mb-1 block">To</span>
              <Input
                type="date"
                value={msToDateInput(customBefore)}
                onChange={(e) => {
                  const v = e.target.value;
                  // End of selected day so "<= that day" works as the
                  // user expects (otherwise picking 2026-05-24 would
                  // exclude that whole day since the filter is `<`).
                  let next: number | undefined;
                  if (v) {
                    const d = new Date(v);
                    d.setDate(d.getDate() + 1);
                    next = d.getTime();
                  }
                  setCustomBefore(next);
                  apply("custom", { after: customAfter, before: next });
                }}
              />
            </label>
          </div>
        )}
      </PopoverContent>
    </FilterChip>
  );
}
