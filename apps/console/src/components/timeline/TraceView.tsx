import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  extractDiff,
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
  wallTicks,
  type StepFilter,
  type StepFilterKind,
  type TimeScale,
  type TraceAgentNode,
  type TraceGap,
  type TraceGroupNode,
  type TraceNode,
  type TraceProjection,
  type TraceTurn,
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
        selected && "ring-2 ring-fg z-10",
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
  const [selection, setSelection] = useState<Selection | null>(null);
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
      />
      <FilterBar filter={filter} setFilter={setFilter} tools={toolCounts(p.steps)} total={p.steps.length} visible={visibleCount} />
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
    ...(facts ?? []),
  ];
  return (
    <div className="px-4 sm:px-6 pt-3 pb-2 flex flex-wrap items-start gap-x-6 gap-y-2 min-w-0">
      <dl role="region" aria-label="Trace summary" className="flex flex-wrap gap-x-6 gap-y-2 min-w-0 flex-1">
        {items.map((f) => (
          <div key={f.label} className="min-w-0">
            <dt className="text-[11px] text-fg-subtle">{f.label}</dt>
            <dd className="text-xs text-fg font-medium truncate max-w-[18rem]">{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────

function selectionRange(
  sel: Selection | null,
  p: TraceProjection,
  stepIndex: StepIndex,
  nodeIndex: NodeIndex,
): { startTs: number; endTs: number } | null {
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

function Overview({
  p,
  collapsedGaps,
  onToggleAllIdle,
  selection,
  stepIndex,
  nodeIndex,
  onSelect,
}: {
  p: TraceProjection;
  collapsedGaps: ReadonlySet<string>;
  onToggleAllIdle: () => void;
  selection: Selection | null;
  stepIndex: StepIndex;
  nodeIndex: NodeIndex;
  onSelect: (sel: Selection) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [viewportPx, setViewportPx] = useState(FALLBACK_VIEWPORT_PX);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [zoom, setZoom] = useState<{ mode: ZoomMode; pxPerMs: number | null }>({ mode: "auto", pxPerMs: null });
  const pendingScroll = useRef<number | null>(null);
  const [brush, setBrush] = useState<{ x0: number; x1: number } | null>(null);

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
  const fit = viewportPx / total;
  const maxPx = Math.max(fit, MAX_MANUAL_CHART_PX / total);
  const pxPerMs =
    zoom.mode === "fit" || !layout
      ? fit
      : zoom.mode === "auto"
        ? autoPxPerMs(layout.boundaries, total, viewportPx)
        : Math.min(maxPx, Math.max(fit, zoom.pxPerMs ?? fit));
  const chartPx = Math.max(1, total * pxPerMs);

  useLayoutEffect(() => {
    if (pendingScroll.current === null || !scrollRef.current) return;
    scrollRef.current.scrollLeft = pendingScroll.current;
    setScrollLeft(pendingScroll.current);
    pendingScroll.current = null;
  });

  const zoomTo = (d0: number, d1: number) => {
    const width = Math.max(d1 - d0, total * 0.002, 1);
    const next = Math.min(maxPx, Math.max(fit, viewportPx / width));
    pendingScroll.current = Math.max(0, d0 * next);
    setZoom({ mode: "manual", pxPerMs: next });
  };
  const zoomBy = (factor: number) => {
    const center = (scrollLeft + viewportPx / 2) / pxPerMs;
    const next = Math.min(maxPx, Math.max(fit, pxPerMs * factor));
    pendingScroll.current = Math.max(0, center * next - viewportPx / 2);
    setZoom({ mode: "manual", pxPerMs: next });
  };
  const selRange = scale ? selectionRange(selection, p, stepIndex, nodeIndex) : null;
  const fitSelection = () => {
    if (!scale || !selRange) return;
    const d0 = scale.toDisplay(selRange.startTs);
    const d1 = scale.toDisplay(selRange.endTs);
    const pad = Math.max((d1 - d0) * 0.1, total * 0.01);
    zoomTo(Math.max(0, d0 - pad), Math.min(total, d1 + pad));
  };

  const idleGaps = p.gaps.filter((g) => g.kind === "idle");
  const allIdleCollapsed = idleGaps.length > 0 && idleGaps.every((g) => collapsedGaps.has(g.key));

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const rect = chartRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x0 = e.clientX - rect.left;
    setBrush({ x0, x1: x0 });
    const move = (ev: MouseEvent) => setBrush((b) => (b ? { ...b, x1: ev.clientX - rect.left } : b));
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setBrush(null);
      const x1 = ev.clientX - rect.left;
      if (Math.abs(x1 - x0) >= 4) zoomTo(Math.min(x0, x1) / pxPerMs, Math.max(x0, x1) / pxPerMs);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const fmtRate = (ppms: number) => {
    const pps = ppms * 1000;
    if (pps >= 100) return `${Math.round(pps)} px/s`;
    if (pps >= 1) return `${pps.toFixed(1)} px/s`;
    return `${pps.toFixed(2)} px/s`;
  };
  const btn = "h-7 min-w-7 px-2 text-xs";

  const { ticks, step: tickStep } = scale
    ? wallTicks(scale, scrollLeft / pxPerMs, (scrollLeft + viewportPx) / pxPerMs, pxPerMs)
    : { ticks: [], step: 0 };
  const lanes = layout?.lanes ?? 1;
  const height = Math.max(132, LANE_TOP + lanes * LANE_H + 12 + AXIS_H);
  const isSel = (type: Selection["type"], key: string) => selection?.type === type && selection.key === key;

  return (
    <section aria-label="Session overview" className="px-4 sm:px-6 pb-3 min-w-0 bg-bg-surface/30 border-t border-border">
      <div className="flex flex-wrap items-center justify-between gap-2 py-2 min-w-0">
        <Legend />
        <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Overview zoom">
          <Button variant="outline" className={btn} onClick={fitSelection} disabled={!selRange} title="Zoom the overview to the selected row">
            Fit selection
          </Button>
          <Button variant="outline" className={btn} onClick={() => setZoom({ mode: "fit", pxPerMs: null })} aria-label="Fit session to viewport" aria-pressed={zoom.mode === "fit"} title="Fit the whole session to the viewport">
            fit
          </Button>
          <Button variant="outline" className={`${btn} ${zoom.mode === "auto" ? "border-info text-info" : ""}`} onClick={() => setZoom({ mode: "auto", pxPerMs: null })} aria-label="Auto-pick scale by event density" aria-pressed={zoom.mode === "auto"} title="Auto-pick scale by event density">
            auto
          </Button>
          <Button variant="outline" className={btn} onClick={() => zoomBy(0.5)} aria-label="Zoom out" title="Zoom out">−</Button>
          <Button variant="outline" className={btn} onClick={() => zoomBy(2)} aria-label="Zoom in" title="Zoom in">+</Button>
          {idleGaps.length > 0 && (
            <Button variant="outline" className={btn} onClick={onToggleAllIdle} aria-pressed={allIdleCollapsed} title="Collapsed idle gaps keep their marker and true duration">
              {allIdleCollapsed ? "Restore idle gaps" : "Collapse idle gaps"}
            </Button>
          )}
          {scale && <span className="ml-1 font-mono text-[11px] text-fg-subtle" data-testid="overview-rate">{fmtRate(pxPerMs)}</span>}
        </div>
      </div>
      {!scale || !layout ? (
        <div className="text-xs text-fg-subtle py-4" role="note">
          No timestamps in these events — the wall-clock overview needs them. Durations below show as unknown (—).
        </div>
      ) : (
        <div ref={scrollRef} className="overflow-x-auto max-w-full rounded border border-border bg-bg" onScroll={(e) => setScrollLeft(e.currentTarget.scrollLeft)}>
          <div
            ref={chartRef}
            className="relative select-none cursor-crosshair"
            style={{ width: chartPx, height }}
            onMouseDown={onMouseDown}
            data-overview-chart
            data-chart-px={Math.round(chartPx)}
          >
            {ticks.map((t) => (
              <div key={t.ts} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: t.d * pxPerMs }}>
                <div className="absolute top-0 border-l border-dashed border-border" style={{ bottom: AXIS_H }} />
                <span className="absolute bottom-1 -translate-x-1/2 font-mono text-[10px] text-fg-subtle whitespace-nowrap">
                  {formatClock(t.ts, tickStep)}
                </span>
              </div>
            ))}
            {layout.gapBars.map((g) => {
              const idle = g.gap.kind === "idle";
              return (
                <BarButton
                  key={g.gap.key}
                  selected={isSel("gap", g.gap.key)}
                  fill={idle ? "border border-border rounded-sm" : "border border-dashed border-fg-subtle rounded-sm"}
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
            {layout.markers.map((m) => (
              <BarButton
                key={m.step.key}
                selected={isSel("step", m.step.key)}
                fill={stepDotClass(m.step)}
                aria-label={`Select ${m.step.label}${m.step.detail ? `: ${m.step.detail}` : ""}`}
                title={m.step.label}
                onClick={() => onSelect({ type: "step", key: m.step.key })}
                className="rounded-sm"
                style={{ left: m.d * pxPerMs - 1, width: 3, top: ROW0_TOP - 4, height: BAR_H + 8 }}
              />
            ))}
            {layout.stepBars.map((b) => (
              <BarButton
                key={b.step.key}
                selected={isSel("step", b.step.key)}
                fill={cn(stepBarClass(b.step), "opacity-90 group-hover/button:opacity-100")}
                fillStyle={b.openEnded ? { backgroundImage: STRIPES } : undefined}
                aria-label={`Select ${b.step.label}${b.step.detail ? `: ${b.step.detail}` : ""}`}
                title={`${b.step.label} · ${stepDurationText(b.step)}${b.step.isError ? " · failed" : ""}${b.openEnded ? " · no end recorded" : ""}`}
                data-step-bar={b.step.family}
                data-failed={b.step.isError ? "true" : undefined}
                onClick={() => onSelect({ type: "step", key: b.step.key })}
                style={{ left: b.d0 * pxPerMs, width: Math.max(3, (b.d1 - b.d0) * pxPerMs), top: LANE_TOP + b.lane * LANE_H, height: BAR_H }}
              />
            ))}
            {selRange && (
              <div
                className="absolute top-0 bg-fg/5 border-x border-fg/20 pointer-events-none"
                style={{ left: scale.toDisplay(selRange.startTs) * pxPerMs, width: Math.max(1, (scale.toDisplay(selRange.endTs) - scale.toDisplay(selRange.startTs)) * pxPerMs), bottom: AXIS_H }}
              />
            )}
            {brush && (
              <div
                className="absolute top-0 bg-info/15 border-x border-info pointer-events-none"
                style={{ left: Math.min(brush.x0, brush.x1), width: Math.abs(brush.x1 - brush.x0), bottom: AXIS_H }}
                data-testid="overview-brush"
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Legend() {
  const swatch = "inline-block w-3 h-2 rounded-full";
  const items: Array<{ label: string; className: string; style?: CSSProperties }> = [
    { label: "Turn", className: "bg-info/70" },
    { label: "Generation", className: FAMILY_BAR.model },
    { label: "Tool", className: FAMILY_BAR.tool },
    { label: "MCP tool", className: FAMILY_BAR.mcp },
    { label: "Custom tool", className: FAMILY_BAR.custom_tool },
    { label: "Schedule wait", className: FAMILY_BAR.schedule },
    { label: "Failed", className: "bg-danger/80" },
    { label: "No end yet", className: "bg-fg-subtle/60", style: { backgroundImage: STRIPES } },
    { label: "Idle gap", className: "border border-border", style: { backgroundImage: HATCH } },
    { label: "Unknown gap", className: "border border-dashed border-fg-subtle" },
  ];
  return (
    <ul aria-label="Legend" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted min-w-0">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          <span className={`${swatch} ${it.className}`} style={it.style} />
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
}: {
  filter: StepFilter;
  setFilter: (f: StepFilter) => void;
  tools: Array<{ name: string; count: number }>;
  total: number;
  visible: number;
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
        {STEP_FILTER_KINDS.map((k) => (
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
      <span className="text-[11px] text-fg-subtle font-mono">{visible === total ? `${total} steps` : `${visible} of ${total} steps`}</span>
      {isFilterActive(filter) && (
        <Button variant="ghost" size="xs" onClick={() => setFilter(EMPTY_FILTER)}>Clear</Button>
      )}
    </div>
  );
}

// ─── Tree ────────────────────────────────────────────────────────────

const ROW = "flex items-center gap-2 min-h-8 pr-3 text-xs cursor-pointer border-l-2 outline-none focus-visible:bg-bg-surface min-w-0";

function rowClass(selected: boolean) {
  return `${ROW} ${selected ? "bg-info-subtle/50 border-info" : "border-transparent hover:bg-bg-surface/60"}`;
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
            <span className={`w-2 h-2 rounded-full shrink-0 ${stepDotClass(s)}`} />
            <span className="truncate text-fg shrink-0 max-w-[60%]">{s.label}</span>
            {s.detail && <span className="truncate text-fg-subtle hidden sm:inline min-w-0">{s.detail}</span>}
            <span className="ml-auto flex items-center gap-1.5 shrink-0">
              {s.isError && <Badge tone="danger">Failed</Badge>}
              {s.pending && <Badge tone="warning">pending</Badge>}
              {s.orphan && <Badge tone="muted">orphan</Badge>}
              {s.startTs === null && <Badge tone="muted">no time</Badge>}
              <span className="font-mono text-fg-subtle w-14 text-right" title={s.durationMs === null && !s.instant ? "duration unknown" : undefined}>
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
              <span className="font-mono text-fg-subtle w-14 text-right">{n.durationMs === null ? "—" : formatDuration(n.durationMs)}</span>
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
        className={`${rowClass(sel)} font-medium`}
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
          <span className="font-mono text-fg-subtle w-14 text-right" title={t.closed ? undefined : "no close event yet"}>
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
      <h4 className="text-[11px] uppercase tracking-wide text-fg-subtle">{title}</h4>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
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
          <span className={`w-2 h-2 rounded-full shrink-0 ${stepDotClass(s)}`} />
          <span className="truncate">{s.label}</span>
          {s.isError && <Badge tone="danger">Failed</Badge>}
          {s.pending && <Badge tone="warning">pending</Badge>}
          {s.orphan && <Badge tone="muted">orphan</Badge>}
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
                    <span className={`w-2 h-2 rounded-full shrink-0 ${stepDotClass(s)}`} />
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
      <div className="px-4 py-3 border-b border-border flex items-center gap-2 text-sm font-medium min-w-0">
        {title}
        <Button variant="ghost" size="xs" onClick={onClose} aria-label="Close details" className="ml-auto">×</Button>
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
      {s.text !== undefined && s.kind !== "tool" && (
        <Section title={s.kind === "thinking" ? "Thinking" : "Message"}><Pre>{s.text || "(empty)"}</Pre></Section>
      )}
      {s.errorText && s.kind !== "tool" && (
        <Section title="Error"><Pre tone="error">{s.errorText}</Pre></Section>
      )}
      {s.detail && s.kind === "lifecycle" && (
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
