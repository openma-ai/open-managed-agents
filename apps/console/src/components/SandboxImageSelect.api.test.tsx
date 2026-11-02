import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import { server } from "../mocks/server";
import { DEFAULT_SANDBOX_IMAGE, SandboxImageSelect, useSandboxImages } from "./SandboxImageSelect";

// Exercises the real useApi + useApiQuery stack against MSW, so the error
// branch of the catalog probe actually runs.
function Probe() {
  const images = useSandboxImages();
  return (
    <div>
      <span data-testid="count">{images.length}</span>
      <SandboxImageSelect images={images} value={DEFAULT_SANDBOX_IMAGE} onValueChange={() => {}} />
    </div>
  );
}

function renderProbe() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 1, retryDelay: 0 } } });
  return render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
}

afterEach(() => vi.restoreAllMocks());

describe("useSandboxImages against the real API client", () => {
  it("treats a missing endpoint (404) as an empty catalog without a toast or retry", async () => {
    let calls = 0;
    server.use(http.get("/v1/oma/sandbox_images", () => {
      calls += 1;
      return HttpResponse.json({ type: "error", error: { type: "not_found_error", message: "Not Found" } }, { status: 404 });
    }));
    const toastError = vi.spyOn(toast, "error");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderProbe();
    await waitFor(() => expect(calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(1);
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    expect(screen.queryByText("Default image")).toBeNull();
    expect(toastError).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("still surfaces a server failure on the same endpoint", async () => {
    server.use(http.get("/v1/oma/sandbox_images", () => HttpResponse.json({}, { status: 500 })));
    const toastError = vi.spyOn(toast, "error");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderProbe();
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(
      "Server error. Please try again.",
      expect.anything(),
    ));
    expect(screen.getByTestId("count")).toHaveTextContent("0");
  });

  it("shows the selector once the catalog has entries", async () => {
    server.use(http.get("/v1/oma/sandbox_images", () => HttpResponse.json({
      data: [{ type: "sandbox_image", alias: "analytics", label: "Analytics", description: null }],
    })));
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("1"));
  });
});
