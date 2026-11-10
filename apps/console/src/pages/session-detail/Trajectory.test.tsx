import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import type { Trajectory } from "../../lib/trajectory";
import {
  TrajectoryOutcomeChip,
  TrajectoryRewardChip,
  TrajectoryViewerModal,
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

function renderModal(props: Partial<Parameters<typeof TrajectoryViewerModal>[0]> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <TrajectoryViewerModal open onClose={onClose} sessionId="sesn_1" trajectory={envelope(richEvents())} {...props} />,
  );
  return { ...utils, onClose, dialog: screen.getByRole("dialog", { name: "Trajectory" }) };
}

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("TrajectoryViewerModal states", () => {
  it("shows loading with Download disabled", () => {
    const { dialog } = renderModal({ trajectory: "loading" });
    expect(within(dialog).getByText("Loading trajectory…")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Download JSON" })).toBeDisabled();
    expect(dialog.querySelector("pre")).toBeNull();
  });

  it("shows error with Retry", () => {
    const onRetry = vi.fn();
    const { dialog } = renderModal({ trajectory: "error", onRetry });
    expect(within(dialog).getByText(/Trajectory unavailable/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("button", { name: "Download JSON" })).toBeDisabled();
  });

  it("shows the empty state when nothing was loaded", () => {
    const { dialog } = renderModal({ trajectory: undefined });
    expect(within(dialog).getByText("No trajectory loaded yet.")).toBeInTheDocument();
  });

  it("renders a provisional transcript from live events while loading", () => {
    const { dialog } = renderModal({ trajectory: "loading", liveEvents: [{ type: "agent.message", text: "live hello" }] });
    expect(within(dialog).getByText("Live events · envelope pending")).toBeInTheDocument();
    expect(within(dialog).getAllByText("live hello").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "Download JSON" })).toBeDisabled();
  });

  it("ready: renders stats, Q/A, exactly one raw JSON <pre>, and downloads", () => {
    const create = vi.fn(() => "blob:x");
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { dialog } = renderModal();

    expect(within(dialog).getByText("trj_1 · session sesn_1")).toBeInTheDocument();
    expect(within(dialog).getByText("Outcome: success")).toBeInTheDocument();
    expect(within(dialog).getByText("claude-sonnet-4-6")).toBeInTheDocument();
    const stats = within(dialog).getByRole("region", { name: "Run summary" });
    expect(within(stats).getByText("Tool calls").nextSibling).toHaveTextContent("5");
    expect(within(stats).getByText("Tokens in / out").nextSibling).toHaveTextContent("3.0k / 130");
    expect(within(dialog).getByText("Fix the failing test", { selector: "div" })).toBeInTheDocument();

    const pres = dialog.querySelectorAll("pre");
    expect(pres).toHaveLength(1);
    expect(pres[0]!.textContent).toContain('"trajectory_id": "trj_1"');

    fireEvent.click(within(dialog).getByRole("button", { name: "Download JSON" }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("renders the reward pill and a has-errors badge", () => {
    const events = [{ type: "session.error", message: "boom" }];
    const { dialog } = renderModal({
      trajectory: envelope(events, { reward: { raw_rewards: {}, final_reward: 0.5 }, outcome: "failure", started_at: "not-a-date" }),
    });
    expect(within(dialog).getByText("Reward: 0.50")).toBeInTheDocument();
    expect(within(dialog).getByText("Has errors")).toBeInTheDocument();
    expect(within(dialog).getByText(/started not-a-date/)).toBeInTheDocument();
  });

  it("handles the fixture shape: flattened events, no timing, no tools", () => {
    const events = Array.from({ length: 5 }, (_, i) => ({ id: i, type: "agent.message", text: `Fixture event ${i}` }));
    const { dialog } = renderModal({ trajectory: envelope(events) });
    expect(within(dialog).queryByRole("region", { name: "Run timeline" })).toBeNull();
    expect(within(dialog).getByText("No tool calls in this turn.")).toBeInTheDocument();
    expect(within(dialog).getByText("No user message.")).toBeInTheDocument();
    expect(dialog.querySelectorAll("pre")).toHaveLength(1);
  });

  it("explains an envelope with no transcript events", () => {
    const { dialog } = renderModal({ trajectory: envelope([{ type: "session.status_idle" }]) });
    expect(within(dialog).getByText("This trajectory has no transcript events yet.")).toBeInTheDocument();
  });
});

describe("TrajectoryInspector interactions", () => {
  it("defaults to the final turn and switches turns by click and arrow keys", () => {
    const { dialog } = renderModal();
    const strip = within(dialog).getByRole("listbox", { name: "Turn strip" });
    const options = within(strip).getAllByRole("option");
    // reads → edit → bash → final answer: each tool result hands control back.
    expect(options).toHaveLength(4);
    expect(options[3]).toHaveAttribute("aria-selected", "true");
    expect(within(options[3]!).getByText("FINAL")).toBeInTheDocument();
    expect(within(options[2]!).getByText("ERR 1")).toBeInTheDocument();
    expect(within(options[0]!).getByText("3 tools")).toBeInTheDocument();
    expect(within(options[1]!).getByText("1 tool")).toBeInTheDocument();

    fireEvent.click(options[0]!);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    const exec = within(dialog).getByRole("region", { name: "Execution" });
    expect(within(exec).getByText("3 read calls")).toBeInTheDocument();
    const convo = within(dialog).getByRole("region", { name: "Conversation" });
    expect(within(convo).getByText("Fix the failing test")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    // Other keys and keys typed into inputs are ignored.
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.keyDown(within(dialog).getByRole("searchbox", { name: "Search steps" }), { key: "ArrowRight" });
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("expands grouped calls and opens the inspector with paired output", () => {
    const { dialog } = renderModal();
    fireEvent.click(within(dialog).getAllByRole("option")[0]!);
    const exec = within(dialog).getByRole("region", { name: "Execution" });
    fireEvent.click(within(exec).getByRole("button", { name: /3 read calls/ }));
    const row = within(exec).getByRole("button", { name: /\/b\.ts/ });
    fireEvent.click(row);
    const inspector = within(exec).getByTestId("step-inspector");
    expect(inspector).toHaveTextContent("call r2");
    expect(inspector).toHaveTextContent("B body");
    expect(inspector).toHaveTextContent("agent.tool_use #5");
    expect(inspector).toHaveTextContent("agent.tool_result #8");
    fireEvent.click(row);
    expect(within(exec).queryByTestId("step-inspector")).toBeNull();
  });

  it("renders file-edit inputs as a diff and error output", () => {
    const { dialog } = renderModal();
    fireEvent.click(within(dialog).getAllByRole("option")[1]!);
    const exec = within(dialog).getByRole("region", { name: "Execution" });
    fireEvent.click(within(exec).getByRole("button", { name: /edit/ }));
    const diff = within(exec).getByTestId("step-diff");
    expect(diff).toHaveTextContent("-bug()");
    expect(diff).toHaveTextContent("+fix()");
    expect(within(exec).getByText("Edit · /a.ts")).toBeInTheDocument();

    fireEvent.click(within(dialog).getAllByRole("option")[2]!);
    const exec2 = within(dialog).getByRole("region", { name: "Execution" });
    fireEvent.click(within(exec2).getByRole("button", { name: /npm test/ }));
    expect(within(exec2).getByText("Output (error)")).toBeInTheDocument();
    expect(within(exec2).getByText("1 failing")).toBeInTheDocument();
  });

  it("shows text inspectors and pending calls in the all-steps view", () => {
    const events = [
      { type: "user.message", text: "hi" },
      { type: "agent.tool_use", id: "p", name: "custom_thing", input: "raw" },
      { type: "agent.mcp_tool_use", id: "q", name: "search", mcp_server_name: "gh", input: { query: "x" } },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "q", content: "" },
      { type: "session.error", message: "kaput" },
    ];
    const { dialog } = renderModal({ trajectory: envelope(events) });
    fireEvent.click(within(dialog).getByRole("button", { name: "All steps" }));
    const list = within(dialog).getByRole("region", { name: "All steps" });
    expect(within(list).getByText("gh/search")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: /custom_thing/ }));
    expect(within(list).getByText("No result recorded for this call.")).toBeInTheDocument();
    expect(within(list).getByText("pending")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: /gh\/search/ }));
    expect(within(list).getByText("(empty)")).toBeInTheDocument();
    fireEvent.click(within(list).getByRole("button", { name: /kaput/ }));
    expect(within(list).getAllByText("kaput").length).toBeGreaterThan(1);
  });

  it("filters by kind, tool and search, and clears", () => {
    const { dialog } = renderModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "All steps" }));
    const list = () => within(dialog).getByRole("region", { name: "All steps" });
    expect(within(dialog).getByText("7 steps")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Errors" }));
    expect(within(dialog).getByText("1 of 7 steps")).toBeInTheDocument();
    expect(within(list()).getByText("npm test")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Errors" }));

    const toolChips = within(dialog).getByRole("group", { name: "Tools filter" });
    const readChip = within(toolChips).getByRole("button", { name: "read (3)" });
    fireEvent.click(readChip);
    expect(readChip).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("3 of 7 steps")).toBeInTheDocument();
    fireEvent.click(readChip);
    expect(within(dialog).getByText("7 steps")).toBeInTheDocument();

    fireEvent.change(within(dialog).getByRole("searchbox", { name: "Search steps" }), { target: { value: "zzz" } });
    expect(within(list()).getByText("No steps match the current filters.")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    expect(within(dialog).getByText("7 steps")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Clear" })).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "By turn" }));
    expect(within(dialog).getByRole("region", { name: "Execution" })).toBeInTheDocument();
  });

  it("hides conversation rows filtered out in the by-turn view", () => {
    const { dialog } = renderModal();
    fireEvent.click(within(dialog).getByRole("button", { name: "Tools" }));
    const convo = within(dialog).getByRole("region", { name: "Conversation" });
    expect(within(convo).getByText("No messages in this turn.")).toBeInTheDocument();
  });

  it("seeks from a timeline segment to its step", () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    const { dialog } = renderModal();
    const timeline = within(dialog).getByRole("region", { name: "Run timeline" });
    fireEvent.click(within(timeline).getByRole("button", { name: /Seek to read: \/b\.ts/ }));
    const options = within(dialog).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    const exec = within(dialog).getByRole("region", { name: "Execution" });
    // Seeking into a folded group opens it and the step inspector.
    expect(within(exec).getByTestId("step-inspector")).toHaveTextContent("B body");
    expect(scroll).toHaveBeenCalled();
    // Model segments seek to the first step of their turn.
    fireEvent.click(within(timeline).getAllByRole("button", { name: /Seek to Model request/ })[0]!);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });

  it("copies the full transcript", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const { dialog } = renderModal();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy transcript" }));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0] as string;
    expect(text).toContain("[user] Fix the failing test");
    expect(text).toContain("[tool bash · error");
    expect(toastMock.success).toHaveBeenCalledWith("Transcript copied");

    writeText.mockRejectedValueOnce(new Error("denied"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Copy transcript" }));
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
