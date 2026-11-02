import { act, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useScrollFade } from "./useScrollFade";

function List() {
  const fade = useScrollFade<HTMLDivElement>();
  return <div data-testid="list" ref={fade.ref} className={`console-scroll-fade ${fade.className}`} />;
}

function setMetrics(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: Record<string, number>) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
  el.scrollTop = scrollTop;
}

describe("useScrollFade", () => {
  it("fades only the edges that clip content", () => {
    const { getByTestId } = render(<List />);
    const el = getByTestId("list");
    expect(el.className).not.toMatch(/is-fade/);

    setMetrics(el, { scrollTop: 0, scrollHeight: 400, clientHeight: 200 });
    act(() => { el.dispatchEvent(new Event("scroll")); });
    expect(el.className).toMatch(/is-fade-bottom/);
    expect(el.className).not.toMatch(/is-fade-top/);

    setMetrics(el, { scrollTop: 100, scrollHeight: 400, clientHeight: 200 });
    act(() => { el.dispatchEvent(new Event("scroll")); });
    expect(el.className).toMatch(/is-fade-top/);
    expect(el.className).toMatch(/is-fade-bottom/);

    setMetrics(el, { scrollTop: 200, scrollHeight: 400, clientHeight: 200 });
    act(() => { el.dispatchEvent(new Event("scroll")); });
    expect(el.className).toMatch(/is-fade-top/);
    expect(el.className).not.toMatch(/is-fade-bottom/);
  });
});
