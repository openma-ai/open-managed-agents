import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Turnstile } from "./Turnstile";

afterEach(() => { delete window.turnstile; });

describe("Turnstile lifecycle", () => {
  it.each([[360, "normal"], [272, "compact"]] as const)("uses the official unstretched size at %spx", async (width, size) => {
    const measure = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    const api = { render: vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1"), reset: vi.fn(), remove: vi.fn() };
    window.turnstile = api;
    try {
      render(<Turnstile siteKey="site-key" onToken={vi.fn()} />);
      await waitFor(() => expect(api.render).toHaveBeenCalled());
      expect(api.render.mock.calls.at(-1)![1].size).toBe(size);
    } finally {
      measure.mockRestore();
    }
  });

  it("keeps an in-progress challenge across parent renders and calls the latest handlers", async () => {
    const renderWidget = vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1");
    const remove = vi.fn();
    window.turnstile = { render: renderWidget, remove, reset: vi.fn() };
    const firstToken = vi.fn();
    const firstExpire = vi.fn();
    const { rerender, unmount } = render(
      <Turnstile siteKey="site-key" onToken={firstToken} onExpire={firstExpire} />,
    );
    await waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
    const options = renderWidget.mock.calls[0][1];
    const latestToken = vi.fn();
    const latestExpire = vi.fn();
    rerender(<Turnstile siteKey="site-key" onToken={latestToken} onExpire={latestExpire} />);
    await waitFor(() => expect(renderWidget).toHaveBeenCalledOnce());
    expect(remove).not.toHaveBeenCalled();
    options.callback("token");
    options["expired-callback"]?.();
    expect(latestToken).toHaveBeenCalledWith("token");
    expect(latestExpire).toHaveBeenCalledOnce();
    expect(firstToken).not.toHaveBeenCalled();
    expect(firstExpire).not.toHaveBeenCalled();
    unmount();
    expect(remove).toHaveBeenCalledExactlyOnceWith("widget-1");
  });

  it("resets through the official API without remounting", async () => {
    const api = { render: vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1"), reset: vi.fn(), remove: vi.fn() };
    window.turnstile = api;
    const onToken = vi.fn();
    const { rerender } = render(<Turnstile siteKey="site-key" onToken={onToken} resetKey={0} />);
    await waitFor(() => expect(api.render).toHaveBeenCalledOnce());
    rerender(<Turnstile siteKey="site-key" onToken={onToken} resetKey={1} />);
    expect(api.reset).toHaveBeenCalledExactlyOnceWith("widget-1");
    expect(api.render).toHaveBeenCalledOnce();
    expect(api.remove).not.toHaveBeenCalled();
  });

  it("clears failure feedback only when the official success callback recovers", async () => {
    const api = { render: vi.fn<NonNullable<Window["turnstile"]>["render"]>(() => "widget-1"), reset: vi.fn(), remove: vi.fn() };
    window.turnstile = api;
    const onToken = vi.fn(), onError = vi.fn();
    const { unmount } = render(<Turnstile siteKey="site-key" onToken={onToken} onError={onError} />);
    await waitFor(() => expect(api.render).toHaveBeenCalledOnce());
    const options = api.render.mock.calls[0][1];
    act(() => options["error-callback"]?.("300030"));
    expect(screen.getByRole("alert")).toHaveTextContent("Security verification failed");
    expect(onError).toHaveBeenCalledWith("300030");
    act(() => options.callback("fresh-token"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onToken).toHaveBeenCalledExactlyOnceWith("fresh-token");
    unmount();
    act(() => options.callback("stale-token"));
    expect(onToken).toHaveBeenCalledTimes(1);
  });
});
