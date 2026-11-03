import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverflowText } from "./overflow-text";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function geometry() {
  const size = { text: 100, viewport: 120 };
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => size.viewport);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(() => size.text);
  return size;
}

describe("OverflowText measurement lifecycle", () => {
  it("remeasures when loaded fonts change text width and removes font listeners on unmount", async () => {
    const size = geometry();
    const fonts = new EventTarget();
    let ready!: () => void;
    Object.assign(fonts, { ready: new Promise<void>((resolve) => { ready = resolve; }) });
    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", { configurable: true, value: fonts });
    const remove = vi.spyOn(fonts, "removeEventListener");
    try {
      const view = render(<OverflowText>Font dependent label</OverflowText>);
      const viewport = screen.getByTitle("Font dependent label");
      expect(viewport).toHaveAttribute("data-overflow", "false");
      size.text = 200;
      await act(async () => { ready(); });
      expect(viewport).toHaveAttribute("data-overflow", "true");
      expect(viewport).toHaveAttribute("tabindex", "0");
      size.text = 110;
      act(() => { fonts.dispatchEvent(new Event("loadingdone")); });
      expect(viewport).toHaveAttribute("data-overflow", "false");
      expect(viewport).not.toHaveAttribute("tabindex");
      view.unmount();
      expect(remove).toHaveBeenCalledWith("loadingdone", expect.any(Function));
    } finally {
      if (original) Object.defineProperty(document, "fonts", original);
      else Reflect.deleteProperty(document, "fonts");
    }
  });

  it("remeasures changed content, tolerates one-pixel rounding, and falls back to window resize without ResizeObserver", () => {
    const size = geometry();
    vi.stubGlobal("ResizeObserver", undefined);
    const view = render(<OverflowText>Short</OverflowText>);
    expect(screen.getByTitle("Short")).not.toHaveAttribute("tabindex");
    size.text = 280;
    view.rerender(<OverflowText>Updated longer text</OverflowText>);
    const viewport = screen.getByTitle("Updated longer text");
    expect(viewport).toHaveAttribute("tabindex", "0");
    expect(viewport.style.getPropertyValue("--overflow-text-travel")).toBe("-160px");
    size.viewport = 279;
    fireEvent(window, new Event("resize"));
    expect(viewport).toHaveAttribute("data-overflow", "false");
    expect(viewport).not.toHaveAttribute("tabindex");
  });

  it("preserves the completed trailing edge when resize reports unchanged geometry, and restarts changed geometry", () => {
    const size = geometry();
    size.text = 280;
    render(<OverflowText>Resize after completion</OverflowText>);
    const viewport = screen.getByTitle("Resize after completion");
    act(() => viewport.focus());
    const finishedText = viewport.firstElementChild!;
    fireEvent(finishedText, new Event("webkitAnimationEnd", { bubbles: true }));
    fireEvent(window, new Event("resize"));
    expect(viewport).toHaveAttribute("data-at-end", "true");
    expect(viewport.firstElementChild).toBe(finishedText);
    size.viewport = 160;
    fireEvent(window, new Event("resize"));
    expect(viewport).toHaveAttribute("data-at-end", "false");
    expect(viewport.firstElementChild).not.toBe(finishedText);
    expect(viewport).toHaveFocus();
  });

  it("keeps the readable trailing edge when mouse leaves but keyboard focus still owns playback", () => {
    const size = geometry();
    size.text = 280;
    render(<OverflowText>Focused overflow</OverflowText>);
    const viewport = screen.getByTitle("Focused overflow");
    act(() => viewport.focus());
    const text = viewport.firstElementChild!;
    fireEvent(text, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(viewport).toHaveAttribute("data-at-end", "true");
    fireEvent.mouseLeave(viewport);
    expect(viewport).toHaveAttribute("data-at-end", "true");
    act(() => viewport.blur());
    expect(viewport).toHaveAttribute("data-at-end", "false");
  });

  it("clears the end fade on mouse leave or keyboard blur so another interaction starts at the leading edge", () => {
    const size = geometry();
    size.text = 280;
    render(<OverflowText>Overflow</OverflowText>);
    const viewport = screen.getByTitle("Overflow");
    const text = screen.getByText("Overflow", { selector: ".console-overflow-text > span" });
    // React's JSDOM feature detection uses the prefixed animation-end event.
    fireEvent(text, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(viewport).toHaveAttribute("data-at-end", "true");
    fireEvent.mouseLeave(viewport);
    expect(viewport).toHaveAttribute("data-at-end", "false");
    // React's JSDOM feature detection uses the prefixed animation-end event.
    fireEvent(text, new Event("webkitAnimationEnd", { bubbles: true }));
    fireEvent.blur(viewport);
    expect(viewport).toHaveAttribute("data-at-end", "false");
  });
});
