import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import type { Trajectory } from "../../lib/trajectory";
import {
  SessionTrace,
  TrajectoryOutcomeChip,
  TrajectoryRewardChip,
  trajectoryNeedsFetch,
  useTrajectoryLoader,
} from "./Trajectory";

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toastMock }));

const T0 = Date.parse("2026-11-07T00:00:00Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
let seq = 0;
const stored = (ms: number, ev: Record<string, unknown>) => ({ seq: ++seq, type: ev.type, data: JSON.stringify(ev), ts: iso(ms) });

function envelope(events: unknown[], extra: Partial<Trajectory> = {}): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "trj_1",
    session_id: "sesn_1",
    agent_config: {},
    environment_config: {},
    model: { id: "claude-sonnet-4-6", provider: "anthropic" },
    started_at: iso(0),
    ended_at: iso(5000),
    outcome: "success",
    events,
    summary: {
      num_events: events.length,
      num_turns: 2,
      num_tool_calls: 5,
      num_tool_errors: 1,
      num_threads: 1,
      duration_ms: 5000,
      token_usage: { input_tokens: 3000, output_tokens: 130, cache_read_input_tokens: 0 },
    },
    ...extra,
  };
}

function richEvents() {
  seq = 0;
  return [
    stored(0, { type: "user.message", content: [{ type: "text", text: "Fix the failing test" }] }),
    stored(100, { type: "span.model_request_start", id: "m1" }),
    stored(900, { type: "span.model_request_end", model_request_start_id: "m1", model_usage: { input_tokens: 1000, output_tokens: 50 } }),
    stored(1000, { type: "agent.tool_use", id: "r1", name: "read", input: { file_path: "/a.ts" } }),
    stored(1010, { type: "agent.tool_use", id: "r2", name: "read", input: { file_path: "/b.ts" } }),
    stored(1020, { type: "agent.tool_use", id: "r3", name: "read", input: { file_path: "/c.ts" } }),
    stored(1100, { type: "agent.tool_result", tool_use_id: "r1", content: "A body" }),
    stored(1200, { type: "agent.tool_result", tool_use_id: "r2", content: "B body" }),
    stored(1300, { type: "agent.tool_result", tool_use_id: "r3", content: "C body" }),
    stored(1400, { type: "span.model_request_start", id: "m2" }),
    stored(2000, { type: "span.model_request_end", model_request_start_id: "m2", model_usage: { input_tokens: 2000, output_tokens: 80 } }),
    stored(2100, { type: "agent.tool_use", id: "e1", name: "edit", input: { file_path: "/a.ts", old_string: "bug()", new_string: "fix()" } }),
    stored(2400, { type: "agent.tool_result", tool_use_id: "e1", content: "edited" }),
    stored(2500, { type: "agent.tool_use", id: "b1", name: "bash", input: { command: "npm test" } }),
    stored(4000, { type: "agent.tool_result", tool_use_id: "b1", content: "1 failing", is_error: true }),
    stored(4500, { type: "agent.message", content: [{ type: "text", text: "Patched the bug; one test still fails." }] }),
  ];
}

function renderTrace(props: Partial<Parameters<typeof SessionTrace>[0]> = {}) {
  const onRetry = vi.fn();
  const utils = render(
    <SessionTrace sessionId="sesn_1" events={[]} trajectory={envelope(richEvents())} onRetry={onRetry} {...props} />,
  );
  return { ...utils, onRetry };
}

const tree = () => screen.getByRole("tree", { name: "Trace tree" });
const details = () => screen.getByRole("complementary", { name: "Event details" });

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("SessionTrace envelope states", () => {
  it("loading: status strip, Download disabled, no raw JSON", () => {
    const { container } = renderTrace({ trajectory: "loading" });
    expect(screen.getByRole("status")).toHaveTextContent("Loading trajectory envelope…");
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeDisabled();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.getByText(/No events yet/)).toBeInTheDocument();
  });

  it("error: Retry calls back and Download stays disabled", () => {
    const { onRetry } = renderTrace({ trajectory: "error", events: [{ type: "agent.message", text: "live", ts: iso(0) }] });
    expect(screen.getByRole("alert")).toHaveTextContent(/Trajectory unavailable/);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeDisabled();
    // Live events still render while the envelope is unavailable.
    expect(within(tree()).getByRole("treeitem", { name: /agent\.message/ })).toBeInTheDocument();
  });

  it("ready: header facts, Download, and a collapsed Raw JSON disclosure", () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container } = renderTrace({ trajectory: envelope(richEvents(), { reward: { raw_rewards: {}, final_reward: 1 } }) });

    const summary = screen.getByRole("region", { name: "Trace summary" });
    expect(within(summary).getByText("trj_1")).toBeInTheDocument();
    expect(within(summary).getByText("success")).toBeInTheDocument();
    expect(within(summary).getByText("PASS")).toBeInTheDocument();
    expect(within(summary).getByText("Tool calls").nextSibling).toHaveTextContent("5");
    expect(within(summary).getByText("Tokens in / out").nextSibling).toHaveTextContent("3.0k / 130");

    // Raw JSON is secondary: closed and not rendered until opened.
    const raw = container.querySelector<HTMLDetailsElement>("details[aria-label='Raw JSON']")!;
    expect(raw.open).toBe(false);
    expect(raw.querySelector("pre")).toBeNull();
    raw.open = true;
    fireEvent(raw, new Event("toggle"));
    expect(raw.querySelector("pre")!.textContent).toContain('"trajectory_id": "trj_1"');

    fireEvent.click(screen.getByRole("button", { name: "Download JSON" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("prefers live events over envelope events when both exist", () => {
    renderTrace({ events: [{ type: "user.message", content: [{ type: "text", text: "live question" }], ts: iso(0) }] });
    expect(within(tree()).getByRole("treeitem", { name: /^user\.message.*live question/ })).toBeInTheDocument();
    expect(within(tree()).queryByRole("treeitem", { name: /Fix the failing test/ })).toBeNull();
  });

  it("untimed fixture events: tree works, overview explains missing timestamps", () => {
    const events = Array.from({ length: 3 }, (_, i) => ({ id: `e${i}`, type: "agent.message", text: `Fixture event ${i}` }));
    renderTrace({ trajectory: envelope(events) });
    expect(screen.getByRole("note")).toHaveTextContent(/No timestamps/);
    expect(within(tree()).getAllByRole("treeitem", { name: /Fixture event/ })).toHaveLength(3);
    expect(within(screen.getByRole("region", { name: "Trace summary" })).getByText("Started").nextSibling).toHaveTextContent("unknown");
  });
});

describe("Trace interactions", () => {
  it("starts with the empty inspector", () => {
    renderTrace();
    expect(within(details()).getByText("Select an event to view details")).toBeInTheDocument();
  });

  it("clicking an overview bar selects its tree row (opening a folded group) and the inspector", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    renderTrace();
    // Grouped reads start folded.
    const group = within(tree()).getByRole("treeitem", { name: /3 read calls/ });
    expect(group).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Select read: /b.ts" }));
    expect(group).toHaveAttribute("aria-expanded", "true");
    const row = within(tree()).getByRole("treeitem", { name: /\/b\.ts/ });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(scroll).toHaveBeenCalled();
    const insp = within(details());
    expect(insp.getByText("B body")).toBeInTheDocument();
    expect(insp.getByText("r2")).toBeInTheDocument();
    expect(insp.getByText("agent.tool_use #5, agent.tool_result #8")).toBeInTheDocument();
    expect(within(insp.getByRole("region", { name: "Timing" })).getByText("190ms")).toBeInTheDocument();
    // The inspector header repeats the duration next to the selected label.
    expect(insp.getByTestId("inspector-header")).toHaveTextContent("190ms");
    // Selected bar, tree row and inspector share the same selection.
    expect(screen.getByRole("button", { name: "Select read: /b.ts" }).className).toMatch(/ring-info/);
    // Fit selection is enabled once something is selected.
    expect(screen.getByRole("button", { name: "Fit selection" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Fit selection" }));
    expect(screen.getByRole("button", { name: "Auto-pick scale by event density" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(insp.getByRole("button", { name: "Close details" }));
    expect(within(details()).getByText("Select an event to view details")).toBeInTheDocument();
  });

  it("selects a turn from the overview and shows turn timing without inventing an end", () => {
    renderTrace();
    fireEvent.click(screen.getByRole("button", { name: "Select Turn 1" }));
    const insp = within(details());
    expect(insp.getByText("open — no status_idle / terminated / error yet")).toBeInTheDocument();
    expect(insp.getByText("4.50s so far")).toBeInTheDocument();
    expect(insp.getByText("3000 / 130")).toBeInTheDocument();
  });

  it("shows failed tool state in tree, overview and inspector", () => {
    const { container } = renderTrace();
    const bash = within(tree()).getByRole("treeitem", { name: /npm test/ });
    expect(within(bash).getByText("Failed")).toBeInTheDocument();
    expect(within(bash).getByText("1.50s")).toBeInTheDocument();
    expect(container.querySelector("[data-step-bar='tool'][data-failed='true']")).not.toBeNull();
    fireEvent.click(bash);
    expect(within(details()).getByText("Output (error)")).toBeInTheDocument();
    expect(within(details()).getByText("1 failing")).toBeInTheDocument();
  });

  it("renders file-edit inputs as a diff and model usage", () => {
    renderTrace();
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /^edit/ }));
    const diff = within(details()).getByTestId("step-diff");
    expect(diff).toHaveTextContent("Edit · /a.ts");
    expect(diff).toHaveTextContent("-bug()");
    expect(diff).toHaveTextContent("+fix()");

    fireEvent.click(within(tree()).getAllByRole("treeitem", { name: /^Generation/ })[0]!);
    const usage = within(within(details()).getByRole("region", { name: "Usage" }));
    expect(usage.getByText("1000")).toBeInTheDocument();
    expect(usage.getByText("Model").nextSibling).toHaveTextContent("not reported");
  });

  it("keeps pending calls, orphans, MCP and errors visible with explicit unknowns", () => {
    const events = [
      { type: "user.message", text: "hi", ts: iso(0) },
      { type: "agent.custom_tool_use", id: "p", name: "approve", input: "raw", ts: iso(10) },
      { type: "agent.mcp_tool_use", id: "q", name: "search", mcp_server_name: "gh", input: { query: "x" } },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "q", content: "" },
      { type: "agent.tool_result", tool_use_id: "ghost", content: "late", ts: iso(30) },
      { type: "session.error", error: "kaput", ts: iso(40) },
    ];
    renderTrace({ trajectory: envelope(events) });
    const pending = within(tree()).getByRole("treeitem", { name: /approve/ });
    expect(within(pending).getAllByText("pending").length).toBeGreaterThan(0);
    fireEvent.click(pending);
    expect(within(details()).getByText("No result recorded for this call.")).toBeInTheDocument();
    expect(within(details()).getByText("pending — no result recorded")).toBeInTheDocument();

    const mcp = within(tree()).getByRole("treeitem", { name: /gh:search/ });
    expect(within(mcp).getByText("no time")).toBeInTheDocument();
    expect(within(mcp).getByText("—")).toBeInTheDocument();
    fireEvent.click(mcp);
    expect(within(details()).getByText("(empty)")).toBeInTheDocument();
    expect(within(within(details()).getByRole("region", { name: "Timing" })).getAllByText("unknown").length).toBeGreaterThan(0);

    expect(within(tree()).getByRole("treeitem", { name: /no matching call/ })).toHaveTextContent("orphan");
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /session\.error/ }));
    expect(within(details()).getByRole("region", { name: "Error" })).toHaveTextContent("kaput");
    // session.error closes the turn as errored.
    expect(within(tree()).getByRole("treeitem", { name: /Turn 1/ })).toHaveTextContent("errored");
  });

  it("filters by kind, tool and search, and clears", () => {
    renderTrace();
    expect(screen.getByText("9 steps")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Errors" }));
    expect(screen.getByText("1 of 9 steps")).toBeInTheDocument();
    expect(within(tree()).getByRole("treeitem", { name: /npm test/ })).toBeInTheDocument();
    expect(within(tree()).queryByRole("treeitem", { name: /3 read calls/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Errors" }));

    const readChip = within(screen.getByRole("group", { name: "Tools filter" })).getByRole("button", { name: "read (3)" });
    fireEvent.click(readChip);
    expect(readChip).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("3 of 9 steps")).toBeInTheDocument();
    fireEvent.click(readChip);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search steps" }), { target: { value: "zzz" } });
    expect(screen.getByText("No steps match the current filters.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByText("9 steps")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
  });

  it("moves through the tree with the keyboard", () => {
    renderTrace();
    fireEvent.click(within(tree()).getByRole("treeitem", { name: /Turn 1/ }));
    fireEvent.keyDown(tree(), { key: "ArrowDown" });
    expect(within(tree()).getByRole("treeitem", { name: /Fix the failing test/, selected: true })).toBeInTheDocument();
    fireEvent.keyDown(tree(), { key: "ArrowUp" });
    const turn = within(tree()).getByRole("treeitem", { name: /Turn 1/ });
    expect(turn).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(tree(), { key: "ArrowLeft" });
    expect(turn).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(tree(), { key: "ArrowRight" });
    expect(turn).toHaveAttribute("aria-expanded", "true");
  });

  it("brush-drags on the overview to zoom into a time range", () => {
    const { container } = renderTrace();
    const chart = container.querySelector<HTMLElement>("[data-overview-chart]")!;
    vi.spyOn(chart, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 100, width: 800, height: 100, x: 0, y: 0, toJSON: () => ({}) });
    const before = Number(chart.dataset.chartPx);
    fireEvent.mouseDown(chart, { button: 0, clientX: 100 });
    fireEvent.mouseMove(window, { clientX: 200 });
    expect(screen.getByTestId("overview-brush")).toBeInTheDocument();
    fireEvent.mouseUp(window, { clientX: 200 });
    expect(screen.queryByTestId("overview-brush")).toBeNull();
    expect(Number(chart.dataset.chartPx)).toBeGreaterThan(before);
  });

  it("copies the transcript", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderTrace();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    });
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain("## Turn 1 · user message · running");
    expect(text).toContain("[user] Fix the failing test");
    expect(text).toContain("[tool bash · error");
    expect(toastMock.success).toHaveBeenCalledWith("Transcript copied");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy transcript" }));
    });
    expect(toastMock.error).toHaveBeenCalledWith("Could not copy transcript");
  });
});

describe("chips", () => {
  it("outcome chip hides for non-ready and running trajectories", () => {
    const { container, rerender } = render(<TrajectoryOutcomeChip trajectory="loading" />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TrajectoryOutcomeChip trajectory={envelope([], { outcome: "running" })} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<TrajectoryOutcomeChip trajectory={envelope([], { outcome: "failure" })} />);
    expect(screen.getByText("Outcome: failure")).toBeInTheDocument();
  });

  it("reward chip shows headline and verifier tooltip", () => {
    const { container, rerender } = render(<TrajectoryRewardChip trajectory={envelope([])} />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <TrajectoryRewardChip
        trajectory={envelope([], { reward: { raw_rewards: {}, final_reward: 1, verifier_id: "v1", computed_at: iso(0) } })}
      />,
    );
    expect(screen.getByText("Reward: PASS").parentElement!.getAttribute("title")).toContain("verifier: v1");
  });
});

describe("trajectory loading", () => {
  it("trajectoryNeedsFetch", () => {
    expect(trajectoryNeedsFetch(undefined)).toBe(true);
    expect(trajectoryNeedsFetch("error")).toBe(true);
    expect(trajectoryNeedsFetch("loading")).toBe(false);
    expect(trajectoryNeedsFetch(envelope([]))).toBe(false);
    expect(trajectoryNeedsFetch(envelope([], { outcome: "running" }))).toBe(true);
  });

  it("fetches the envelope from the OMA route", async () => {
    let hits = 0;
    server.use(
      http.get("/v1/oma/sessions/:id/trajectory", ({ params }) => {
        hits += 1;
        return HttpResponse.json(envelope([], { session_id: String(params.id) }));
      }),
    );
    const { result } = renderHook(() => useTrajectoryLoader("sesn_1"));
    expect(result.current.trajectory).toBeUndefined();
    act(() => void result.current.load());
    expect(result.current.trajectory).toBe("loading");
    await waitFor(() => expect(typeof result.current.trajectory).toBe("object"));
    expect((result.current.trajectory as Trajectory).session_id).toBe("sesn_1");
    expect(hits).toBe(1);
  });

  it("reports errors as the error sentinel", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    server.use(
      http.get("/v1/oma/sessions/:id/trajectory", () =>
        HttpResponse.json({ type: "error", error: { type: "not_found_error", message: "nope" } }, { status: 404 }),
      ),
    );
    const { result } = renderHook(() => useTrajectoryLoader("sesn_1"));
    await act(async () => result.current.load());
    expect(result.current.trajectory).toBe("error");
  });

  it("resets on session change and drops stale responses", async () => {
    let release: (() => void) | undefined;
    server.use(
      http.get("/v1/oma/sessions/:id/trajectory", async ({ params }) => {
        if (params.id === "slow") await new Promise<void>((r) => (release = r));
        return HttpResponse.json(envelope([], { session_id: String(params.id) }));
      }),
    );
    const { result, rerender } = renderHook(({ id }: { id: string | undefined }) => useTrajectoryLoader(id), {
      initialProps: { id: "slow" as string | undefined },
    });
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.load();
    });
    expect(result.current.trajectory).toBe("loading");
    rerender({ id: "fast" });
    expect(result.current.trajectory).toBeUndefined();
    await waitFor(() => expect(release).toBeDefined());
    await act(async () => {
      release!();
      await pending;
    });
    expect(result.current.trajectory).toBeUndefined();

    rerender({ id: undefined });
    await act(async () => result.current.load());
    expect(result.current.trajectory).toBeUndefined();
  });
});
