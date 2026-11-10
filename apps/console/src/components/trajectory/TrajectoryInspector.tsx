import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { StatusPill } from "../Badge";
import { formatDuration } from "../../lib/format";
import { outcomeToStatusTone, rewardHeadline, type Trajectory } from "../../lib/trajectory";
import {
  EMPTY_FILTER,
  STEP_FILTER_KINDS,
  buildLanes,
  extractDiff,
  filterSteps,
  formatTokens,
  groupSteps,
  isGroupRow,
  projectTrajectory,
  segmentPosition,
  toolCounts,
  transcriptText,
  type LaneSegment,
  type StepFilter,
  type StepFilterKind,
  type StepKind,
  type TrajectoryGroupRow,
  type TrajectoryLanes,
  type TrajectoryProjection,
  type TrajectoryStep,
  type TrajectoryTurn,
} from "../../lib/trajectory-steps";

/**
 * Structured Trajectory inspector rendered inside TrajectoryViewerModal.
 *
 * Layers, top to bottom:
 *   1. Run facts + stat cards (outcome, reward, model, turns, tools, …).
 *   2. Question / final answer.
 *   3. Two-lane wall-clock timeline (model vs tools); click a segment to
 *      seek its step. Hidden for untimed or very short runs.
 *   4. Turn strip with badges; ←/→ move between turns.
 *   5. Filters (kind, tool, search) + copy-all.
 *   6. "By turn" split (conversation | execution) or the full step list.
 *
 * `trajectory` is optional so the inspector can render a provisional
 * transcript from live session events while the envelope is still loading.
 */
export function TrajectoryInspector({
  trajectory,
  events,
}: {
  trajectory?: Trajectory;
  events: readonly unknown[];
}) {
  const projection = useMemo(() => projectTrajectory(events), [events]);
  const lanes = useMemo(() => buildLanes(projection), [projection]);
  const [selectedTurn, setSelectedTurn] = useState(() => defaultTurn(projection));
  const [view, setView] = useState<"turn" | "steps">("turn");
  const [filter, setFilter] = useState<StepFilter>(EMPTY_FILTER);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [focusStepId, setFocusStepId] = useState<string | null>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  // A new event stream (envelope arrived, session switched) resets the cursor.
  useEffect(() => {
    setSelectedTurn(defaultTurn(projection));
    setExpanded(new Set());
    setFocusStepId(null);
  }, [projection]);

  const turnCount = projection.turns.length;
  const selectTurn = useCallback(
    (index: number) => {
      if (turnCount === 0) return;
      setSelectedTurn(Math.min(turnCount - 1, Math.max(0, index)));
    },
    [turnCount],
  );

  // RLM-style keyboard navigation between turns. Ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      setSelectedTurn((cur) => {
        const next = e.key === "ArrowLeft" ? cur - 1 : cur + 1;
        return Math.min(Math.max(0, turnCount - 1), Math.max(0, next));
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turnCount]);

  useEffect(() => {
    const el = stripRef.current?.querySelector<HTMLElement>(`[data-turn-index="${selectedTurn}"]`);
    el?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedTurn]);

  useEffect(() => {
    if (!focusStepId) return;
    const el = document.querySelector<HTMLElement>(`[data-step-id="${cssEscape(focusStepId)}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [focusStepId, view, selectedTurn]);

  const toggleStep = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const seek = useCallback(
    (stepId: string) => {
      const step = projection.steps.find((s) => s.id === stepId);
      if (!step) return;
      setSelectedTurn(step.turn);
      setExpanded((prev) => new Set(prev).add(stepId));
      setFocusStepId(stepId);
    },
    [projection],
  );

  const filtered = useMemo(() => filterSteps(projection.steps, filter), [projection, filter]);
  const tools = useMemo(() => toolCounts(projection.steps), [projection]);
  const turn = projection.turns[selectedTurn];

  async function copyAll() {
    const text = transcriptText(projection.steps);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Transcript copied");
    } catch {
      toast.error("Could not copy transcript");
    }
  }

  return (
    <div className="flex flex-col gap-4 min-w-0" data-testid="trajectory-inspector">
      <RunHeader trajectory={trajectory} projection={projection} />
      <QuestionAnswer question={projection.question} answer={projection.answer} />
      {lanes && <RunTimeline lanes={lanes} activeStepId={focusStepId} onSeek={seek} />}

      {turnCount > 0 && (
        <TurnStrip
          turns={projection.turns}
          selected={selectedTurn}
          onSelect={selectTurn}
          stripRef={stripRef}
        />
      )}

      <FilterBar
        filter={filter}
        onChange={setFilter}
        tools={tools}
        view={view}
        onView={setView}
        onCopy={copyAll}
        total={projection.steps.length}
        shown={filtered.length}
      />

      {projection.steps.length === 0 ? (
        <div className="text-sm text-fg-subtle">This trajectory has no transcript events yet.</div>
      ) : view === "turn" && turn ? (
        <TurnSplit
          turn={turn}
          steps={projection.steps}
          filtered={filtered}
          runStartMs={projection.startMs}
          expanded={expanded}
          onToggle={toggleStep}
          focusStepId={focusStepId}
        />
      ) : (
        <section aria-label="All steps" className="min-w-0">
          <StepList
            steps={filtered}
            runStartMs={projection.startMs}
            expanded={expanded}
            onToggle={toggleStep}
            focusStepId={focusStepId}
            showTurn
            empty="No steps match the current filters."
          />
        </section>
      )}
    </div>
  );
}

function defaultTurn(p: TrajectoryProjection): number {
  const final = p.turns.findIndex((t) => t.isFinal);
  return final >= 0 ? final : Math.max(0, p.turns.length - 1);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}

// ─── Header + stats ──────────────────────────────────────────────────

function RunHeader({ trajectory, projection }: { trajectory?: Trajectory; projection: TrajectoryProjection }) {
  const summary = trajectory?.summary;
  const toolSteps = projection.steps.filter((s) => s.kind === "tool");
  const turns = projection.turns.length;
  const toolCalls = summary?.num_tool_calls ?? toolSteps.length;
  const toolErrors = summary?.num_tool_errors ?? toolSteps.filter((s) => s.isError).length;
  const durationMs =
    summary?.duration_ms ??
    (projection.startMs !== null && projection.endMs !== null ? projection.endMs - projection.startMs : null);
  const inTok = summary?.token_usage.input_tokens ?? projection.turns.reduce((n, t) => n + t.inputTokens, 0);
  const outTok = summary?.token_usage.output_tokens ?? projection.turns.reduce((n, t) => n + t.outputTokens, 0);

  return (
    <section aria-label="Run summary" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        {trajectory ? (
          <>
            <StatusPill status={outcomeToStatusTone(trajectory.outcome)} label={`Outcome: ${trajectory.outcome}`} />
            {trajectory.reward && (
              <StatusPill
                status={trajectory.reward.final_reward >= 0.99 ? "completed" : trajectory.reward.final_reward <= 0 ? "errored" : "neutral"}
                label={`Reward: ${rewardHeadline(trajectory.reward)}`}
              />
            )}
            {projection.steps.some((s) => s.kind === "error") && <StatusPill status="errored" label="Has errors" />}
            <span className="font-mono">{trajectory.model.id}</span>
            <span className="text-fg-subtle">· {trajectory.model.provider}</span>
            <span className="text-fg-subtle">· started {formatTimestamp(trajectory.started_at)}</span>
          </>
        ) : (
          <StatusPill status="running" label="Live events · envelope pending" />
        )}
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat label="Turns" value={String(turns)} />
        <Stat label="Steps" value={String(projection.steps.length)} />
        <Stat label="Tool calls" value={String(toolCalls)} />
        <Stat label="Tool errors" value={String(toolErrors)} tone={toolErrors > 0 ? "danger" : undefined} />
        <Stat label="Duration" value={durationMs !== null ? formatDuration(durationMs) : "—"} />
        <Stat label="Tokens in / out" value={`${formatTokens(inTok)} / ${formatTokens(outTok)}`} />
      </dl>
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "danger" }) {
  return (
    <div className="rounded-md bg-bg-surface px-3 py-2 min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-fg-subtle truncate">{label}</dt>
      <dd className={cn("font-mono text-sm truncate", tone === "danger" ? "text-danger" : "text-fg")}>{value}</dd>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
}

function QuestionAnswer({ question, answer }: { question: string | null; answer: string | null }) {
  if (!question && !answer) return null;
  return (
    <section aria-label="Question and answer" className="grid gap-2 md:grid-cols-2">
      <TextCard title="Question" text={question} empty="No user message." />
      <TextCard title="Final answer" text={answer} empty="No assistant message yet." />
    </section>
  );
}

function TextCard({ title, text, empty }: { title: string; text: string | null; empty: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-fg-subtle mb-1">{title}</div>
      {text ? (
        <div className="text-sm text-fg whitespace-pre-wrap break-words max-h-32 overflow-auto">{text}</div>
      ) : (
        <div className="text-sm text-fg-subtle">{empty}</div>
      )}
    </div>
  );
}

// ─── Wall-clock timeline ─────────────────────────────────────────────

const TONE_BAR: Record<LaneSegment["tone"], string> = {
  ok: "bg-success/70 hover:bg-success",
  error: "bg-danger/80 hover:bg-danger",
  pending: "bg-warning/70 hover:bg-warning",
};

function RunTimeline({
  lanes,
  activeStepId,
  onSeek,
}: {
  lanes: TrajectoryLanes;
  activeStepId: string | null;
  onSeek: (stepId: string) => void;
}) {
  const rows: Array<{ lane: "model" | "tools"; label: string }> = [
    { lane: "model", label: "Model" },
    { lane: "tools", label: "Tools" },
  ];
  return (
    <section aria-label="Run timeline" className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px] text-fg-subtle">
        <span className="uppercase tracking-wide">Timeline</span>
        <span className="font-mono">{formatDuration(lanes.totalMs)}</span>
      </div>
      {rows.map(({ lane, label }) => (
        <div key={lane} className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-[11px] text-fg-subtle">{label}</span>
          <div className="relative h-4 flex-1 rounded bg-bg-surface overflow-hidden" data-lane={lane}>
            {lanes.segments
              .filter((s) => s.lane === lane)
              .map((s, i) => {
                const { left, width } = segmentPosition(s, lanes.totalMs);
                return (
                  <Button
                    variant="ghost"
                    key={`${s.stepId}-${i}`}
                    type="button"
                    title={`${s.label} · +${formatDuration(s.startMs)}`}
                    aria-label={`Seek to ${s.label}`}
                    onClick={() => onSeek(s.stepId)}
                    className={cn(
                      "absolute top-0.5 bottom-0.5 h-auto min-w-0 rounded-sm border-0 p-0 cursor-pointer transition-colors",
                      TONE_BAR[s.tone],
                      activeStepId === s.stepId && "ring-2 ring-fg",
                    )}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  />
                );
              })}
          </div>
        </div>
      ))}
    </section>
  );
}

// ─── Turn strip ──────────────────────────────────────────────────────

const TRIGGER_LABEL: Record<TrajectoryTurn["trigger"], string> = {
  start: "start",
  user: "user",
  tool_results: "tool results",
  model_request: "model call",
};

function TurnStrip({
  turns,
  selected,
  onSelect,
  stripRef,
}: {
  turns: TrajectoryTurn[];
  selected: number;
  onSelect: (i: number) => void;
  stripRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <section aria-label="Turns" className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center justify-between text-[11px] text-fg-subtle">
        <span className="uppercase tracking-wide">Turns</span>
        <span>
          Turn {selected + 1} of {turns.length} · ←/→ to navigate
        </span>
      </div>
      <div ref={stripRef} role="listbox" aria-label="Turn strip" className="flex gap-2 overflow-x-auto pb-1">
        {turns.map((t) => {
          const active = t.index === selected;
          return (
            <Button
              variant="ghost"
              key={t.index}
              type="button"
              role="option"
              aria-selected={active}
              data-turn-index={t.index}
              onClick={() => onSelect(t.index)}
              className={cn(
                "h-auto shrink-0 min-w-28 flex-col items-start justify-start gap-0 whitespace-normal rounded-md border px-2.5 py-1.5 text-left font-normal transition-colors",
                active ? "border-brand bg-brand-subtle" : "border-border hover:border-border-strong hover:bg-bg-surface",
              )}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium text-fg">
                Turn {t.index + 1}
                <span className="text-[10px] font-normal text-fg-subtle">{TRIGGER_LABEL[t.trigger]}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {t.isFinal && <TurnBadge tone="success">FINAL</TurnBadge>}
                {t.errors > 0 && <TurnBadge tone="danger">ERR {t.errors}</TurnBadge>}
                {t.toolCalls > 0 && <TurnBadge>{t.toolCalls} tool{t.toolCalls === 1 ? "" : "s"}</TurnBadge>}
                {t.durationMs !== null && t.durationMs > 0 && <TurnBadge>{formatDuration(t.durationMs)}</TurnBadge>}
                {t.inputTokens + t.outputTokens > 0 && (
                  <TurnBadge>{formatTokens(t.inputTokens + t.outputTokens)} tok</TurnBadge>
                )}
              </div>
            </Button>
          );
        })}
      </div>
    </section>
  );
}

function TurnBadge({ tone, children }: { tone?: "success" | "danger"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1 py-px text-[10px] font-mono",
        tone === "success" ? "bg-success-subtle text-success" : tone === "danger" ? "bg-danger-subtle text-danger" : "bg-bg-surface text-fg-muted",
      )}
    >
      {children}
    </span>
  );
}

// ─── Filters ─────────────────────────────────────────────────────────

const FILTER_LABEL: Record<StepFilterKind, string> = {
  user: "User",
  assistant: "Assistant",
  thinking: "Thinking",
  tool: "Tools",
  error: "Errors",
};

function FilterBar({
  filter,
  onChange,
  tools,
  view,
  onView,
  onCopy,
  total,
  shown,
}: {
  filter: StepFilter;
  onChange: (f: StepFilter) => void;
  tools: Array<{ name: string; count: number }>;
  view: "turn" | "steps";
  onView: (v: "turn" | "steps") => void;
  onCopy: () => void;
  total: number;
  shown: number;
}) {
  const toggleKind = (k: StepFilterKind) => {
    const kinds = new Set(filter.kinds);
    if (kinds.has(k)) kinds.delete(k);
    else kinds.add(k);
    onChange({ ...filter, kinds });
  };
  const active = filter.kinds.size > 0 || filter.tool !== null || filter.query.trim() !== "";
  return (
    <section aria-label="Step filters" className="flex flex-wrap items-center gap-2">
      <div role="group" aria-label="View" className="flex rounded-md bg-bg-surface p-0.5">
        {(["turn", "steps"] as const).map((v) => (
          <Button
            variant="ghost"
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={cn(
              "h-auto rounded px-2 py-0.5 text-xs font-normal transition-colors",
              view === v ? "bg-bg text-fg font-medium shadow-sm" : "text-fg-subtle hover:text-fg",
            )}
          >
            {v === "turn" ? "By turn" : "All steps"}
          </Button>
        ))}
      </div>
      <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1">
        {STEP_FILTER_KINDS.map((k) => (
          <FilterPill key={k} pressed={filter.kinds.has(k)} onClick={() => toggleKind(k)}>
            {FILTER_LABEL[k]}
          </FilterPill>
        ))}
      </div>
      {tools.length > 0 && (
        <div role="group" aria-label="Tools filter" className="flex flex-wrap gap-1">
          {tools.map((t) => (
            <FilterPill
              key={t.name}
              mono
              pressed={filter.tool === t.name}
              onClick={() => onChange({ ...filter, tool: filter.tool === t.name ? null : t.name })}
            >
              {t.name} ({t.count})
            </FilterPill>
          ))}
        </div>
      )}
      <Input
        type="search"
        aria-label="Search steps"
        placeholder="Search steps…"
        value={filter.query}
        onChange={(e) => onChange({ ...filter, query: e.target.value })}
        className="h-7 w-44 text-xs md:text-xs"
      />
      {active && (
        <Button variant="ghost" size="xs" onClick={() => onChange(EMPTY_FILTER)}>
          Clear
        </Button>
      )}
      <span className="ml-auto text-xs text-fg-subtle">
        {shown === total ? `${total} steps` : `${shown} of ${total} steps`}
      </span>
      <Button variant="outline" size="xs" onClick={onCopy}>
        Copy transcript
      </Button>
    </section>
  );
}

function FilterPill({
  pressed,
  onClick,
  mono = false,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-auto rounded-full border px-2 py-0.5 text-xs font-normal transition-colors",
        mono && "font-mono",
        pressed ? "border-brand bg-brand-subtle text-brand" : "border-border text-fg-muted hover:border-border-strong",
      )}
    >
      {children}
    </Button>
  );
}

// ─── By-turn split ───────────────────────────────────────────────────

const CONVERSATION_KINDS: ReadonlySet<StepKind> = new Set(["user", "assistant", "thinking"]);

function TurnSplit({
  turn,
  steps,
  filtered,
  runStartMs,
  expanded,
  onToggle,
  focusStepId,
}: {
  turn: TrajectoryTurn;
  steps: TrajectoryStep[];
  filtered: TrajectoryStep[];
  runStartMs: number | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  focusStepId: string | null;
}) {
  const inTurn = new Set(turn.stepIds);
  const filteredIds = new Set(filtered.map((s) => s.id));
  const conversation = steps.filter((s) => inTurn.has(s.id) && CONVERSATION_KINDS.has(s.kind) && filteredIds.has(s.id));
  const execution = steps.filter((s) => inTurn.has(s.id) && !CONVERSATION_KINDS.has(s.kind) && filteredIds.has(s.id));
  return (
    <div className="grid gap-3 lg:grid-cols-2 min-w-0">
      <section aria-label="Conversation" className="min-w-0 flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-wide text-fg-subtle">Conversation · turn {turn.index + 1}</h3>
        {conversation.length === 0 ? (
          <div className="text-sm text-fg-subtle">No messages in this turn.</div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[45vh] overflow-auto pr-1">
            {conversation.map((s) => (
              <MessageBubble key={s.id} step={s} focused={focusStepId === s.id} />
            ))}
          </div>
        )}
      </section>
      <section aria-label="Execution" className="min-w-0 flex flex-col gap-2">
        <h3 className="text-[11px] uppercase tracking-wide text-fg-subtle">Execution · turn {turn.index + 1}</h3>
        <StepList
          steps={execution}
          runStartMs={runStartMs}
          expanded={expanded}
          onToggle={onToggle}
          focusStepId={focusStepId}
          empty="No tool calls in this turn."
        />
      </section>
    </div>
  );
}

function MessageBubble({ step, focused }: { step: TrajectoryStep; focused: boolean }) {
  const tone =
    step.kind === "user"
      ? "bg-info-subtle"
      : step.kind === "thinking"
      ? "bg-bg-surface italic text-fg-muted"
      : "bg-bg-bubble";
  return (
    <div
      data-step-id={step.id}
      className={cn("rounded-md px-3 py-2 min-w-0", tone, focused && "ring-2 ring-brand")}
    >
      <div className="mb-1"><KindBadge step={step} /></div>
      <div className="text-sm whitespace-pre-wrap break-words">{step.text || step.summary}</div>
    </div>
  );
}

// ─── Step list ───────────────────────────────────────────────────────

function StepList({
  steps,
  runStartMs,
  expanded,
  onToggle,
  focusStepId,
  showTurn = false,
  empty,
}: {
  steps: TrajectoryStep[];
  runStartMs: number | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  focusStepId: string | null;
  showTurn?: boolean;
  empty: string;
}) {
  const rows = useMemo(() => groupSteps(steps), [steps]);
  if (rows.length === 0) return <div className="text-sm text-fg-subtle">{empty}</div>;
  return (
    <ol className="flex flex-col gap-1 min-w-0" aria-label="Steps">
      {rows.map((row) =>
        isGroupRow(row) ? (
          <GroupRow
            key={row.id}
            row={row}
            runStartMs={runStartMs}
            expanded={expanded}
            onToggle={onToggle}
            focusStepId={focusStepId}
            showTurn={showTurn}
          />
        ) : (
          <StepRow
            key={row.id}
            step={row}
            runStartMs={runStartMs}
            open={expanded.has(row.id)}
            onToggle={onToggle}
            focused={focusStepId === row.id}
            showTurn={showTurn}
          />
        ),
      )}
    </ol>
  );
}

function GroupRow({
  row,
  runStartMs,
  expanded,
  onToggle,
  focusStepId,
  showTurn,
}: {
  row: TrajectoryGroupRow;
  runStartMs: number | null;
  expanded: ReadonlySet<string>;
  onToggle: (id: string) => void;
  focusStepId: string | null;
  showTurn: boolean;
}) {
  // A seek into the group (or an expanded child) forces it open.
  const containsActive = row.steps.some((s) => s.id === focusStepId || expanded.has(s.id));
  const open = expanded.has(row.id) || containsActive;
  const duration = row.startMs !== null && row.endMs !== null ? row.endMs - row.startMs : null;
  return (
    <li className="rounded-md border border-border min-w-0">
      <Button
        variant="ghost"
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(row.id)}
        className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-bg-surface"
      >
        <span className="rounded bg-bg-surface px-1.5 py-px font-mono text-[11px] text-fg-muted">{row.toolName}</span>
        <span className="truncate text-fg">
          {row.steps.length} {row.toolName} calls
        </span>
        {row.errors > 0 && <span className="text-xs text-danger">{row.errors} failed</span>}
        <span className="ml-auto shrink-0 font-mono text-xs text-fg-subtle">
          {duration !== null ? formatDuration(duration) : ""}
        </span>
      </Button>
      {open && (
        <ol className="flex flex-col gap-1 border-t border-border p-1">
          {row.steps.map((s) => (
            <StepRow
              key={s.id}
              step={s}
              runStartMs={runStartMs}
              open={expanded.has(s.id)}
              onToggle={onToggle}
              focused={focusStepId === s.id}
              showTurn={showTurn}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

const KIND_BADGE: Record<StepKind, string> = {
  user: "bg-info-subtle text-info",
  assistant: "bg-bg-surface text-fg",
  thinking: "bg-bg-surface text-fg-muted",
  tool: "bg-accent-violet-subtle text-accent-violet font-mono",
  error: "bg-danger-subtle text-danger",
  outcome: "bg-warning-subtle text-warning",
  status: "bg-bg-surface text-fg-muted",
};

function KindBadge({ step }: { step: TrajectoryStep }) {
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-px text-[11px]", KIND_BADGE[step.kind])}>
      {step.kind === "tool" && step.toolSource === "mcp" && step.mcpServer ? `${step.mcpServer}/` : ""}
      {step.label}
    </span>
  );
}

function StepRow({
  step,
  runStartMs,
  open,
  onToggle,
  focused,
  showTurn,
}: {
  step: TrajectoryStep;
  runStartMs: number | null;
  open: boolean;
  onToggle: (id: string) => void;
  focused: boolean;
  showTurn: boolean;
}) {
  const offset = runStartMs !== null && step.startMs !== null ? step.startMs - runStartMs : null;
  return (
    <li data-step-id={step.id} className={cn("rounded-md min-w-0", focused && "ring-2 ring-brand")}>
      <Button
        variant="ghost"
        type="button"
        aria-expanded={open}
        onClick={() => onToggle(step.id)}
        className="h-auto w-full justify-start gap-2 rounded-md px-2 py-1.5 text-left text-sm font-normal hover:bg-bg-surface"
      >
        {showTurn && <span className="w-8 shrink-0 font-mono text-[11px] text-fg-subtle">T{step.turn + 1}</span>}
        <KindBadge step={step} />
        <span className={cn("min-w-0 flex-1 truncate", step.isError ? "text-danger" : "text-fg")}>{step.summary}</span>
        {step.pending && <span className="shrink-0 text-xs text-warning">pending</span>}
        {step.orphan && <span className="shrink-0 text-xs text-fg-subtle">orphan</span>}
        {step.isError && step.kind === "tool" && <span className="shrink-0 text-xs text-danger">error</span>}
        <span className="shrink-0 font-mono text-xs text-fg-subtle">
          {step.durationMs !== null ? formatDuration(step.durationMs) : offset !== null ? `+${formatDuration(offset)}` : ""}
        </span>
      </Button>
      {open && <StepInspector step={step} />}
    </li>
  );
}

/** On-demand detail for one step: tool input (or diff) + output, or full text. */
export function StepInspector({ step }: { step: TrajectoryStep }) {
  const diff = step.kind === "tool" ? extractDiff(step.input) : null;
  return (
    <div className="mx-2 mb-2 mt-1 flex flex-col gap-2 rounded-md border border-border p-2" data-testid="step-inspector">
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-subtle font-mono">
        {step.callId && <span>call {step.callId}</span>}
        {step.events.map((e) => (
          <span key={e.index}>
            {e.type}
            {e.seq !== null ? ` #${e.seq}` : ""}
          </span>
        ))}
      </div>
      {step.kind === "tool" ? (
        <>
          {diff ? (
            <DetailBlock title={diff.path ? `Edit · ${diff.path}` : "Edit"}>
              <div className="font-mono text-xs" data-testid="step-diff">
                {diff.lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre-wrap break-all px-1",
                      l.kind === "add" && "bg-success-subtle text-success",
                      l.kind === "del" && "bg-danger-subtle text-danger",
                      l.kind === "hunk" && "text-info",
                      l.kind === "meta" && "text-fg-subtle",
                    )}
                  >
                    {l.text || " "}
                  </div>
                ))}
              </div>
            </DetailBlock>
          ) : step.input !== undefined ? (
            <DetailBlock title="Input">
              <MonoText text={typeof step.input === "string" ? step.input : JSON.stringify(step.input, null, 2)} />
            </DetailBlock>
          ) : null}
          <DetailBlock title={step.isError ? "Output (error)" : "Output"}>
            {step.pending ? (
              <span className="text-xs text-warning">No result recorded for this call.</span>
            ) : (
              <MonoText text={step.output || "(empty)"} danger={step.isError} />
            )}
          </DetailBlock>
        </>
      ) : (
        <DetailBlock title="Text">
          <MonoText text={step.text || step.summary} danger={step.kind === "error"} />
        </DetailBlock>
      )}
    </div>
  );
}

function DetailBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-fg-subtle">{title}</div>
      {children}
    </div>
  );
}

// Deliberately a <div>, not <pre>: the modal's single <pre> is the raw
// JSON view (the visual fixture locates it with `modal.locator('pre')`).
function MonoText({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      className={cn(
        "max-h-64 overflow-auto rounded bg-bg-surface px-2 py-1 font-mono text-xs whitespace-pre-wrap break-words",
        danger ? "text-danger" : "text-fg",
      )}
    >
      {text}
    </div>
  );
}
