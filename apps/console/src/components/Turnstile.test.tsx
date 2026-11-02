import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Turnstile } from "./Turnstile";

afterEach(() => { delete window.turnstile; });

describe("Turnstile lifecycle", () => {
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
});
