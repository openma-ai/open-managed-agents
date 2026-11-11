// Dev-only fixture page for the unified Trace view (see trace-fixture.html).
// Renders SessionTrace from hand-written OMA events — no backend, no auth.
// SYNTHETIC DEMO DATA for review only: every event, time and token count
// below is made up; nothing here comes from a real session.
//
//   ?scenario=session   multi-turn: models, grouped reads, failed bash,
//                       pending MCP, 1h idle → scheduled wakeup, schedule
//                       wait, error turn (default)
//   ?scenario=subagent  sub-agent threads (session_thread_id ancestry)
//   ?scenario=unknown   unclosed turn → unknown gap, untimed step
//   ?scenario=untimed   no timestamps at all
//   ?scenario=compaction summarize span (usage) → thread_context_compacted
//                       boundary → session.warning oma.context_reassembled,
//                       plus an unpaired summarize_end and a pending start
//   ?scenario=gaps      zero-length handoff (no idle), 1h idle, unknown gap
//   ?theme=dark
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import "../index.css";
import { SessionTrace } from "../pages/session-detail/Trajectory";
import type { Trajectory } from "../lib/trajectory";

const T0 = Date.parse("2026-11-04T07:50:00.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();
type E = Record<string, unknown>;
const ev = (ms: number, e: E): E => ({ ...e, ts: at(ms) });
const MODEL = "claude-sonnet-4-6";

function generation(id: string, start: number, end: number, inTok: number, outTok: number, extra: E = {}): E[] {
  return [
    ev(start, { type: "span.model_request_start", id, model: MODEL }),
    ev(start + Math.round((end - start) * 0.4), { type: "span.model_first_token", model_request_start_id: id }),
    ev(end, { type: "span.model_request_end", model_request_start_id: id, model: MODEL, model_usage: { input_tokens: inTok, output_tokens: outTok, cache_read_input_tokens: Math.round(inTok * 0.6) }, finish_reason: "tool-calls", ...extra }),
  ];
}

function sessionScenario(): E[] {
  const H = 3_600_000;
  return [
    ev(0, { type: "user.message", id: "u1", content: [{ type: "text", text: "The checkout test is failing — find and fix it." }] }),
    ev(50, { type: "session.status_running" }),
    ...generation("m1", 120, 2_100, 4_210, 180),
    ev(2_150, { type: "agent.thinking", content: [{ type: "text", text: "Read the test and the three modules it touches." }] }),
    ev(2_200, { type: "agent.tool_use", id: "r1", name: "read", input: { file_path: "src/checkout.ts" } }),
    ev(2_210, { type: "agent.tool_use", id: "r2", name: "read", input: { file_path: "src/cart.ts" } }),
    ev(2_220, { type: "agent.tool_use", id: "r3", name: "read", input: { file_path: "test/checkout.test.ts" } }),
    ev(2_600, { type: "agent.tool_result", tool_use_id: "r1", content: "export function checkout(cart) { … }" }),
    ev(2_750, { type: "agent.tool_result", tool_use_id: "r2", content: "export class Cart { … }" }),
    ev(2_900, { type: "agent.tool_result", tool_use_id: "r3", content: "it('applies discount', …)" }),
    ...generation("m2", 3_000, 3_680, 6_900, 95),
    ev(3_700, { type: "agent.tool_use", id: "b1", name: "bash", input: { command: "npm test -- checkout" } }),
    ev(18_700, { type: "agent.tool_result", tool_use_id: "b1", content: "FAIL test/checkout.test.ts\n  ✕ applies discount (expected 90, got 100)", is_error: true }),
    ...generation("m3", 18_800, 19_317, 7_400, 210),
    ev(19_400, { type: "agent.tool_use", id: "e1", name: "edit", input: { file_path: "src/checkout.ts", old_string: "return total;", new_string: "return total - discount;" } }),
    ev(19_600, { type: "agent.tool_result", tool_use_id: "e1", content: "edited" }),
    ev(19_700, { type: "agent.tool_use", id: "b2", name: "bash", input: { command: "npm test -- checkout" } }),
    ev(24_700, { type: "agent.tool_result", tool_use_id: "b2", content: "PASS test/checkout.test.ts" }),
    ev(24_800, { type: "agent.mcp_tool_use", id: "g1", name: "create_comment", mcp_server_name: "github", input: { body: "Fixed discount" } }),
    ...generation("m4", 25_000, 25_517, 7_800, 64),
    ev(25_600, { type: "agent.message", content: [{ type: "text", text: "Fixed: checkout now subtracts the discount. Tests pass. I'll re-check CI in an hour." }] }),
    ev(25_650, { type: "span.wakeup_scheduled", id: "w1" }),
    ev(25_700, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    // ~1h idle, then the scheduled wakeup fires.
    ev(25_700 + H, { type: "user.message", parent_event_id: "w1", metadata: { harness: "schedule", kind: "wakeup" }, content: [{ type: "text", text: "Scheduled check: is CI green?" }] }),
    ...generation("m5", 25_800 + H, 27_200 + H, 8_100, 40),
    ev(27_300 + H, { type: "agent.tool_use", id: "b3", name: "bash", input: { command: "gh run list --limit 1" } }),
    ev(29_300 + H, { type: "agent.tool_result", tool_use_id: "b3", content: "completed success" }),
    ev(29_400 + H, { type: "agent.message", content: [{ type: "text", text: "CI is green." }] }),
    ev(29_500 + H, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ev(95_000 + H, { type: "user.message", content: [{ type: "text", text: "Deploy to staging." }] }),
    ev(95_100 + H, { type: "agent.custom_tool_use", id: "d1", name: "deploy", input: { environment: "staging" } }),
    ev(95_200 + H, { type: "session.status_idle", stop_reason: { type: "requires_action" } }),
    ev(140_000 + H, { type: "user.custom_tool_result", custom_tool_use_id: "d1", content: [{ type: "text", text: "deploy rejected: staging locked" }], is_error: true }),
    ...generation("m6", 140_100 + H, 141_000 + H, 8_400, 0, { is_error: true, error_message: "overloaded_error", finish_reason: "error" }),
    ev(141_050 + H, { type: "session.error", error: { type: "overloaded_error", message: "Model overloaded after 3 retries", retry_status: "exhausted" } }),
  ];
}

function subagentScenario(): E[] {
  return [
    ev(0, { type: "user.message", content: [{ type: "text", text: "Research pricing for three vendors." }] }),
    ...generation("p1", 100, 1_200, 2_000, 120),
    ev(1_300, { type: "session.thread_created", session_thread_id: "sthr_research", agent_id: "agent_r", agent_name: "researcher", parent_thread_id: null }),
    ev(1_350, { type: "agent.thread_message_sent", to_thread_id: "sthr_research", content: [{ type: "text", text: "Find pricing pages." }] }),
    ev(1_400, { type: "user.message", session_thread_id: "sthr_research", content: [{ type: "text", text: "Find pricing pages." }] }),
    ev(1_500, { type: "span.model_request_start", session_thread_id: "sthr_research", id: "s1", model: MODEL }),
    ev(2_900, { type: "span.model_request_end", session_thread_id: "sthr_research", model_request_start_id: "s1", model_usage: { input_tokens: 900, output_tokens: 60 } }),
    ev(3_000, { type: "agent.tool_use", session_thread_id: "sthr_research", id: "f1", name: "web_fetch", input: { url: "https://vendor-a.example/pricing" } }),
    ev(3_100, { type: "session.thread_created", session_thread_id: "sthr_fetch", agent_id: "agent_f", agent_name: "fetcher", parent_thread_id: "sthr_research" }),
    ev(3_200, { type: "agent.tool_use", session_thread_id: "sthr_fetch", id: "f2", name: "web_fetch", input: { url: "https://vendor-b.example/pricing" } }),
    ev(6_200, { type: "agent.tool_result", session_thread_id: "sthr_fetch", tool_use_id: "f2", content: "403 Forbidden", is_error: true }),
    ev(7_000, { type: "agent.tool_result", session_thread_id: "sthr_research", tool_use_id: "f1", content: "$12/seat" }),
    ev(7_100, { type: "session.thread_idle", session_thread_id: "sthr_research" }),
    ev(7_200, { type: "agent.thread_message_received", from_thread_id: "sthr_research", content: [{ type: "text", text: "A: $12/seat; B: blocked" }] }),
    ...generation("p2", 7_300, 8_400, 3_100, 150),
    ev(8_500, { type: "agent.message", content: [{ type: "text", text: "Vendor A is $12/seat; vendor B's page was blocked." }] }),
    ev(8_600, { type: "session.status_idle" }),
  ];
}

function unknownScenario(): E[] {
  return [
    ev(0, { type: "user.message", content: [{ type: "text", text: "Start a long build." }] }),
    ...generation("k1", 100, 900, 1_000, 40),
    ev(1_000, { type: "agent.tool_use", id: "x1", name: "bash", input: { command: "make all" } }),
    // No result and no status_idle: the turn never closed.
    ev(20_000, { type: "user.message", content: [{ type: "text", text: "Status?" }], delivery: "queued" }),
    { type: "agent.message", content: [{ type: "text", text: "This message has no timestamp." }] },
  ];
}

function untimedScenario(): E[] {
  return [
    { type: "user.message", content: [{ type: "text", text: "Fixture without timestamps" }] },
    { type: "agent.tool_use", id: "n1", name: "read", input: { file_path: "/a" } },
    { type: "agent.tool_result", tool_use_id: "n1", content: "a" },
    { type: "agent.message", content: [{ type: "text", text: "Done." }] },
    { type: "session.status_idle" },
  ];
}

function compactionScenario(): E[] {
  return [
    ev(0, { type: "user.message", id: "c-u1", content: [{ type: "text", text: "Keep refactoring the billing module until the suite passes." }] }),
    ev(40, { type: "session.status_running" }),
    ...generation("cm1", 100, 3_200, 148_000, 420),
    ev(3_300, { type: "agent.tool_use", id: "cr1", name: "read", input: { file_path: "src/billing/invoice.ts" } }),
    ev(3_700, { type: "agent.tool_result", tool_use_id: "cr1", content: "export function invoice(…) { … }" }),
    // Context near the limit: the harness summarizes, then writes the boundary.
    ev(3_800, { type: "span.compaction_summarize_start", model: MODEL }),
    ev(9_600, {
      type: "span.compaction_summarize_end",
      model: MODEL,
      model_usage: { input_tokens: 151_200, output_tokens: 1_380, cache_read_input_tokens: 147_900, cache_creation_input_tokens: 0 },
      finish_reason: "stop",
      final_text_length: 5_412,
    }),
    ev(9_650, {
      type: "agent.thread_context_compacted",
      summary: [{ type: "text", text: "Goal: refactor billing until tests pass.\nDone: read invoice.ts, extracted tax rules.\nNext: run npm test -- billing." }],
      original_message_count: 64,
      compacted_message_count: 1,
      trigger: "auto",
      pre_tokens: 152_300,
    }),
    ev(9_700, { type: "session.warning", source: "oma.context_reassembled", message: "Context re-assembled after compaction", details: { inlinedSkillIds: [] } }),
    ...generation("cm2", 9_800, 11_000, 6_100, 210),
    ev(11_100, { type: "agent.tool_use", id: "cb1", name: "bash", input: { command: "npm test -- billing" } }),
    ev(19_100, { type: "agent.tool_result", tool_use_id: "cb1", content: "PASS test/billing.test.ts" }),
    // Synthetic edge cases: an end with no start, and a start with no end.
    ev(19_200, { type: "span.compaction_summarize_end", finish_reason: "stop" }),
    ev(19_300, { type: "agent.message", content: [{ type: "text", text: "Billing refactor done; tests pass." }] }),
    ev(19_400, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    ev(80_000, { type: "user.message", id: "c-u2", content: [{ type: "text", text: "Now the reports module." }] }),
    ev(80_100, { type: "span.compaction_summarize_start", model: MODEL }),
  ];
}

function gapsScenario(): E[] {
  const H = 3_600_000;
  return [
    ev(0, { type: "user.message", content: [{ type: "text", text: "Turn 1" }] }),
    ...generation("g1", 100, 1_400, 900, 30),
    ev(1_500, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    // Next trigger at exactly the close time: zero-length, no idle gap.
    ev(1_500, { type: "user.message", content: [{ type: "text", text: "Turn 2 (zero gap)" }] }),
    ...generation("g2", 1_600, 2_800, 1_100, 40),
    ev(2_900, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
    // 1h idle.
    ev(2_900 + H, { type: "user.message", content: [{ type: "text", text: "Turn 3 (after 1h idle)" }] }),
    ...generation("g3", 3_000 + H, 4_200 + H, 1_300, 50),
    ev(4_300 + H, { type: "agent.tool_use", id: "gt1", name: "bash", input: { command: "sleep 600" } }),
    // No status_idle: the next interval is unknown, never idle.
    ev(60_000 + H, { type: "user.message", content: [{ type: "text", text: "Turn 4 (after unknown gap)" }] }),
    ev(60_100 + H, { type: "agent.message", content: [{ type: "text", text: "Still here." }] }),
    ev(60_200 + H, { type: "session.status_idle", stop_reason: { type: "end_turn" } }),
  ];
}

const SCENARIOS: Record<string, () => E[]> = {
  session: sessionScenario,
  subagent: subagentScenario,
  unknown: unknownScenario,
  untimed: untimedScenario,
  compaction: compactionScenario,
  gaps: gapsScenario,
};

const name = new URLSearchParams(location.search).get("scenario") ?? "session";
const events = (SCENARIOS[name] ?? sessionScenario)();
const envelope: Trajectory = {
  schema_version: "oma.trajectory.v1",
  trajectory_id: `trj_fixture_${name}`,
  session_id: "sesn_fixture",
  agent_config: {},
  environment_config: {},
  model: { id: MODEL, provider: "anthropic" },
  started_at: at(0),
  outcome: "success",
  // Stored like the real envelope: StoredEvent rows with JSON `data`.
  events: events.map((e, i) => ({ seq: i + 1, type: e.type, data: JSON.stringify(e), ts: e.ts })),
  summary: {
    num_events: events.length, num_turns: 0, num_tool_calls: 0, num_tool_errors: 0, num_threads: 1, duration_ms: 0,
    token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="h-screen flex flex-col">
      <div role="note" className="px-6 py-2 text-xs border-b border-warning/40 bg-warning-subtle/60 text-fg-muted" data-fixture-banner>
        <strong className="text-warning font-medium">Synthetic demo data</strong> — for review only, not a real session.
        {" "}Scenario <span className="font-mono text-fg">{name}</span> · try{" "}
        <span className="font-mono">?scenario=</span>session, compaction, gaps, subagent, unknown, untimed (<span className="font-mono">&amp;theme=dark</span>)
      </div>
      <SessionTrace sessionId="sesn_fixture" events={[]} trajectory={envelope} />
    </div>
    <Toaster />
  </StrictMode>,
);
