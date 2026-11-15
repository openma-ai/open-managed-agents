import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { ApiError, shouldSilenceApiErrorToast } from "../lib/api";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", async (orig) => {
  const actual = await orig<typeof import("sonner")>();
  return { ...actual, toast: Object.assign(vi.fn(), { ...actual.toast, error: toastError }) };
});

const managedApi = vi.hoisted(() => ({
  sessions: {
    retrieve: vi.fn(),
    events: { list: vi.fn(), stream: vi.fn(), send: vi.fn() },
    threads: { list: vi.fn() },
  },
  agents: { retrieve: vi.fn(async () => ({ metadata: {} })) },
  environments: { retrieve: vi.fn(async () => ({ id: "env_1", name: "Env" })) },
  vaults: { retrieve: vi.fn(async (id: string) => ({ id, display_name: id })) },
}));
vi.mock("../lib/useManagedApi", () => ({ useManagedApi: () => managedApi }));

vi.mock("../lib/api", async (orig) => {
  const actual = await orig<typeof import("../lib/api")>();
  const api = vi.fn(async () => ({ data: [] }));
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
function openedStream() {
  return { [Symbol.asyncIterator]: () => ({ next: () => never<IteratorResult<never>>() }) };
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe("SessionDetail gates history/stream/threads on the session lookup", () => {
  it("404: renders only the not-found view; no events/threads fetch, no toasts", async () => {
    managedApi.sessions.retrieve.mockRejectedValue(
      new ApiError({ status: 404, code: "not_found_error", message: "Session sesn_x was not found" }),
    );
    mount("sesn_x");
    await screen.findByTestId("session-not-found");
    await new Promise((r) => setTimeout(r, 20));
    expect(managedApi.sessions.events.list).not.toHaveBeenCalled();
    expect(managedApi.sessions.events.stream).not.toHaveBeenCalled();
    expect(managedApi.sessions.threads.list).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
    expect(screen.queryByText(/Send a message to start/)).toBeNull();
  });

  it("valid id: starts history, stream and threads once the session resolves", async () => {
    managedApi.sessions.retrieve.mockResolvedValue({
      id: "session_ok", status: "idle", agent: { id: "agent_1", metadata: {} },
      created_at: "2026-10-31T00:00:00Z", metadata: {},
    });
    managedApi.sessions.events.list.mockResolvedValue({ data: [], next_page: null });
    managedApi.sessions.events.stream.mockResolvedValue(openedStream());
    managedApi.sessions.threads.list.mockResolvedValue({ data: [] });
    let open!: (stream: ReturnType<typeof openedStream>) => void;
    managedApi.sessions.events.stream.mockReturnValue(new Promise(resolve => { open = resolve; }));
    mount("session_ok");
    await waitFor(() => expect(managedApi.sessions.events.stream).toHaveBeenCalledTimes(1));
    expect(managedApi.sessions.events.list).not.toHaveBeenCalled();
    open(openedStream());
    await waitFor(() => expect(managedApi.sessions.events.list).toHaveBeenCalledTimes(1));
    expect(managedApi.sessions.events.stream).toHaveBeenCalledTimes(1);
    expect(managedApi.sessions.threads.list).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("session-not-found")).toBeNull();
  });

  it.each([500, 403])("%i on lookup keeps existing behavior: still loads history/stream/threads", async (status) => {
    managedApi.sessions.retrieve.mockRejectedValue(new ApiError({ status, code: "api_error", message: "boom" }));
    managedApi.sessions.events.list.mockResolvedValue({ data: [], next_page: null });
    managedApi.sessions.events.stream.mockResolvedValue(openedStream());
    managedApi.sessions.threads.list.mockResolvedValue({ data: [] });
    mount("session_err");
    await waitFor(() => expect(managedApi.sessions.events.list).toHaveBeenCalled());
    expect(managedApi.sessions.events.stream).toHaveBeenCalled();
    expect(managedApi.sessions.threads.list).toHaveBeenCalled();
    expect(screen.queryByTestId("session-not-found")).toBeNull();
  });

  it("submits a canonical streamed custom call while the Session remains running", async () => {
    managedApi.sessions.retrieve.mockResolvedValue({
      id: "session_live", status: "running", agent: { id: "agent_1", metadata: {} },
      created_at: "2026-11-12T00:00:00Z", metadata: {},
    });
    managedApi.sessions.events.list.mockResolvedValue({ data: [], next_page: null });
    managedApi.sessions.threads.list.mockResolvedValue({ data: [] });
    managedApi.sessions.events.stream.mockResolvedValue({ async *[Symbol.asyncIterator]() {
      yield { type: "agent.custom_tool_use", id: "live-call", name: "approve", input: { ticket: 1 }, processed_at: "2026-11-12T00:00:01Z" };
      await never();
    } });
    managedApi.sessions.events.send.mockResolvedValue({ data: [{
      id: "receipt", type: "user.custom_tool_result", custom_tool_use_id: "live-call",
      content: [{ type: "text", text: "approved" }], processed_at: "2026-11-12T00:00:02Z",
    }] });
    // jsdom does not implement the browser resize API used by the transcript.
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    mount("session_live");
    fireEvent.change(await screen.findByLabelText("Result for approve"), { target: { value: "approved" } });
    fireEvent.click(screen.getByText("Submit result"));
    await waitFor(() => expect(managedApi.sessions.events.send).toHaveBeenCalledWith("session_live", {
      events: [{ type: "user.custom_tool_result", custom_tool_use_id: "live-call", content: [{ type: "text", text: "approved" }] }],
    }));
    await waitFor(() => expect(screen.queryByText("Submit result")).toBeNull());
  });

  it("silences the toast only for a 404 on GET /v1/sessions/:id", () => {
    expect(shouldSilenceApiErrorToast("/v1/sessions/sesn_x", 404)).toBe(true);
    expect(shouldSilenceApiErrorToast("/v1/sessions/sesn_x", 500)).toBe(false);
    expect(shouldSilenceApiErrorToast("/v1/sessions/sesn_x", 403)).toBe(false);
    expect(shouldSilenceApiErrorToast("/v1/sessions/sesn_x/events?limit=100", 404)).toBe(false);
    expect(shouldSilenceApiErrorToast("/v1/sessions/sesn_x/threads?limit=100", 404)).toBe(false);
  });
});
