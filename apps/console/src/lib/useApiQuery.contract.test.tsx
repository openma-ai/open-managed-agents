import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.fn();

vi.mock("./api", () => ({
  useApi: () => ({ api }),
}));

import {
  useFilesInfiniteApiQuery,
  useInfiniteApiQuery,
  useOmaInfiniteApiQuery,
} from "./useApiQuery";

function createWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

describe("Managed Agents list contract", () => {
  beforeEach(() => {
    api.mockReset();
  });

  it("uses the SDK page/next_page cursor shape by default", async () => {
    api
      .mockResolvedValueOnce({
        data: [{ id: "agent_1" }],
        next_page: "page_2",
      })
      .mockResolvedValueOnce({
        data: [{ id: "agent_2" }],
        next_page: null,
      });

    const { result } = renderHook(
      () => useInfiniteApiQuery<{ id: string }>("/v1/agents", { limit: 20 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: "agent_1" }]));
    expect(result.current.hasMore).toBe(true);

    act(() => result.current.loadMore());

    await waitFor(() =>
      expect(result.current.items).toEqual([
        { id: "agent_1" },
        { id: "agent_2" },
      ]),
    );
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/v1/agents?limit=20&page=page_2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("keeps the official Files before_id/last_id feed contract isolated", async () => {
    api
      .mockResolvedValueOnce({
        data: [{ id: "file_1" }],
        has_more: true,
        first_id: "file_1",
        last_id: "file_1",
      })
      .mockResolvedValueOnce({
        data: [{ id: "file_2" }],
        has_more: false,
        first_id: "file_2",
        last_id: "file_2",
      });

    const { result } = renderHook(
      () => useFilesInfiniteApiQuery<{ id: string }>("/v1/files", { limit: 20 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: "file_1" }]));
    act(() => result.current.loadMore());

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/v1/files?limit=20&before_id=file_1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("adapts product cursor/next_cursor transport without changing the feed UI", async () => {
    api
      .mockResolvedValueOnce({ data: [{ id: "card_1" }], next_cursor: "cursor_2" })
      .mockResolvedValueOnce({ data: [{ id: "card_2" }] });

    const { result } = renderHook(
      () => useOmaInfiniteApiQuery<{ id: string }>("/v1/oma/model_cards", { limit: 20 }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.items).toEqual([{ id: "card_1" }]));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/v1/oma/model_cards?limit=20&cursor=cursor_2",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
