import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { toast } from "sonner";
import { formatDuration } from "../../lib/format";
import type { Event } from "../../lib/events";
import {
  EMPTY_FILTER,
  STEP_FILTER_KINDS,
  autoPxPerMs,
  buildTimeScale,
  buildTrace,
  buildTurnTree,
  clampScroll,
  extractDiff,
  fitPxPerMs,
  hiddenLifecycleCount,
  formatClock,
  formatTokens,
  gapLabel,
  isFilterActive,
  layoutOverview,
  nodeSteps,
  stepMatches,
  toolCounts,
  transcriptText,
  turnTriggerLabel,
  viewportForRange,
  visibleWallRange,
  wallTicks,
  zoomAround,
  CONTEXT_REASSEMBLED_SOURCE,
  type StepFilter,
  type StepFilterKind,
  type TimeScale,
  type TraceAgentNode,
  type TraceGap,
  type TraceGroupNode,
  type TraceNode,
  type TraceProjection,
  type TraceTurn,
  type Viewport,
  type ViewportBounds,
} from "../../lib/trajectory-steps";
import { resolveTurnExpanded } from "./eventTime";
import { FAMILY_BAR, FAMILY_DOT, MAX_MANUAL_CHART_PX, type TraceStep } from "./types";

/**
 * Unified Trace view — the single execution viewer for a session.
 *
 * Layout follows the OpenAI Agents trace page:
 *   top    wall-clock session overview (time axis, legend, zoom
 *          auto / fit / − / +, fit selection, brush-to-zoom): turns on the
 *          first row, model / tool / wait steps packed into lanes below;
 *   left   collapsible tree Turn › (Agent, only with real thread
 *          ancestry) › steps, with durations and failed / pending state,
 *          plus the original Timeline idle dividers between turns;
 *   right  details for the selected turn / step / gap.
 *
 * Behaviour carried over from the original Timeline:
 *   - turns = user trigger → status_idle / status_terminated / error;
 *   - only the latest turn starts expanded; user overrides win; collapsed
 *     turns render no step rows;
 *   - "↓ {duration} idle[ · scheduled wakeup]" between turns only when the
 *     previous turn closed and the next trigger is later. New: each idle
 *     gap can be collapsed on the overview axis — its marker and true
 *     duration stay, and "Restore" brings back the full wall-clock gap;
 *   - auto density (median gap ≈ 25px, capped), fit, − / +.
 * Wall clock is the default; nothing is compressed unless the user asks.
 */

export interface TraceFact {
  label: string;
  value: ReactNode;
}

type Selection =
  | { type: "step"; key: string }
  | { type: "turn"; key: string }
  | { type: "gap"; key: string }
  | { type: "node"; key: string };

type ZoomMode = "auto" | "fit" | "manual";

const FALLBACK_VIEWPORT_PX = 800;
const ROW0_TOP = 10;
const LANE_TOP = 30;
const LANE_H = 13;
const BAR_H = 8;
const AXIS_H = 20;

const FILTER_LABEL: Record<StepFilterKind, string> = {
  user: "User",
  assistant: "Assistant",
  thinking: "Thinking",
  model: "Generation",
  tool: "Tools",
  compaction: "Compaction",
  error: "Errors",
};

const HATCH = "repeating-linear-gradient(135deg, var(--border-strong) 0 1px, transparent 1px 6px)";
const STRIPES = "repeating-linear-gradient(135deg, rgb(255 255 255 / 0.45) 0 3px, transparent 3px 6px)";

function stepDurationText(s: TraceStep): string {
  if (s.instant) return "·";
  if (s.durationMs === null) return s.pending ? "pending" : "—";
  return formatDuration(s.durationMs);
}

function clockOrUnknown(ts: number | null): string {
  return ts === null ? "unknown" : `${new Date(ts).toLocaleDateString()} ${formatClock(ts, 1)}`;
}

function stepBarClass(s: TraceStep): string {
  return s.isError ? "bg-danger/80" : FAMILY_BAR[s.family];
}

function stepDotClass(s: TraceStep): string {
  return s.isError ? "bg-danger" : FAMILY_DOT[s.family];
}

function stringifyCapped(v: unknown, maxChars = 50_000): string {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v, null, 2) ?? String(v);
  } catch {
    return "[unserializable]";
  }
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n… truncated (${s.length - maxChars} more chars)`;
}

/**
 * Positioned overview bar. Wraps the shared ghost Button but neutralises its
 * sizing/padding; the colour lives on an inner span so the button's hover
 * background can't repaint the bar.
 */
function BarButton({
  fill,
  fillStyle,
  selected,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size"> & { fill: string; fillStyle?: CSSProperties; selected: boolean }) {
  return (
    <Button
      variant="ghost"
      type="button"
      className={cn(
        "absolute p-0 min-w-0 h-auto rounded-full border-0 overflow-hidden active:not-aria-[haspopup]:translate-y-0",
        "hover:z-10 hover:ring-1 hover:ring-fg/30 focus-visible:ring-2 focus-visible:ring-info focus-visible:z-20",
        selected && "ring-2 ring-info ring-offset-1 ring-offset-bg z-20",
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn("absolute inset-0 rounded-[inherit]", fill)} style={fillStyle} />
      {children}
    </Button>
  );
}

function rowSelector(id: string): string {
  return `[data-row-id="${id.replace(/["\\]/g, "\\$&")}"]`;
}

type StepIndex = Map<string, { step: TraceStep; turn: TraceTurn }>;
type NodeIndex = Map<string, { node: TraceGroupNode | TraceAgentNode; turn: TraceTurn }>;

export function TraceView({
  events,
  facts,
  actions,
  notice,
  footer,
}: {
  /** Live session events or trajectory envelope rows. */
  events: readonly unknown[];
  /** Extra header facts (trajectory id, outcome, …). */
  facts?: TraceFact[];
  /** Extra header actions (Download JSON, …). */
  actions?: ReactNode;
  /** Status strip under the header (envelope loading / error). */
  notice?: ReactNode;
  /** Secondary content under the inspector (raw JSON disclosure). */
  footer?: ReactNode;
}) {
  const p = useMemo(() => buildTrace(events), [events]);
  const [filter, setFilter] = useState<StepFilter>(EMPTY_FILTER);
  /** turnKey → explicit expanded override. Absent = auto (latest only). */
  const [turnOverrides, setTurnOverrides] = useState<Record<string, boolean>>({});
  const [nodeOverrides, setNodeOverrides] = useState<Record<string, boolean>>({});
  /** Idle gaps the user collapsed on the overview axis. Default: none (wall clock). */
  const [collapsedGaps, setCollapsedGaps] = useState<ReadonlySet<string>>(() => new Set());
  /** Selected event / turn / gap / group → inspector. */
  const [selection, setSelection] = useState<Selection | null>(null);
  /** Brushed wall-clock range on the overview (independent of `selection`). */
  const [range, setRange] = useState<TimeRange | null>(null);
  const [scrollTarget, setScrollTarget] = useState<string | null>(null);

  const filterActive = isFilterActive(filter);
  const latestTurnKey = p.turns.length ? p.turns[p.turns.length - 1]!.key : undefined;

  const visibleStepsByTurn = useMemo(
    () => p.turns.map((t) => (filterActive ? t.steps.filter((s) => stepMatches(s, filter)) : t.steps)),
    [p, filter, filterActive],
  );
  const treeByTurn = useMemo(
    () => p.turns.map((t, i) => buildTurnTree(t.key, visibleStepsByTurn[i]!, p)),
    [p, visibleStepsByTurn],
  );

  const stepIndex: StepIndex = useMemo(() => {
    const m: StepIndex = new Map();
    for (const t of p.turns) for (const s of t.steps) m.set(s.key, { step: s, turn: t });
    return m;
  }, [p]);
  const nodeIndex: NodeIndex = useMemo(() => {
    const m: NodeIndex = new Map();
    const walk = (nodes: TraceNode[], turn: TraceTurn) => {
      for (const n of nodes) {
        if (n.type === "step") continue;
        m.set(n.key, { node: n, turn });
        if (n.type === "agent") walk(n.children, turn);
      }
    };
    treeByTurn.forEach((nodes, i) => walk(nodes, p.turns[i]!));
    return m;
  }, [p, treeByTurn]);

  const turnExpanded = useCallback(
    (t: TraceTurn, i: number) => {
      if (filterActive && !Object.prototype.hasOwnProperty.call(turnOverrides, t.key)) {
        return visibleStepsByTurn[i]!.length > 0;
      }
      return resolveTurnExpanded(t.key, latestTurnKey, turnOverrides);
    },
    [filterActive, latestTurnKey, turnOverrides, visibleStepsByTurn],
  );
  const nodeOpen = useCallback(
    (n: TraceGroupNode | TraceAgentNode) => nodeOverrides[n.key] ?? n.type === "agent",
    [nodeOverrides],
  );

  /** Select something and make sure it is visible in the tree. */
  const reveal = useCallback(
    (sel: Selection, scroll: boolean) => {
      setSelection(sel);
      if (sel.type === "step") {
        const hit = stepIndex.get(sel.key);
        if (hit) setTurnOverrides((o) => ({ ...o, [hit.turn.key]: true }));
        const containers = [...nodeIndex].filter(([, v]) => nodeSteps(v.node).some((s) => s.key === sel.key)).map(([k]) => k);
        if (containers.length) setNodeOverrides((o) => ({ ...o, ...Object.fromEntries(containers.map((k) => [k, true])) }));
        // A step hidden by the current filter can't be shown — drop the filter.
        if (hit && filterActive && !stepMatches(hit.step, filter)) setFilter(EMPTY_FILTER);
      } else if (sel.type === "node") {
        const hit = nodeIndex.get(sel.key);
        if (hit) setTurnOverrides((o) => ({ ...o, [hit.turn.key]: true }));
      }
      if (scroll) setScrollTarget(`${sel.type}:${sel.key}`);
    },
    [stepIndex, nodeIndex, filterActive, filter],
  );

  useEffect(() => {
    if (!scrollTarget) return;
    const el = document.querySelector<HTMLElement>(rowSelector(scrollTarget));
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
    setScrollTarget(null);
  }, [scrollTarget]);

  const toggleGap = useCallback((key: string) => {
    setCollapsedGaps((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const copyTranscript = async () => {
    try {
      await navigator.clipboard.writeText(transcriptText(p, filterActive ? (s) => stepMatches(s, filter) : undefined));
      toast.success("Transcript copied");
    } catch {
      toast.error("Could not copy transcript");
    }
  };

  if (p.events.length === 0) {
    return (
      <div className="flex-1 flex flex-col min-h-0 min-w-0" data-trace-root>
        {actions && <div className="px-4 sm:px-6 pt-3 flex flex-wrap justify-end gap-2">{actions}</div>}
        {notice}
        <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle p-6 text-center">
          No events yet — send a message to populate the trace.
        </div>
        {footer}
      </div>
    );
  }

  const visibleCount = visibleStepsByTurn.reduce((n, s) => n + s.length, 0);

  return (
    <div className="flex-1 flex flex-col min-h-0 min-w-0 max-w-full overflow-y-auto overflow-x-hidden md:overflow-y-hidden" data-trace-root>
      <TraceHeader
        p={p}
        facts={facts}
        actions={
          <>
            <Button variant="outline" size="xs" onClick={() => void copyTranscript()}>
              Copy transcript
            </Button>
            {actions}
          </>
        }
      />
      {notice}
      <Overview
        p={p}
        collapsedGaps={collapsedGaps}
        onToggleAllIdle={() =>
          setCollapsedGaps((cur) => {
            const idle = p.gaps.filter((g) => g.kind === "idle").map((g) => g.key);
            const allCollapsed = idle.length > 0 && idle.every((k) => cur.has(k));
            return allCollapsed ? new Set() : new Set(idle);
          })
        }
        selection={selection}
        stepIndex={stepIndex}
        nodeIndex={nodeIndex}
        onSelect={(sel) => reveal(sel, true)}
        range={range}
        onRangeChange={setRange}
      />
      <FilterBar
        filter={filter}
        setFilter={setFilter}
        tools={toolCounts(p.steps)}
        total={p.steps.length}
        visible={visibleCount}
        hiddenLifecycle={hiddenLifecycleCount(p.steps, filter)}
        hasCompaction={p.steps.some((s) => s.family === "compaction")}
      />
      <div className="grid grid-cols-1 md:grid-cols-[minmax(260px,40%)_minmax(0,1fr)] md:flex-1 md:min-h-0 border-t border-border min-w-0">
        <TraceTree
          p={p}
          treeByTurn={treeByTurn}
          filterActive={filterActive}
          noMatches={filterActive && visibleCount === 0}
          turnExpanded={turnExpanded}
          nodeOpen={nodeOpen}
          collapsedGaps={collapsedGaps}
          selection={selection}
          onSelect={(sel) => reveal(sel, false)}
          onToggleTurn={(t, expanded) => setTurnOverrides((o) => ({ ...o, [t.key]: !expanded }))}
          onToggleNode={(n) => setNodeOverrides((o) => ({ ...o, [n.key]: !nodeOpen(n) }))}
          onToggleGap={toggleGap}
        />
        <aside aria-label="Event details" className="min-w-0 md:overflow-y-auto flex flex-col">
          <Inspector
            p={p}
            selection={selection}
            stepIndex={stepIndex}
            nodeIndex={nodeIndex}
            collapsedGaps={collapsedGaps}
            onToggleGap={toggleGap}
            onSelect={(sel) => reveal(sel, true)}
            onClose={() => setSelection(null)}
          />
          {footer}
        </aside>
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────

/** Header facts for compaction, only when the stream has compaction events. */
function compactionFacts(p: TraceProjection): TraceFact[] {
  const spans = p.steps.filter((s) => s.compaction?.role === "summarize").length;
  const boundaries = p.steps.filter((s) => s.compaction?.role === "boundary").length;
  const orphans = p.steps.filter((s) => s.compaction?.role === "orphan_end").length;
  if (!spans && !boundaries && !orphans) return [];
  const parts = [
    boundaries ? `${boundaries} boundar${boundaries === 1 ? "y" : "ies"}` : null,
    spans ? `${spans} summarize` : null,
    orphans ? `${orphans} unpaired end` : null,
  ].filter(Boolean);
  return [
    { label: "Compactions", value: parts.join(" · ") },
    {
      label: "Compaction tokens in / out",
      value: p.compactionTokens ? `${formatTokens(p.compactionTokens.input)} / ${formatTokens(p.compactionTokens.output)}` : "not reported",
    },
  ];
}

function TraceHeader({ p, facts, actions }: { p: TraceProjection; facts?: TraceFact[]; actions: ReactNode }) {
  const last = p.turns[p.turns.length - 1];
  const status = last ? (last.turn.queued ? "queued" : last.turn.status) : "—";
  const items: TraceFact[] = [
    { label: "Status", value: status },
    { label: "Started", value: clockOrUnknown(p.startTs) },
    { label: "Last activity", value: clockOrUnknown(p.endTs) },
    { label: "Wall clock", value: p.startTs !== null && p.endTs !== null ? formatDuration(p.endTs - p.startTs) : "unknown" },
    { label: "Model", value: p.models.length ? p.models.join(", ") : "not reported" },
    { label: "Turns", value: p.turns.length },
    { label: "Tool calls", value: p.toolCalls },
    { label: "Errors", value: p.errors },
    {
      label: "Tokens in / out",
      value: p.tokens ? `${formatTokens(p.tokens.input)} / ${formatTokens(p.tokens.output)}` : "not reported",
    },
    ...compactionFacts(p),
    ...(facts ?? []),
  ];
  return (
    <div className="px-4 sm:px-6 pt-3 pb-2 flex flex-wrap items-start gap-x-6 gap-y-2 min-w-0">
      <dl role="region" aria-label="Trace summary" className="flex flex-wrap gap-x-6 gap-y-2 min-w-0 flex-1">
        {items.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[11px] leading-4 text-fg-subtle">{f.label}</dt>
            <dd className="text-xs leading-5 text-fg font-medium tabular-nums truncate max-w-[18rem]">{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────

/** A brushed wall-clock range. Kept in real timestamps so it survives
 *  collapsing / restoring idle gaps (display coordinates change, wall
 *  time doesn't). */
export interface TimeRange {
  startTs: number;
  endTs: number;
}

function selectionRange(
  sel: Selection | null,
  p: TraceProjection,
  stepIndex: StepIndex,
  nodeIndex: NodeIndex,
): TimeRange | null {
  if (!sel) return null;
  let r: { startTs: number | null; endTs: number | null } | null = null;
  if (sel.type === "step") {
    const s = stepIndex.get(sel.key)?.step;
    if (s) r = { startTs: s.startTs, endTs: s.endTs ?? (s.pending ? p.endTs : s.startTs) };
  } else if (sel.type === "turn") {
    const t = p.turns.find((x) => x.key === sel.key);
    if (t) r = { startTs: t.startTs, endTs: t.endTs ?? t.lastTs };
  } else if (sel.type === "gap") {
    const g = p.gaps.find((x) => x.key === sel.key);
    if (g) r = { startTs: g.startTs, endTs: g.endTs };
  } else {
    const n = nodeIndex.get(sel.key)?.node;
    if (n) r = { startTs: n.startTs, endTs: n.endTs };
  }
  if (!r || r.startTs === null) return null;
  return { startTs: r.startTs, endTs: Math.max(r.startTs, r.endTs ?? r.startTs) };
}

function selectionNoun(sel: Selection): string {
  return sel.type === "step" ? "event" : sel.type === "node" ? "group" : sel.type;
}

function fmtRate(ppms: number): string {
  const pps = ppms * 1000;
  if (pps >= 100) return `${Math.round(pps)} px/s`;
  if (pps >= 1) return `${pps.toFixed(1)} px/s`;
  return `${pps.toFixed(2)} px/s`;
}

function fmtRange(r: TimeRange, stepMs = 1000): string {
  return `${formatClock(r.startTs, stepMs)} – ${formatClock(r.endTs, stepMs)}`;
}

const BRUSH_MIN_PX = 4;
/** Ticks closer than this to a collapsed-gap label are dropped so labels never overlap. */
const BREAK_LABEL_CLEAR_PX = 44;

function Overview({
  p,
  collapsedGaps,
  onToggleAllIdle,
  selection,
  stepIndex,
  nodeIndex,
  onSelect,
  range,
  onRangeChange,
}: {
  p: TraceProjection;
  collapsedGaps: ReadonlySet<string>;
  onToggleAllIdle: () => void;
  selection: Selection | null;
  stepIndex: StepIndex;
  nodeIndex: NodeIndex;
  onSelect: (sel: Selection) => void;
  /** Brushed time range (distinct from the selected event). */
  range: TimeRange | null;
  onRangeChange: (r: TimeRange | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [viewportPx, setViewportPx] = useState(FALLBACK_VIEWPORT_PX);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState<{ mode: ZoomMode; pxPerMs: number | null }>({ mode: "auto", pxPerMs: null });
  const pendingScroll = useRef<number | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);
  const helpId = useId();

  const scale: TimeScale | null = useMemo(() => {
    if (p.startTs === null || p.endTs === null) return null;
    const collapsed = p.gaps
      .filter((g) => g.kind === "idle" && collapsedGaps.has(g.key) && g.startTs !== null && g.endTs !== null)
      .map((g) => ({ key: g.key, startTs: g.startTs!, endTs: g.endTs! }));
    return buildTimeScale(p.startTs, Math.max(p.endTs, p.startTs + 1), collapsed);
  }, [p, collapsedGaps]);
  const layout = useMemo(() => (scale ? layoutOverview(p, scale) : null), [p, scale]);
  const hasScale = scale !== null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setViewportPx(el.clientWidth > 0 ? el.clientWidth : FALLBACK_VIEWPORT_PX);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasScale]);

  const total = scale?.total ?? 1;
  const bounds: ViewportBounds = { total, viewportPx, maxPxPerMs: MAX_MANUAL_CHART_PX / total };
  const fit = fitPxPerMs(bounds);
  const pxPerMs =
    zoom.mode === "fit" || !layout
      ? fit
      : zoom.mode === "auto"
        ? autoPxPerMs(layout.boundaries, total, viewportPx)
        : Math.min(Math.max(fit, bounds.maxPxPerMs), Math.max(fit, zoom.pxPerMs ?? fit));
  const chartPx = Math.max(1, total * pxPerMs);
  const scrollNow = clampScroll(scrollLeft, pxPerMs, bounds);

  // Collapsing / restoring a gap changes display coordinates: keep the
  // same wall-clock instant in the middle of the viewport.
  const prevView = useRef<{ scale: TimeScale | null; pxPerMs: number; scrollLeft: number }>({ scale, pxPerMs, scrollLeft: scrollNow });
  useLayoutEffect(() => {
    const prev = prevView.current;
    if (prev.scale && scale && prev.scale !== scale && prev.scrollLeft > 0 && pendingScroll.current === null) {
      const centerWall = prev.scale.toWall((prev.scrollLeft + viewportPx / 2) / prev.pxPerMs);
      pendingScroll.current = clampScroll(scale.toDisplay(centerWall) * pxPerMs - viewportPx / 2, pxPerMs, bounds);
    }
  }, [scale]); // only on scale change; reads the previous commit via prevView
  useLayoutEffect(() => {
    if (pendingScroll.current !== null && scrollRef.current) {
      const next = clampScroll(pendingScroll.current, pxPerMs, bounds);
      scrollRef.current.scrollLeft = next;
      pendingScroll.current = null;
      if (next !== scrollLeft) setScrollLeft(next);
    }
    prevView.current = { scale, pxPerMs, scrollLeft: scrollNow };
  });

  const apply = (v: Viewport) => {
    pendingScroll.current = v.scrollLeft;
    setZoom({ mode: "manual", pxPerMs: v.pxPerMs });
  };
  const zoomToWall = (r: TimeRange, padFrac = 0) => {
    if (!scale) return;
    const d0 = scale.toDisplay(r.startTs);
    const d1 = scale.toDisplay(r.endTs);
    const pad = padFrac > 0 ? Math.max((d1 - d0) * padFrac, total * 0.01) : 0;
    apply(viewportForRange(d0 - pad, d1 + pad, bounds));
  };
  const zoomBy = (factor: number) => apply(zoomAround((scrollNow + viewportPx / 2) / pxPerMs, pxPerMs, factor, bounds));
  const fullSession = () => {
    pendingScroll.current = 0;
    setZoom({ mode: "fit", pxPerMs: null });
    onRangeChange(null);
  };
  const autoDensity = () => {
    pendingScroll.current = 0;
    setZoom({ mode: "auto", pxPerMs: null });
  };

  const selRange = scale ? selectionRange(selection, p, stepIndex, nodeIndex) : null;
  // Fit selection prefers the selected event; with nothing selected it
  // falls back to the brushed range.
  const fitTarget: { range: TimeRange; what: string } | null = selRange && selection
    ? { range: selRange, what: `selected ${selectionNoun(selection)}` }
    : range
      ? { range, what: "brushed range" }
      : null;
  const fitSelection = () => fitTarget && zoomToWall(fitTarget.range, fitTarget.what === "brushed range" ? 0 : 0.1);

  const idleGaps = p.gaps.filter((g) => g.kind === "idle");
  const allIdleCollapsed = idleGaps.length > 0 && idleGaps.every((g) => collapsedGaps.has(g.key));
  const collapsedIdle = idleGaps.filter((g) => collapsedGaps.has(g.key));

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    // Bars / markers are buttons: a press there is a click-to-select, never a brush.
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect || !scale) return;
    const x0 = e.clientX - rect.left;
    setBrush({ x0, x1: x0 });
    const move = (ev: MouseEvent) => setBrush((b) => (b ? { ...b, x1: ev.clientX - rect.left } : b));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBrush(null);
      const x1 = ev.clientX - rect.left;
      // A click on empty space (no drag) changes nothing.
      if (Math.abs(x1 - x0) < BRUSH_MIN_PX) return;
      const clampD = (x: number) => Math.min(total, Math.max(0, x / pxPerMs));
      const d0 = clampD(Math.min(x0, x1));
      const d1 = clampD(Math.max(x0, x1));
      const r = { startTs: scale.toWall(d0), endTs: scale.toWall(d1) };
      onRangeChange(r);
      apply(viewportForRange(d0, d1, bounds));
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const onChartKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // bars handle their own keys
    if (e.key === "+" || e.key === "=") zoomBy(2);
    else if (e.key === "-" || e.key === "_") zoomBy(0.5);
    else if (e.key === "0") fullSession();
    else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const next = clampScroll(scrollNow + (e.key === "ArrowLeft" ? -1 : 1) * viewportPx * 0.25, pxPerMs, bounds);
      if (scrollRef.current) scrollRef.current.scrollLeft = next;
      setScrollLeft(next);
    } else return;
    e.preventDefault();
  };

  const btn = "h-7 min-w-7 px-2 text-xs";
  const pressed = "border-info text-info bg-info-subtle/40";

  const { ticks: rawTicks, step: tickStep } = scale
    ? wallTicks(scale, scrollNow / pxPerMs, (scrollNow + viewportPx) / pxPerMs, pxPerMs)
    : { ticks: [], step: 0 };
  const breakLabels = (scale?.breaks ?? []).map((b) => {
    const gap = p.gaps.find((g) => g.key === b.key);
    return { key: b.key, x: ((b.d0 + b.d1) / 2) * pxPerMs, durationMs: gap?.durationMs ?? b.endTs - b.startTs };
  });
  const ticks = rawTicks.filter((t) => breakLabels.every((b) => Math.abs(t.d * pxPerMs - b.x) >= BREAK_LABEL_CLEAR_PX));
  const lanes = layout?.lanes ?? 1;
  const height = Math.max(132, LANE_TOP + lanes * LANE_H + 12 + AXIS_H);
  const isSel = (type: Selection["type"], key: string) => selection?.type === type && selection.key === key;
  const visible = scale ? visibleWallRange(scale, { pxPerMs, scrollLeft: scrollNow }, viewportPx) : null;
  const modeLabel = zoom.mode === "auto" ? "auto density" : zoom.mode === "fit" ? "full session" : `${(pxPerMs / fit).toFixed(pxPerMs / fit < 10 ? 1 : 0)}× zoom`;

  return (
    <section aria-label="Session overview" className="px-4 sm:px-6 pt-1 pb-3 min-w-0 bg-bg-surface/30 border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2 min-w-0">
        <Legend p={p} />
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Overview zoom">
          <Button
            variant="outline"
            className={btn}
            onClick={fitSelection}
            disabled={!fitTarget || !scale}
            title={fitTarget ? `Zoom the overview to the ${fitTarget.what}` : "Select an event or drag across the overview first"}
            aria-describedby={`${helpId}-fit`}
          >
            Fit selection
          </Button>
          <span id={`${helpId}-fit`} className="sr-only">{fitTarget ? `Zooms to the ${fitTarget.what}` : "Nothing selected"}</span>
          <Button
            variant="outline"
            className={cn(btn, zoom.mode === "fit" && pressed)}
            onClick={fullSession}
            aria-label="Reset to full session"
            aria-pressed={zoom.mode === "fit"}
            title="Show the whole session (wall clock) and clear the brushed range. Collapsed idle gaps stay collapsed."
          >
            Full session
          </Button>
          <Button variant="outline" className={cn(btn, zoom.mode === "auto" && pressed)} onClick={autoDensity} aria-label="Auto-pick scale by event density" aria-pressed={zoom.mode === "auto"} title="Auto-pick scale by event density">
            auto
          </Button>
          <Button variant="outline" className={btn} onClick={() => zoomBy(0.5)} disabled={!scale || pxPerMs <= fit * 1.0001} aria-label="Zoom out" title="Zoom out">−</Button>
          <Button variant="outline" className={btn} onClick={() => zoomBy(2)} disabled={!scale || pxPerMs >= Math.max(fit, bounds.maxPxPerMs) * 0.9999} aria-label="Zoom in" title="Zoom in">+</Button>
          {idleGaps.length > 0 && (
            <Button variant="outline" className={cn(btn, allIdleCollapsed && pressed)} onClick={onToggleAllIdle} aria-pressed={allIdleCollapsed} title="Collapsed idle gaps keep their marker and true duration">
              {allIdleCollapsed ? "Restore idle gaps" : "Collapse idle gaps"}
            </Button>
          )}
        </div>
      </div>
      {!scale || !layout ? (
        <div className="text-xs text-fg-subtle py-4" role="note">
          No timestamps in these events — the wall-clock overview needs them. Durations below show as unknown (—).
        </div>
      ) : (
        <>
          <div
            ref={scrollRef}
            className="overflow-x-auto max-w-full rounded-md border border-border bg-bg focus-visible:outline-2 focus-visible:outline-info"
            onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}
            tabIndex={0}
            role="group"
            aria-label="Session timeline"
            aria-describedby={`${helpId}-keys`}
            onKeyDown={onChartKeyDown}
          >
            <span id={`${helpId}-keys`} className="sr-only">
              Click a bar to select an event. Drag across empty space to select and zoom a time range. Keys: left and right arrows pan, plus and minus zoom, 0 resets to the full session.
            </span>
            <div
              ref={chartRef}
              className="relative select-none cursor-crosshair"
              style={{ width: chartPx, height }}
              onMouseDown={onMouseDown}
              data-overview-chart
              data-chart-px={Math.round(chartPx)}
              data-scroll-left={Math.round(scrollNow)}
              data-zoom-mode={zoom.mode}
            >
              {ticks.map((t) => (
                <div key={t.ts} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: t.d * pxPerMs }} data-tick={t.ts}>
                  <div className="absolute top-0 border-l border-dashed border-border/80" style={{ bottom: AXIS_H }} />
                  <span className="absolute bottom-1 -translate-x-1/2 font-mono text-[10px] tabular-nums text-fg-subtle whitespace-nowrap">
                    {formatClock(t.ts, tickStep)}
                  </span>
                </div>
              ))}
              {breakLabels.map((b) => (
                <div
                  key={b.key}
                  className="absolute bottom-0 -translate-x-1/2 flex items-center gap-0.5 font-mono text-[10px] text-fg-muted whitespace-nowrap pointer-events-none bg-bg px-1 rounded-sm"
                  style={{ left: b.x, height: AXIS_H - 2 }}
                  data-axis-break={b.key}
                >
                  <span aria-hidden className="text-fg-subtle">⫽</span>
                  {b.durationMs !== null ? formatDuration(b.durationMs) : "unknown"}
                </div>
              ))}
              <div className="absolute inset-x-0 border-t border-border" style={{ bottom: AXIS_H }} aria-hidden />
              {range && (
                <div
                  className="absolute top-0 bg-info/10 border-x-2 border-info/70 pointer-events-none"
                  style={{ left: scale.toDisplay(range.startTs) * pxPerMs, width: Math.max(2, (scale.toDisplay(range.endTs) - scale.toDisplay(range.startTs)) * pxPerMs), bottom: AXIS_H }}
                  data-testid="overview-range"
                />
              )}
              {selRange && (
                <div
                  className="absolute top-0 bg-fg/[0.06] border-x border-fg/30 pointer-events-none"
                  style={{ left: scale.toDisplay(selRange.startTs) * pxPerMs, width: Math.max(1, (scale.toDisplay(selRange.endTs) - scale.toDisplay(selRange.startTs)) * pxPerMs), bottom: AXIS_H }}
                  data-testid="overview-selection"
                />
              )}
              {layout.gapBars.map((g) => {
                const idle = g.gap.kind === "idle";
                return (
                  <BarButton
                    key={g.gap.key}
                    selected={isSel("gap", g.gap.key)}
                    fill={idle ? "border border-border rounded-sm" : "border border-dashed border-warning/70 rounded-sm"}
                    fillStyle={idle ? { backgroundImage: HATCH } : undefined}
                    aria-label={`Select ${gapLabel(g.gap)}${g.collapsed ? " (collapsed)" : ""}`}
                    title={`${gapLabel(g.gap)}${g.collapsed ? " — collapsed; true duration kept" : ""}`}
                    data-gap-bar={g.gap.kind}
                    data-collapsed={g.collapsed ? "true" : undefined}
                    onClick={() => onSelect({ type: "gap", key: g.gap.key })}
                    className="rounded-sm text-[10px] font-mono text-fg-subtle leading-none"
                    style={{ left: g.d0 * pxPerMs, width: Math.max(4, (g.d1 - g.d0) * pxPerMs), top: ROW0_TOP - 2, height: BAR_H + 4 }}
                  >
                    <span className="relative">{g.collapsed ? "⋯" : !idle ? "?" : null}</span>
                  </BarButton>
                );
              })}
              {layout.turnBars.map((b) => {
                const errored = b.turn.turn.status === "errored" || b.turn.turn.status === "terminated";
                return (
                  <BarButton
                    key={b.turn.key}
                    selected={isSel("turn", b.turn.key)}
                    fill={errored ? "bg-danger/60" : "bg-info/70"}
                    fillStyle={b.openEnded ? { backgroundImage: STRIPES } : undefined}
                    aria-label={`Select Turn ${b.turn.index + 1}`}
                    title={`Turn ${b.turn.index + 1} · ${b.turn.turn.status}${b.turn.durationMs !== null ? ` · ${formatDuration(b.turn.durationMs)}` : ""}${b.openEnded ? " · no close event yet" : ""}`}
                    onClick={() => onSelect({ type: "turn", key: b.turn.key })}
                    style={{ left: b.d0 * pxPerMs, width: Math.max(3, (b.d1 - b.d0) * pxPerMs), top: ROW0_TOP, height: BAR_H }}
                  />
                );
              })}
              {layout.stepBars.map((b) => (
                <BarButton
                  key={b.step.key}
                  selected={isSel("step", b.step.key)}
                  fill={stepBarClass(b.step)}
                  fillStyle={b.openEnded ? { backgroundImage: STRIPES } : undefined}
                  aria-label={`Select ${b.step.label}${b.step.detail ? `: ${b.step.detail}` : ""}`}
                  title={`${b.step.label} · ${stepDurationText(b.step)}${b.step.isError ? " · failed" : ""}${b.openEnded ? " · no end recorded" : ""}`}
                  data-step-bar={b.step.family}
                  data-failed={b.step.isError ? "true" : undefined}
                  onClick={() => onSelect({ type: "step", key: b.step.key })}
                  style={{ left: b.d0 * pxPerMs, width: Math.max(3, (b.d1 - b.d0) * pxPerMs), top: LANE_TOP + b.lane * LANE_H, height: BAR_H }}
                />
              ))}
              {layout.markers.map((m) => {
                const label = `Select ${m.step.label}${m.step.detail ? `: ${m.step.detail}` : ""}`;
                const common = {
                  selected: isSel("step", m.step.key),
                  "aria-label": label,
                  title: m.step.orphan ? `${m.step.label} — unpaired` : m.step.label,
                  "data-marker": m.kind,
                  "data-orphan": m.step.orphan ? "true" : undefined,
                  onClick: () => onSelect({ type: "step", key: m.step.key }),
                };
                if (m.kind === "compaction") {
                  // Diamond: a point-in-time context boundary, not a duration.
                  return (
                    <BarButton
                      key={m.step.key}
                      {...common}
                      fill={m.step.orphan ? "bg-bg border border-dashed border-trace-compaction" : "bg-trace-compaction border border-bg"}
                      className="rounded-[2px] rotate-45 overflow-visible"
                      style={{ left: m.d * pxPerMs - 5, width: 10, height: 10, top: ROW0_TOP - 1 }}
                    />
                  );
                }
                return (
                  <BarButton
                    key={m.step.key}
                    {...common}
                    fill={stepDotClass(m.step)}
                    className="rounded-sm"
                    style={{ left: m.d * pxPerMs - 1, width: 3, top: ROW0_TOP - 4, height: BAR_H + 8 }}
                  />
                );
              })}
              {brush && (
                <div
                  className="absolute top-0 bg-info/15 border-x border-info pointer-events-none"
                  style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0), bottom: AXIS_H }}
                  data-testid="overview-brush"
                />
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-[11px] text-fg-subtle min-w-0" data-testid="overview-status">
            {visible && (
              <span className="font-mono tabular-nums" data-testid="overview-window">
                {fmtRange(visible, tickStep || 1000)} · {formatDuration(Math.max(0, visible.endTs - visible.startTs))} wall clock
              </span>
            )}
            <span className="font-mono tabular-nums" data-testid="overview-rate">{fmtRate(pxPerMs)}</span>
            <span data-testid="overview-mode">{modeLabel}</span>
            {collapsedIdle.length > 0 && (
              <span data-testid="overview-collapsed">
                {collapsedIdle.length} idle gap{collapsedIdle.length === 1 ? "" : "s"} collapsed ·{" "}
                {formatDuration(collapsedIdle.reduce((n, g) => n + (g.durationMs ?? 0), 0))} kept on markers
              </span>
            )}
            {range && (
              <span className="inline-flex items-center gap-1 rounded-full border border-info/50 bg-info-subtle/40 pl-2 text-info" data-testid="overview-range-chip">
                <span className="font-mono tabular-nums">Range {fmtRange(range, range.endTs - range.startTs < 5_000 ? 100 : 1000)} · {formatDuration(range.endTs - range.startTs)}</span>
                <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px] text-info" onClick={() => zoomToWall(range)} title="Zoom to the brushed range">
                  Zoom
                </Button>
                <Button variant="ghost" size="xs" className="h-5 px-1.5 text-[11px] text-info" onClick={() => onRangeChange(null)} aria-label="Clear brushed range">
                  ×
                </Button>
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Legend({ p }: { p: TraceProjection }) {
  const swatch = "inline-block w-3 h-2 rounded-full";
  const has = (f: TraceStep["family"]) => p.steps.some((s) => s.family === f);
  const hasBoundary = p.steps.some((s) => s.family === "compaction" && s.instant);
  // Core families are always explained; the rest only when present.
  const items: Array<{ label: string; className: string; style?: CSSProperties; when?: boolean }> = [
    { label: "Turn", className: "bg-info/70" },
    { label: "Generation", className: FAMILY_BAR.model },
    { label: "Tool", className: FAMILY_BAR.tool },
    { label: "MCP tool", className: FAMILY_BAR.mcp, when: has("mcp") },
    { label: "Custom tool", className: FAMILY_BAR.custom_tool, when: has("custom_tool") },
    { label: "Schedule wait", className: FAMILY_BAR.schedule },
    { label: "Compaction", className: FAMILY_BAR.compaction },
    { label: "Context boundary", className: "w-2 h-2 rounded-[1px] rotate-45 bg-trace-compaction", when: hasBoundary },
    { label: "Failed", className: "bg-danger/80" },
    { label: "No end yet", className: "bg-fg-subtle/60", style: { backgroundImage: STRIPES } },
    { label: "Idle gap", className: "border border-border", style: { backgroundImage: HATCH } },
    { label: "Unknown gap", className: "border border-dashed border-warning/70" },
  ];
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted min-w-0">
      {items.filter((it) => it.when !== false).map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cn(swatch, it.className)} style={it.style} />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────

function FilterBar({
  filter,
  setFilter,
  tools,
  total,
  visible,
  hiddenLifecycle,
  hasCompaction,
}: {
  filter: StepFilter;
  setFilter: (f: StepFilter) => void;
  tools: Array<{ name: string; count: number }>;
  total: number;
  visible: number;
  /** Lifecycle markers hidden because a kind filter is on. */
  hiddenLifecycle: number;
  hasCompaction: boolean;
}) {
  const chip = (pressed: boolean) =>
    `h-6 px-2 rounded-full text-[11px] font-normal ${pressed ? "border-info text-info bg-info-subtle/40" : "text-fg-muted"}`;
  const toggleKind = (k: StepFilterKind) => {
    const kinds = new Set(filter.kinds);
    if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    setFilter({ ...filter, kinds });
  };
  return (
    <div className="px-4 sm:px-6 py-2 flex flex-wrap items-center gap-2 min-w-0 border-t border-border">
      <div role="group" aria-label="Kind filter" className="flex flex-wrap gap-1">
        {STEP_FILTER_KINDS.filter((k) => k !== "compaction" || hasCompaction || filter.kinds.has(k)).map((k) => (
          <Button key={k} variant="outline" size="xs" className={chip(filter.kinds.has(k))} aria-pressed={filter.kinds.has(k)} onClick={() => toggleKind(k)}>
            {FILTER_LABEL[k]}
          </Button>
        ))}
      </div>
      {tools.length > 0 && (
        <div role="group" aria-label="Tools filter" className="flex flex-wrap gap-1">
          {tools.slice(0, 8).map((t) => (
            <Button
              key={t.name}
              variant="outline"
              size="xs"
              className={chip(filter.tool === t.name)}
              aria-pressed={filter.tool === t.name}
              onClick={() => setFilter({ ...filter, tool: filter.tool === t.name ? null : t.name })}
            >
              {t.name} ({t.count})
            </Button>
          ))}
        </div>
      )}
      <Input
        type="search"
        aria-label="Search steps"
        placeholder="Search input / output…"
        value={filter.query}
        onChange={(e) => setFilter({ ...filter, query: e.target.value })}
        className="h-7 w-full sm:w-56 text-xs md:text-xs"
      />
      <span className="text-[11px] text-fg-subtle font-mono tabular-nums">{visible === total ? `${total} steps` : `${visible} of ${total} steps`}</span>
      {hiddenLifecycle > 0 && (
        <span className="text-[11px] text-fg-subtle" role="note" data-testid="hidden-lifecycle">
          {hiddenLifecycle} lifecycle marker{hiddenLifecycle === 1 ? "" : "s"} (status, threads, warnings) hidden by the kind filter
        </span>
      )}
      {isFilterActive(filter) && (
        <Button variant="ghost" size="xs" onClick={() => setFilter(EMPTY_FILTER)}>Clear</Button>
      )}
    </div>
  );
}

// ─── Tree ────────────────────────────────────────────────────────────

const ROW =
  "flex items-center gap-2 min-h-8 pr-3 text-xs cursor-pointer border-l-2 outline-none min-w-0 transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-info/60";

/** Same accent as the selected overview bar and the inspector header. */
function rowClass(selected: boolean) {
  return `${ROW} ${selected ? "bg-info-subtle/60 border-info text-fg" : "border-transparent hover:bg-bg-surface/70"}`;
}

/** Tree / inspector dot. Compaction instants are diamonds, like their overview marker. */
function StepDot({ s }: { s: TraceStep }) {
  if (s.family === "compaction" && s.instant) {
    return (
      <span
        aria-hidden
        className={cn("w-2 h-2 shrink-0 rotate-45 rounded-[1px]", s.orphan ? "border border-dashed border-trace-compaction" : s.isError ? "bg-danger" : "bg-trace-compaction")}
      />
    );
  }
  return <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${stepDotClass(s)}`} />;
}

function Badge({ tone, children }: { tone: "danger" | "warning" | "muted"; children: ReactNode }) {
  const cls = tone === "danger" ? "bg-danger-subtle text-danger font-medium" : tone === "warning" ? "bg-warning-subtle text-warning" : "bg-bg-surface text-fg-muted";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] ${cls}`}>{children}</span>;
}

function Chevron({ expanded, onClick, title }: { expanded: boolean; onClick: () => void; title: string }) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={title}
      className="size-5 text-fg-subtle hover:text-fg font-mono font-normal"
    >
      {expanded ? "▾" : "▸"}
    </Button>
  );
}

function TurnStatusIcon({ t }: { t: TraceTurn }) {
  const s = t.turn.status;
  if (s === "completed") return <span aria-hidden className="text-fg-subtle">✓</span>;
  if (s === "running") return <span aria-hidden className="inline-block w-2 h-2 rounded-full bg-info animate-pulse" />;
  return <span aria-hidden className="text-danger">✕</span>;
}

function TraceTree({
  p,
  treeByTurn,
  filterActive,
  noMatches,
  turnExpanded,
  nodeOpen,
  collapsedGaps,
  selection,
  onSelect,
  onToggleTurn,
  onToggleNode,
  onToggleGap,
}: {
  p: TraceProjection;
  treeByTurn: TraceNode[][];
  filterActive: boolean;
  noMatches: boolean;
  turnExpanded: (t: TraceTurn, i: number) => boolean;
  nodeOpen: (n: TraceGroupNode | TraceAgentNode) => boolean;
  collapsedGaps: ReadonlySet<string>;
  selection: Selection | null;
  onSelect: (sel: Selection) => void;
  onToggleTurn: (t: TraceTurn, expanded: boolean) => void;
  onToggleNode: (n: TraceGroupNode | TraceAgentNode) => void;
  onToggleGap: (key: string) => void;
}) {
  const gapAfter = useMemo(() => new Map(p.gaps.map((g) => [g.afterTurn, g])), [p.gaps]);
  const isSel = (type: Selection["type"], key: string) => selection?.type === type && selection.key === key;

  // Visible rows in render order, for keyboard navigation.
  const order: Array<{ sel: Selection; toggle?: () => void; expanded?: boolean }> = [];

  const renderNodes = (nodes: TraceNode[], level: number): ReactNode =>
    nodes.map((n) => {
      const indent = { paddingLeft: 8 + level * 16 };
      if (n.type === "step") {
        const s = n.step;
        const sel = isSel("step", s.key);
        order.push({ sel: { type: "step", key: s.key } });
        return (
          <div
            key={n.key}
            role="treeitem"
            aria-level={level + 1}
            aria-selected={sel}
            data-row-id={`step:${s.key}`}
            tabIndex={sel ? 0 : -1}
            className={rowClass(sel)}
            style={indent}
            onClick={() => onSelect({ type: "step", key: s.key })}
            title={s.detail ? `${s.label} — ${s.detail}` : s.label}
          >
            <span className="w-5 shrink-0" />
            <StepDot s={s} />
            <span className="truncate text-fg shrink-0 max-w-[60%]">{s.label}</span>
            {s.detail && <span className="truncate text-fg-subtle hidden sm:inline min-w-0">{s.detail}</span>}
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              {s.isError && <Badge tone="danger">Failed</Badge>}
              {s.pending && <Badge tone="warning">pending</Badge>}
              {s.orphan && <Badge tone="muted">{s.compaction ? "unpaired" : "orphan"}</Badge>}
              {s.startTs === null && <Badge tone="muted">no time</Badge>}
              <span className="font-mono tabular-nums text-fg-subtle w-14 text-right" title={s.durationMs === null && !s.instant ? "duration unknown" : undefined}>
                {stepDurationText(s)}
              </span>
            </span>
          </div>
        );
      }
      const open = nodeOpen(n);
      const toggle = () => onToggleNode(n);
      const sel = isSel("node", n.key);
      order.push({ sel: { type: "node", key: n.key }, toggle, expanded: open });
      const label = n.type === "group" ? `${n.steps.length} ${n.toolName} calls` : n.label;
      return (
        <Fragment key={n.key}>
          <div
            role="treeitem"
            aria-level={level + 1}
            aria-expanded={open}
            aria-selected={sel}
            data-row-id={`node:${n.key}`}
            tabIndex={sel ? 0 : -1}
            className={rowClass(sel)}
            style={indent}
            onClick={() => onSelect({ type: "node", key: n.key })}
          >
            <Chevron expanded={open} onClick={toggle} title={`${open ? "Collapse" : "Expand"} ${label}`} />
            <span className={`w-2 h-2 rounded-full shrink-0 ${n.type === "agent" ? "bg-info" : n.errors ? "bg-danger" : FAMILY_DOT.tool}`} />
            <span className="truncate text-fg">{label}</span>
            {n.type === "agent" && n.agentName && <span className="truncate text-fg-subtle font-mono hidden sm:inline">{n.threadId}</span>}
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              {n.errors > 0 && <Badge tone="danger">{n.errors} failed</Badge>}
              <span className="font-mono tabular-nums text-fg-subtle w-14 text-right">{n.durationMs === null ? "—" : formatDuration(n.durationMs)}</span>
            </span>
          </div>
          {open && (
            <div role="group">
              {renderNodes(n.type === "group" ? n.steps.map((s) => ({ type: "step" as const, key: s.key, step: s, order: s.order })) : n.children, level + 1)}
            </div>
          )}
        </Fragment>
      );
    });

  const rows = p.turns.map((t, i) => {
    const expanded = turnExpanded(t, i);
    const toggle = () => onToggleTurn(t, expanded);
    order.push({ sel: { type: "turn", key: t.key }, toggle, expanded });
    const gap = gapAfter.get(i);
    const errored = t.turn.status === "errored" || t.turn.status === "terminated";
    const statusText = t.turn.queued ? "queued" : t.turn.status;
    const sel = isSel("turn", t.key);
    const turnRow = (
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={expanded}
        aria-selected={sel}
        data-row-id={`turn:${t.key}`}
        tabIndex={sel || (!selection && i === p.turns.length - 1) ? 0 : -1}
        className={`${rowClass(sel)} font-medium ${sel ? "" : "bg-bg-surface/30"}`}
        style={{ paddingLeft: 8 }}
        onClick={() => onSelect({ type: "turn", key: t.key })}
        title={`Turn ${t.index + 1} · ${turnTriggerLabel(t)} · ${statusText}`}
      >
        <Chevron expanded={expanded} onClick={toggle} title={expanded ? "Collapse" : "Expand"} />
        <span className="text-fg shrink-0">Turn {t.index + 1}</span>
        <TurnStatusIcon t={t} />
        <span className="sr-only">{statusText}</span>
        {t.turn.queued && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning-subtle px-2 py-0.5 font-medium text-warning text-[10px]" data-timeline-turn-queued>
            <span aria-hidden>⏳</span>
            queued
          </span>
        )}
        <span className="text-fg-subtle font-normal truncate min-w-0 hidden sm:inline">
          {turnTriggerLabel(t)}
          {t.triggerText ? ` · “${t.triggerText}”` : ""}
        </span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0 font-normal">
          {errored && <Badge tone="danger">{t.turn.status}</Badge>}
          {!errored && t.errors > 0 && <Badge tone="danger">{t.errors} failed</Badge>}
          <span className="font-mono tabular-nums text-fg-subtle w-14 text-right" title={t.closed ? undefined : "no close event yet"}>
            {t.durationMs === null ? "—" : formatDuration(t.durationMs)}
          </span>
        </span>
      </div>
    );
    // Collapsed turns render no step rows (same cost model as the old waterfall).
    const body = expanded ? (
      treeByTurn[i]!.length > 0 ? (
        <div role="group">{renderNodes(treeByTurn[i]!, 1)}</div>
      ) : (
        <div className="pl-12 py-1.5 text-xs text-fg-subtle">{filterActive ? "No steps match the current filters." : "No steps."}</div>
      )
    ) : null;
    if (gap) order.push({ sel: { type: "gap", key: gap.key } });
    return (
      <Fragment key={t.key}>
        {turnRow}
        {body}
        {gap && (
          <GapRow
            gap={gap}
            collapsed={collapsedGaps.has(gap.key)}
            selected={isSel("gap", gap.key)}
            onSelect={() => onSelect({ type: "gap", key: gap.key })}
            onToggle={() => onToggleGap(gap.key)}
          />
        )}
      </Fragment>
    );
  });

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const idx = selection ? order.findIndex((r) => r.sel.type === selection.type && r.sel.key === selection.key) : -1;
    const cur = idx >= 0 ? order[idx] : undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = order[Math.min(order.length - 1, Math.max(0, idx + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) onSelect(next.sel);
    } else if (e.key === "ArrowRight" && cur?.toggle && cur.expanded === false) {
      e.preventDefault();
      cur.toggle();
    } else if (e.key === "ArrowLeft" && cur?.toggle && cur.expanded === true) {
      e.preventDefault();
      cur.toggle();
    }
  };

  // Keep keyboard focus on the selected row while navigating the tree.
  const treeRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selection || !treeRef.current?.contains(document.activeElement)) return;
    const el = treeRef.current.querySelector<HTMLElement>(rowSelector(`${selection.type}:${selection.key}`));
    if (el && el !== document.activeElement) el.focus();
  }, [selection]);

  return (
    <nav aria-label="Trace tree" className="min-w-0 md:overflow-y-auto border-b md:border-b-0 md:border-r border-border py-1">
      {noMatches && <p className="px-3 py-2 text-xs text-fg-subtle">No steps match the current filters.</p>}
      <div ref={treeRef} role="tree" aria-label="Trace tree" onKeyDown={onKeyDown}>
        {rows}
      </div>
    </nav>
  );
}

/**
 * Original Timeline IdleDivider ("↓ 5m0s idle · scheduled wakeup"), now a
 * selectable tree row with a Collapse / Restore toggle for the overview
 * axis. Unknown intervals use a distinct marker and are never called idle.
 */
function GapRow({
  gap,
  collapsed,
  selected,
  onSelect,
  onToggle,
}: {
  gap: TraceGap;
  collapsed: boolean;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const label = gapLabel(gap);
  const idle = gap.kind === "idle";
  const rule = `flex-1 min-w-4 border-t ${idle ? "border-dashed border-border" : "border-dotted border-warning/60"}`;
  return (
    <div
      role="treeitem"
      aria-level={1}
      aria-selected={selected}
      data-row-id={`gap:${gap.key}`}
      data-gap-kind={gap.kind}
      data-collapsed={collapsed ? "true" : undefined}
      tabIndex={selected ? 0 : -1}
      onClick={onSelect}
      className={`flex items-center gap-3 text-xs font-mono py-1 px-3 cursor-pointer min-w-0 ${selected ? "bg-info-subtle/50" : "hover:bg-bg-surface/60"} ${idle ? "text-fg-subtle" : "text-warning"}`}
      title={gap.reason}
    >
      <div className={rule} />
      <span className="truncate">
        {idle ? `↓ ${label}` : `? ${label} · not classified as idle`}
        {collapsed && " · collapsed"}
      </span>
      {idle && (
        <Button
          variant="outline"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-pressed={collapsed}
          aria-label={collapsed ? `Restore full ${label} gap` : `Collapse ${label} gap`}
          title={collapsed ? "Restore the full wall-clock gap in the overview" : "Collapse this gap in the overview (duration stays on the marker)"}
          className="h-5 px-1.5 text-[10px] text-fg-muted font-sans font-normal"
        >
          {collapsed ? "Restore" : "Collapse"}
        </Button>
      )}
      <div className={rule} />
    </div>
  );
}

// ─── Inspector ───────────────────────────────────────────────────────

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section aria-label={title} className="flex flex-col gap-1 min-w-0" data-testid={testId}>
      <h4 className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">{title}</h4>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs leading-5">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-fg-subtle">{k}</dt>
          <dd className="text-fg min-w-0 break-words">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Pre({ children, tone }: { children: string; tone?: "error" }) {
  return (
    <pre className={`font-mono text-xs rounded px-3 py-2 max-h-80 overflow-auto whitespace-pre-wrap break-words ${tone === "error" ? "bg-danger-subtle/60 text-danger" : "bg-bg-surface text-fg"}`}>
      {children}
    </pre>
  );
}

function Inspector({
  p,
  selection,
  stepIndex,
  nodeIndex,
  collapsedGaps,
  onToggleGap,
  onSelect,
  onClose,
}: {
  p: TraceProjection;
  selection: Selection | null;
  stepIndex: StepIndex;
  nodeIndex: NodeIndex;
  collapsedGaps: ReadonlySet<string>;
  onToggleGap: (key: string) => void;
  onSelect: (sel: Selection) => void;
  onClose: () => void;
}) {
  let title: ReactNode = null;
  let body: ReactNode = null;

  if (selection?.type === "step") {
    const hit = stepIndex.get(selection.key);
    if (hit) {
      const { step: s, turn } = hit;
      title = (
        <>
          <StepDot s={s} />
          <span className="truncate">{s.label}</span>
          {s.isError && <Badge tone="danger">Failed</Badge>}
          {s.pending && <Badge tone="warning">pending</Badge>}
          {s.orphan && <Badge tone="muted">{s.compaction ? "unpaired" : "orphan"}</Badge>}
          <span className="ml-auto pl-2 font-mono tabular-nums text-xs font-normal text-fg-subtle shrink-0">{stepDurationText(s)}</span>
        </>
      );
      body = <StepDetails s={s} turn={turn} />;
    }
  } else if (selection?.type === "turn") {
    const t = p.turns.find((x) => x.key === selection.key);
    if (t) {
      title = <span>Turn {t.index + 1}</span>;
      body = <TurnDetails t={t} />;
    }
  } else if (selection?.type === "gap") {
    const g = p.gaps.find((x) => x.key === selection.key);
    if (g) {
      title = <span>{g.kind === "idle" ? "Idle between turns" : "Unknown interval"}</span>;
      body = <GapDetails g={g} collapsed={collapsedGaps.has(g.key)} onToggle={() => onToggleGap(g.key)} />;
    }
  } else if (selection?.type === "node") {
    const hit = nodeIndex.get(selection.key);
    if (hit) {
      const n = hit.node;
      title = <span className="truncate">{n.type === "group" ? `${n.steps.length} ${n.toolName} calls` : `Agent · ${n.label}`}</span>;
      const rows: Array<[string, ReactNode]> = [
        ["Started", clockOrUnknown(n.startTs)],
        ["Ended", clockOrUnknown(n.endTs)],
        ["Span", n.durationMs === null ? "unknown" : formatDuration(n.durationMs)],
        ["Turn", `Turn ${hit.turn.index + 1}`],
      ];
      if (n.type === "agent") {
        rows.push(["Thread", n.threadId], ["Parent thread", n.parentThreadId ?? "not reported"]);
      }
      rows.push(["Failed", n.errors]);
      body = (
        <>
          <Section title="Timing"><Facts rows={rows} /></Section>
          <Section title="Steps">
            <ul className="flex flex-col gap-1">
              {nodeSteps(n).map((s) => (
                <li key={s.key}>
                  <Button variant="ghost" size="xs" className="w-full h-auto justify-start text-left font-normal gap-2 py-1 min-w-0" onClick={() => onSelect({ type: "step", key: s.key })}>
                    <StepDot s={s} />
                    <span className="truncate">{s.label}{s.detail ? ` · ${s.detail}` : ""}</span>
                    <span className="ml-auto font-mono text-fg-subtle">{stepDurationText(s)}</span>
                  </Button>
                </li>
              ))}
            </ul>
          </Section>
        </>
      );
    }
  }

  if (!body) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 py-16 text-sm text-fg-muted">
        <span aria-hidden className="w-7 h-7 rounded-full border-2 border-dashed border-fg-subtle" />
        Select an event to view details
      </div>
    );
  }
  return (
    <div className="flex flex-col min-w-0" data-testid="trace-inspector">
      <div className="sticky top-0 z-10 px-4 py-2.5 border-b border-border border-l-2 border-l-info bg-info-subtle/40 backdrop-blur-sm flex items-center gap-2 text-sm font-medium min-w-0" data-testid="inspector-header">
        <div className="flex items-center gap-2 min-w-0 flex-1">{title}</div>
        <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close details" className="shrink-0">×</Button>
      </div>
      <div className="p-4 flex flex-col gap-4 min-w-0">{body}</div>
    </div>
  );
}

function StepDetails({ s, turn }: { s: TraceStep; turn: TraceTurn }) {
  const diff = s.kind === "tool" ? extractDiff(s.input) : null;
  const ended = s.instant
    ? "instant"
    : s.endTs !== null
      ? clockOrUnknown(s.endTs)
      : s.pending
        ? s.kind === "tool" ? "pending — no result recorded" : "pending — no end event recorded"
        : "unknown";
  const timing: Array<[string, ReactNode]> = [
    ["Started", clockOrUnknown(s.startTs)],
    ["Ended", ended],
    ["Duration", s.instant ? "instant" : s.durationMs === null ? "unknown" : formatDuration(s.durationMs)],
  ];
  if (s.ttftMs !== undefined) timing.push(["TTFT", formatDuration(s.ttftMs)]);
  timing.push(["Turn", `Turn ${turn.index + 1}`]);
  if (s.threadId) timing.push(["Thread", s.threadId]);

  const ids: Array<[string, ReactNode]> = [];
  if (s.callId) ids.push(["Call id", s.callId]);
  if (s.parentEventId) ids.push(["Parent event", s.parentEventId]);
  if (s.toolSource) ids.push(["Tool source", s.mcpServer ? `${s.toolSource} · ${s.mcpServer}` : s.toolSource]);
  ids.push(["Events", s.events.map((e) => `${e.type}${typeof e.seq === "number" ? ` #${e.seq}` : ""}`).join(", ")]);

  const usageRows: Array<[string, ReactNode]> = [
    ["Model", s.model ?? "not reported"],
    ["Finish reason", s.finishReason ?? "not reported"],
    ["Input tokens", s.usage ? s.usage.input_tokens : "not reported"],
    ["Output tokens", s.usage ? s.usage.output_tokens : "not reported"],
  ];
  if (s.usage?.cache_read_input_tokens !== undefined) usageRows.push(["Cache read", s.usage.cache_read_input_tokens]);
  if (s.usage?.cache_creation_input_tokens !== undefined) usageRows.push(["Cache write", s.usage.cache_creation_input_tokens]);

  return (
    <>
      <Section title="Timing"><Facts rows={timing} /></Section>
      {s.kind === "model" && <Section title="Usage"><Facts rows={usageRows} /></Section>}
      {s.kind === "tool" && s.input !== undefined && (
        diff ? (
          <Section title={`Edit${diff.path ? ` · ${diff.path}` : ""}`} testId="step-diff">
            <pre className="font-mono text-xs rounded bg-bg-surface px-3 py-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">
              {diff.lines.map((l, i) => (
                <div key={i} className={l.kind === "add" ? "text-success" : l.kind === "del" ? "text-danger" : l.kind === "hunk" ? "text-info" : "text-fg-muted"}>{l.text}</div>
              ))}
            </pre>
          </Section>
        ) : (
          <Section title="Input"><Pre>{stringifyCapped(s.input)}</Pre></Section>
        )
      )}
      {s.kind === "tool" && (
        s.output !== undefined ? (
          <Section title={s.isError ? "Output (error)" : "Output"}>
            <Pre tone={s.isError ? "error" : undefined}>{s.output === "" ? "(empty)" : stringifyCapped(s.output)}</Pre>
          </Section>
        ) : s.pending ? (
          <Section title="Output"><p className="text-xs text-fg-subtle">No result recorded for this call.</p></Section>
        ) : null
      )}
      {s.compaction && <CompactionDetails s={s} />}
      {s.family === "warn" && <WarningDetails s={s} />}
      {s.text !== undefined && s.kind !== "tool" && !s.compaction && (
        <Section title={s.kind === "thinking" ? "Thinking" : "Message"}><Pre>{s.text || "(empty)"}</Pre></Section>
      )}
      {s.errorText && s.kind !== "tool" && (
        <Section title="Error"><Pre tone="error">{s.errorText}</Pre></Section>
      )}
      {s.detail && s.kind === "lifecycle" && !s.compaction && s.family !== "warn" && (
        <Section title="Detail"><p className="text-xs text-fg break-words">{s.detail}</p></Section>
      )}
      <Section title="Identifiers"><Facts rows={ids} /></Section>
      <details className="text-xs">
        <summary className="cursor-pointer text-fg-subtle">Source events ({s.events.length})</summary>
        <div className="mt-2 flex flex-col gap-2">
          {s.events.map((ev: Event, i) => (
            <div key={i} className="border border-border/60 rounded min-w-0">
              <div className="px-3 py-1 border-b border-border/60 font-mono text-fg-muted">{ev.type}</div>
              <pre className="font-mono text-xs text-fg-muted px-3 py-2 overflow-auto max-h-80 whitespace-pre-wrap break-words">{stringifyCapped(ev)}</pre>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

const COMPACTION_KIND: Record<NonNullable<TraceStep["compaction"]>["role"], string> = {
  summarize: "Summarize span (span.compaction_summarize_start → span.compaction_summarize_end)",
  boundary: "Context boundary (agent.thread_context_compacted)",
  orphan_end: "Unpaired span.compaction_summarize_end — no matching start in this stream",
};

/** Compaction fields exactly as reported; missing ones say so. */
function CompactionDetails({ s }: { s: TraceStep }) {
  const c = s.compaction!;
  const NR = <span className="text-fg-subtle">not reported</span>;
  const rows: Array<[string, ReactNode]> = [["Kind", COMPACTION_KIND[c.role]]];
  if (c.role === "boundary") {
    rows.push(
      ["Messages before", c.originalMessageCount ?? NR],
      ["Messages after", c.compactedMessageCount ?? NR],
      ["Trigger", c.trigger ?? NR],
      ["Pre-compaction tokens", c.preTokens !== undefined ? `${c.preTokens} (harness estimate)` : NR],
    );
    if (c.replacedRange) rows.push(["Replaced seq range", `${c.replacedRange.startSeq} – ${c.replacedRange.endSeq}`]);
  } else {
    rows.push(["Model", s.model ?? NR], ["Finish reason", s.finishReason ?? NR]);
    if (s.usage) {
      rows.push(["Input tokens", s.usage.input_tokens], ["Output tokens", s.usage.output_tokens]);
      if (s.usage.cache_read_input_tokens !== undefined) rows.push(["Cache read", s.usage.cache_read_input_tokens]);
      if (s.usage.cache_creation_input_tokens !== undefined) rows.push(["Cache write", s.usage.cache_creation_input_tokens]);
    } else rows.push(["Usage", s.pending ? <span className="text-fg-subtle">pending — no end event recorded</span> : NR]);
    rows.push(["Summary length", c.finalTextLength !== undefined ? `${c.finalTextLength} chars` : NR]);
  }
  return (
    <>
      <Section title="Compaction" testId="compaction-details"><Facts rows={rows} /></Section>
      {c.role === "boundary" && (
        <Section title="Summary">
          {c.summary ? <Pre>{c.summary}</Pre> : <p className="text-xs text-fg-subtle">Summary not reported on this event.</p>}
        </Section>
      )}
    </>
  );
}

function WarningDetails({ s }: { s: TraceStep }) {
  const e = s.events[0] as Record<string, unknown> | undefined;
  const source = typeof e?.source === "string" && e.source ? e.source : null;
  const message = typeof e?.message === "string" && e.message ? e.message : null;
  const details = e?.details;
  const rows: Array<[string, ReactNode]> = [
    ["Source", source ?? "not reported"],
    ["Message", message ?? "not reported"],
  ];
  if (source === CONTEXT_REASSEMBLED_SOURCE) rows.push(["Related to", "compaction — context re-assembled after a boundary (session.warning, not a summarize span)"]);
  return (
    <>
      <Section title="Warning"><Facts rows={rows} /></Section>
      {details !== undefined && details !== null && <Section title="Warning details"><Pre>{stringifyCapped(details)}</Pre></Section>}
    </>
  );
}

function TurnDetails({ t }: { t: TraceTurn }) {
  return (
    <>
      <Section title="Trigger">
        <Facts rows={[
          ["Kind", turnTriggerLabel(t)],
          ["Status", t.turn.queued ? "queued" : t.turn.status],
          ["Message", t.triggerText ?? "—"],
        ]} />
      </Section>
      <Section title="Timing">
        <Facts rows={[
          ["Started", clockOrUnknown(t.startTs)],
          ["Ended", t.closed ? clockOrUnknown(t.endTs) : "open — no status_idle / terminated / error yet"],
          ["Duration", t.durationMs === null ? "unknown" : `${formatDuration(t.durationMs)}${t.closed ? "" : " so far"}`],
        ]} />
      </Section>
      <Section title="Work">
        <Facts rows={[
          ["Steps", t.steps.length],
          ["Tool calls", t.toolCalls],
          ["Failed", t.errors],
          ["Tokens in / out", t.tokens ? `${t.tokens.input} / ${t.tokens.output}` : "not reported"],
          ["Events", t.turn.events.length],
        ]} />
      </Section>
    </>
  );
}

function GapDetails({ g, collapsed, onToggle }: { g: TraceGap; collapsed: boolean; onToggle: () => void }) {
  const cls: Array<[string, ReactNode]> = [
    ["Kind", g.kind === "idle" ? "Known idle (between turns)" : "Unknown — not classified as idle"],
    ["Basis", g.reason],
  ];
  if (g.scheduledWakeup) cls.push(["Next trigger", "scheduled wakeup"]);
  return (
    <>
      <Section title="Classification"><Facts rows={cls} /></Section>
      <Section title="Timing">
        <Facts rows={[
          ["From", clockOrUnknown(g.startTs)],
          ["To", clockOrUnknown(g.endTs)],
          ["Duration", g.durationMs === null ? "unknown" : formatDuration(g.durationMs)],
        ]} />
      </Section>
      {g.kind === "idle" && (
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="xs" onClick={onToggle} className="self-start">
            {collapsed ? "Restore full wall-clock gap" : "Collapse gap in overview"}
          </Button>
          <p className="text-[11px] text-fg-subtle">
            Collapsing only shrinks this gap on the overview axis; the marker keeps its true duration.
          </p>
        </div>
      )}
    </>
  );
}
