import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useApi } from "./api";

const MANAGED_AGENTS_BETA = "managed-agents-2026-04-01";

describe("useApi Managed Agents negotiation", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.stubGlobal("fetch", originalFetch);
    vi.restoreAllMocks();
  });

  it("sends the Managed Agents beta on JSON API requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ data: [] }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    await act(async () => {
      await result.current.api("/v1/agents");
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      MANAGED_AGENTS_BETA,
    );
  });

  it("sends the Managed Agents beta on session event streams", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          type: "error",
          error: { type: "not_found_error", message: "session not found" },
        },
        { status: 404 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useApi());

    act(() => {
      result.current.streamEvents("session_test", () => {});
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/v1/sessions/session_test/events/stream?event_deltas%5B%5D=agent.message&event_deltas%5B%5D=agent.thinking",
    );
    expect(new Headers(init?.headers).get("anthropic-beta")).toBe(
      MANAGED_AGENTS_BETA,
    );
  });
});
