import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

/** Compact chip-style filter trigger. Decoration follows selection,
 *  same principle as the sidebar nav: nothing visible at rest, only
 *  the actually-selected chip gets the brand pill outline + bg. Idle
 *  chips are bare `label ▾` text so an empty filter row visually
 *  weighs nothing; the toolbar reads as "nothing's filtered" without
 *  having to scan every chip for a value.
 *
 *  Built on shadcn DropdownMenu (Radix + Floating UI under the hood)
 *  for collision-aware positioning — auto-flips when there isn't
 *  enough room below, shifts to stay on screen, no hand-rolled
 *  positioning. */
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
    <DropdownMenu>
      <div
        className={cn(
          "inline-flex items-center gap-1 h-8 text-sm shrink-0 transition-colors",
          active
            ? "rounded-full border border-brand text-brand bg-brand-subtle"
            : "text-fg-muted hover:text-fg",
        )}
      >
        <DropdownMenuTrigger asChild>
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
        </DropdownMenuTrigger>
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
    </DropdownMenu>
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
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-44"
        >
          <DropdownMenuRadioGroup
            value={status}
            onValueChange={(v) => setStatus(v as StatusValue)}
          >
            {STATUS_OPTIONS.map((opt) => (
              <DropdownMenuRadioItem key={opt.value} value={opt.value}>
                {opt.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
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
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          collisionPadding={8}
          className="w-60"
        >
          <DropdownMenuRadioGroup
            value={createdPreset}
            onValueChange={(v) => setCreatedPreset(v as CreatedPreset)}
          >
            {(Object.keys(CREATED_PRESET_LABELS) as CreatedPreset[]).map((preset) => (
              <DropdownMenuRadioItem key={preset} value={preset}>
                {CREATED_PRESET_LABELS[preset]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {createdPreset === "custom" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-fg-subtle font-medium pt-0">
                Range
              </DropdownMenuLabel>
              {/* Date inputs sit inside the menu but must NOT close it
                  on interaction — DropdownMenuItem closes by default;
                  we use a plain div + stop pointer/key events so Radix's
                  menu typeahead and focus traps don't intercept the
                  input. */}
              <div
                className="px-2 pb-2 space-y-2"
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
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
            </>
          )}
        </DropdownMenuContent>
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
