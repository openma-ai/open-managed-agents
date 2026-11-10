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

describe("SessionDetail Trajectory button", () => {
  it("opens the modal, fetches the envelope once, and lights up the outcome chip", async () => {
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
    mount("session_ok");

    const trigger = await screen.findByRole("button", { name: "Trajectory" });
    expect(trigger).toBeEnabled();
    expect(trigger.getAttribute("title")).toMatch(/turns, tool steps, timeline/);
    expect(apiMock.mock.calls.some(([p]) => String(p).endsWith("/trajectory"))).toBe(false);

    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Trajectory" });
    await within(dialog).findByText("trj_wired · session session_ok");
    expect(apiMock).toHaveBeenCalledWith("/v1/oma/sessions/session_ok/trajectory");
    expect(within(dialog).getByRole("button", { name: "Download JSON" })).toBeEnabled();
    expect(screen.getAllByText("Outcome: success").length).toBeGreaterThan(0);

    fireEvent.click(within(dialog).getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Trajectory" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Trajectory" }));
    await screen.findByRole("dialog", { name: "Trajectory" });
    const trajectoryCalls = apiMock.mock.calls.filter(([p]) => String(p).endsWith("/trajectory"));
    expect(trajectoryCalls).toHaveLength(1);
  });
});
