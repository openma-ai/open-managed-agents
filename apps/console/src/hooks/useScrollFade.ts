import { useCallback, useRef, useState } from "react";

/**
 * Edge fade for clipped scroll containers — the console-wide rule is that
 * any capped, scrollable list fades into its surface at the edge(s) that
 * actually hide content, and nowhere else.
 *
 * Usage:
 *   const fade = useScrollFade<HTMLDivElement>();
 *   <div ref={fade.ref} className={cn("console-scroll-fade", fade.className, "overflow-y-auto …")}>
 *
 * `className` toggles `is-fade-top` / `is-fade-bottom`; the mask itself
 * lives in `.console-scroll-fade` (console-shell.css) and its size comes
 * from `--scroll-fade-size` (console-tokens.css). Re-measures on scroll,
 * on container/child resize, and when children are added or removed.
 */
export function useScrollFade<T extends HTMLElement = HTMLDivElement>() {
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  const cleanup = useRef<(() => void) | null>(null);

  const ref = useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el) return;
    const update = () => {
      // 1px tolerance absorbs sub-pixel rounding at the scroll ends.
      setFadeTop(el.scrollTop > 1);
      setFadeBottom(el.scrollHeight - el.clientHeight - el.scrollTop > 1);
    };
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    const observeChildren = () => {
      if (!ro) return;
      ro.disconnect();
      ro.observe(el);
      for (const child of Array.from(el.children)) ro.observe(child);
    };
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            observeChildren();
            update();
          });
    observeChildren();
    mo?.observe(el, { childList: true });
    el.addEventListener("scroll", update, { passive: true });
    update();
    cleanup.current = () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);

  const className = `${fadeTop ? "is-fade-top" : ""}${fadeTop && fadeBottom ? " " : ""}${fadeBottom ? "is-fade-bottom" : ""}`;
  return { ref, fadeTop, fadeBottom, className };
}
