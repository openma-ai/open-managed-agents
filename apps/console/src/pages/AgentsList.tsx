import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ModelCard } from "@open-managed-agents/api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";

type Runtime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  /** Skills daemon detected locally on the user's machine, keyed by acp
   *  agent id. Source for the blocklist multi-select that appears when
   *  the user picks an acp agent. */
  local_skills?: Record<
    string,
    Array<{
      id: string;
      name?: string;
      description?: string;
      source?: string;
      source_label?: string;
    }>
  >;
};

// ── Filter primitives ────────────────────────────────────────────────
// Inline (only used by this page right now). Extract to its own module
// the second time a list page needs the same chip pattern. Per the
// project's no-future-proofing rule, we don't bake a generic
// "FilterRegistry" until that second caller materializes.

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

/** Preset Created-at buckets. `after`/`before` returned in epoch ms;
 *  `null` means "no bound on this side". Driven by the chip's static
 *  options below. Generated lazily because `Date.now()` rolls forward
 *  while the page is open — recomputed every time the chip opens so
 *  "Today" picks up date changes after midnight. */
type CreatedPreset =
  | "any"
  | "today"
  | "last-hour"
  | "last-day"
  | "last-7d"
  | "last-30d"
  | "custom";

const CREATED_PRESET_LABELS: Record<CreatedPreset, string> = {
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

/** Compact filter trigger that lives in the toolbar alongside the
 *  primary CTA and search input. Shape and height are intentionally
 *  identical to shadcn `Button` (h-9, rounded-md, border-border), so
 *  the whole row reads as one visual family — the `+ New` primary
 *  button, the chips, and the search box on the right all share the
 *  same baseline + corner radius. Active state stays subtle: brand
 *  text + a `bg-brand-subtle` wash, no pill silhouette change. */
function FilterChip({
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
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <div
        className={cn(
          "inline-flex items-center h-9 rounded-md border text-sm shrink-0 transition-colors overflow-hidden",
          active
            ? "border-brand/40 text-brand bg-brand-subtle"
            : "border-border text-fg hover:bg-bg-surface bg-transparent",
        )}
      >
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 px-3 h-full"
          >
            <span className={cn(active ? "font-medium" : "text-fg-muted")}>
              {label}
            </span>
            {display && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="font-medium">{display}</span>
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
            className="inline-flex items-center justify-center w-7 h-full border-l border-brand/20 hover:bg-brand/10"
            aria-label={`Clear ${label} filter`}
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>
      {children}
    </Popover>
  );
}

/** Format epoch ms → YYYY-MM-DD for the native `<input type="date">`
 *  value attribute. Date pickers store local-tz dates as strings; we
 *  convert back to ms via `new Date(str).getTime()` (also local). The
 *  precision mismatch (day vs ms) is fine because the chip presets
 *  themselves resolve to coarse boundaries (today 00:00, etc). */
function msToDateInput(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  // Server-driven filter state. Each piece flows into agentsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [createdPreset, setCreatedPreset] = useState<CreatedPreset>("any");
  const [customAfter, setCustomAfter] = useState<number | undefined>();
  const [customBefore, setCustomBefore] = useState<number | undefined>();
  const [search, setSearch] = useState("");

  // Derive the actual (after, before) bounds from the preset choice.
  // `custom` reads from the two date-picker states; the other presets
  // recompute from Date.now() so the bucket walks forward as time
  // passes (Today rolls over at midnight, Last 7 days slides daily).
  const { createdAfter, createdBefore } = useMemo(() => {
    if (createdPreset === "any") return { createdAfter: undefined, createdBefore: undefined };
    if (createdPreset === "custom")
      return { createdAfter: customAfter, createdBefore: customBefore };
    const r = computePresetRange(createdPreset);
    return { createdAfter: r.after, createdBefore: r.before };
  }, [createdPreset, customAfter, customBefore]);

  // Main agents table — paginated. Any change to these params resets to
  // page 0 automatically (paramsKey is part of the query key).
  const agentsParams = useMemo(
    () => ({
      status,
      ...(createdAfter !== undefined
        ? { created_after: new Date(createdAfter).toISOString() }
        : {}),
      ...(createdBefore !== undefined
        ? { created_before: new Date(createdBefore).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, createdAfter, createdBefore, search],
  );
  const {
    items: agents,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshAgents,
  } = useInfiniteApiQuery<Agent>("/v1/agents", { limit: 20, params: agentsParams });

  // Aux fetches that aren't paginated UI surfaces — refreshed on mount and
  // after agent CRUD. Pull all agents (for the callable-agents dropdown)
  // separately so it isn't constrained by the main list's page size.
  //
  // Failures of the secondary fetches (skills / model cards / runtimes) are
  // tolerated and logged: missing data degrades a dropdown but shouldn't
  // block agent CRUD. Failures of the primary `/v1/agents` call surface
  // via the toast that `useApi` raises automatically; setting `auxLoading`
  // back to false in `finally` keeps the spinner from getting stuck.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any");
      setAllAgents(all.data);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          setCustomSkills(sk.data);
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          setModelCards(mc.data);
        })().catch((e) => console.warn("[AgentsList] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<{ runtimes: Runtime[] }>("/v1/runtimes");
          setRuntimes(rt.runtimes);
        })().catch((e) => console.warn("[AgentsList] /v1/runtimes aux fetch failed", e)),
      ]);
    } finally {
      setAuxLoading(false);
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  const modelStr = (m: Agent["model"]) => (typeof m === "string" ? m : m?.id || "");

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end
  // up with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "model",
        accessorFn: (a) => modelStr(a.model),
        header: "Model",
        cell: ({ row }) => (
          <span className="text-fg-muted">{modelStr(row.original.model)}</span>
        ),
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.archived_at
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.archived_at ? "archived" : "active"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
    ],
    [],
  );

  // Active-filter chip displays — kept null when matching the default so
  // the chip reads "Status ▾" rather than "Status: All ▾". The clear-X
  // only renders when the chip is in non-default state.
  const statusDisplay =
    status === "any" ? undefined : STATUS_OPTIONS.find((o) => o.value === status)?.label;
  const createdDisplay =
    createdPreset === "any" ? undefined : CREATED_PRESET_LABELS[createdPreset];

  const filters = (
    <>
      <FilterChip
        label="Status"
        active={status !== "any"}
        display={statusDisplay}
        onClear={() => setStatus("any")}
      >
        <PopoverContent align="start" className="w-44 p-1">
          {STATUS_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setStatus(opt.value)}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm",
                "hover:bg-bg-surface",
                status === opt.value && "text-fg font-medium",
              )}
            >
              {opt.label}
              {status === opt.value && <CheckIcon className="size-3.5 text-brand" />}
            </button>
          ))}
        </PopoverContent>
      </FilterChip>

      <FilterChip
        label="Created"
        active={createdPreset !== "any"}
        display={createdDisplay}
        onClear={() => {
          setCreatedPreset("any");
          setCustomAfter(undefined);
          setCustomBefore(undefined);
        }}
      >
        <PopoverContent align="start" className="w-60 p-1">
          {(Object.keys(CREATED_PRESET_LABELS) as CreatedPreset[]).map((preset) => (
            <button
              key={preset}
              type="button"
              onClick={() => setCreatedPreset(preset)}
              className={cn(
                "w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm",
                "hover:bg-bg-surface",
                createdPreset === preset && "text-fg font-medium",
              )}
            >
              {CREATED_PRESET_LABELS[preset]}
              {createdPreset === preset && <CheckIcon className="size-3.5 text-brand" />}
            </button>
          ))}
          {createdPreset === "custom" && (
            <div className="mt-1 pt-2 border-t border-border space-y-2 px-1 pb-1">
              <label className="block">
                <span className="text-xs text-fg-muted mb-1 block">From</span>
                <Input
                  type="date"
                  value={msToDateInput(customAfter)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCustomAfter(v ? new Date(v).getTime() : undefined);
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
                    if (!v) {
                      setCustomBefore(undefined);
                      return;
                    }
                    const d = new Date(v);
                    d.setDate(d.getDate() + 1);
                    setCustomBefore(d.getTime());
                  }}
                />
              </label>
            </div>
          )}
        </PopoverContent>
      </FilterChip>
    </>
  );

  return (
    <DataTable<Agent>
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search agents..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={agents}
      loading={loading}
      getRowId={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching agents" : "No agents yet"}
      emptyKind="agent"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>+ New agent</Button>
      }
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>Create your first agent to get started.</p>
            <button
              onClick={() => nav("/")}
              className="inline-flex items-center min-h-11 sm:min-h-0 mt-3 text-sm text-brand hover:underline"
            >
              Get started with the quickstart guide →
            </button>
          </>
        )
      }
      columns={columns}
    >
      <AgentFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refreshAgents}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
        runtimes={runtimes}
      />
    </DataTable>
  );
}
