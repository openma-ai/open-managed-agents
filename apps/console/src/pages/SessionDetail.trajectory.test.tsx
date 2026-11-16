import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { ...actual.toast, error: toastError }) };
});

const apiMock = vi.hoisted(() => vi.fn(async (_path: string): Promise<unknown> => ({ data: [] })));

const managedApi = vi.hoisted(() => ({
  sessions: {
    retrieve: vi.fn(),
    events: { list: vi.fn(), stream: vi.fn() },
    threads: { list: vi.fn() },
  },
  agents: { retrieve: vi.fn(async () => ({ metadata: {} })) },
  environments: { retrieve: vi.fn(async () => ({ id: "env_1", name: "Env" })) },
  vaults: { retrieve: vi.fn(async (id: string) => ({ id, display_name: id })) },
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managedApi }));

vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  const api = apiMock;
  const apiRaw = vi.fn(async () => new Response("{}", { status: 200 }));
  const apiStream = vi.fn();
  return { ...actual, useApi: () => ({ api, apiRaw, apiStream }) };
});

import { SessionDetail } from "./SessionDetail";
import { I18nProvider } from "../i18n";

function mount(id: string) {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[`/sessions/${id}`]}>
        <Routes><Route path="/sessions/:id" element={<SessionDetail />} /></Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function never<T>() { return new Promise<T>(() => {}); }

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const envelope = {
  schema_version: "oma.trajectory.v1",
  trajectory_id: "trj_wired",
  session_id: "session_ok",
  agent_config: {},
  environment_config: {},
  model: { id: "claude-sonnet-4-6", provider: "anthropic" },
  started_at: "2026-10-31T00:00:00Z",
  outcome: "success",
  events: [{ seq: 1, type: "agent.message", data: JSON.stringify({ type: "agent.message", content: [{ type: "text", text: "Done." }] }), ts: "2026-10-31T00:00:01Z" }],
  summary: {
    num_events: 1, num_turns: 1, num_tool_calls: 0, num_tool_errors: 0, num_threads: 1, duration_ms: 1000,
    token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
  },
};

describe("SessionDetail Trace tab", () => {
  function setup() {
    managedApi.sessions.retrieve.mockResolvedValue({
      id: "session_ok", status: "idle", agent: { id: "agent_1", metadata: {} },
      created_at: "2026-10-31T00:00:00Z", metadata: {},
    });
    managedApi.sessions.events.list.mockResolvedValue({ data: [], next_page: null });
    managedApi.sessions.events.stream.mockReturnValue(never());
    managedApi.sessions.threads.list.mockResolvedValue({ data: [] });
    apiMock.mockImplementation(async (path: string) =>
      path.endsWith("/trajectory") ? envelope : { data: [] },
    );
  }
  const trajectoryCalls = () => apiMock.mock.calls.filter(([p]) => String(p).endsWith("/trajectory"));

  it("is the single execution viewer: no separate Timeline tab or Trajectory modal", async () => {
    setup();
    mount("session_ok");
    const tabs = await screen.findByRole("tablist", { name: "Session view" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Conversation", "Trace"]);
    expect(screen.queryByRole("button", { name: "Trajectory" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Nothing is fetched until the Trace tab is opened.
    expect(trajectoryCalls()).toHaveLength(0);
  });

  it("fetches the envelope on demand once, renders Trace, and lights up the outcome chip", async () => {
    setup();
    mount("session_ok");
    fireEvent.click(await screen.findByRole("tab", { name: "Trace" }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith("/v1/oma/sessions/session_ok/trajectory"));
    // No live events → the envelope's events drive the tree.
    const tree = await screen.findByRole("tree", { name: "Trace tree" });
    expect(within(tree).getByRole("treeitem", { name: /agent\.message.*Done\./ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download JSON" })).toBeEnabled();
    expect(screen.getAllByText("Outcome: success").length).toBeGreaterThan(0);
    expect(within(screen.getByRole("complementary", { name: "Event details" })).getByText("Select an event to view details")).toBeInTheDocument();

    // Leaving and re-entering Trace doesn't refetch a finished run.
    fireEvent.click(screen.getByRole("tab", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    await screen.findByRole("tree", { name: "Trace tree" });
    expect(trajectoryCalls()).toHaveLength(1);
  });

  it("retries after an envelope error", async () => {
    setup();
    let fail = true;
    apiMock.mockImplementation(async (path: string) => {
      if (!path.endsWith("/trajectory")) return { data: [] };
      if (fail) throw new Error("boom");
      return envelope;
    });
    mount("session_ok");
    fireEvent.click(await screen.findByRole("tab", { name: "Trace" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Trajectory unavailable/);
    fail = false;
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Download JSON" })).toBeEnabled());
    expect(trajectoryCalls()).toHaveLength(2);
  });
});
