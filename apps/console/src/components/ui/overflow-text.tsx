import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/** Plain text only: clip/fade at rest and reveal overflow within its own viewport on intent. */
export function OverflowText({ children }: { children: string | number }) {
  const value = String(children);
  const viewportRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [geometry, setGeometry] = useState({ viewport: 0, text: 0 });
  const [completed, setCompleted] = useState<string | null>(null);
  const overflow = geometry.text - geometry.viewport;
  const distance = overflow > 1 ? overflow : 0;
  // Remount only the moving text when geometry/content changes: current intent
  // starts a fresh animation, without moving keyboard focus off the viewport.
  const playbackKey = `${geometry.viewport}:${geometry.text}:${value}`;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const text = textRef.current;
    if (!viewport || !text) return;
    setCompleted(null);
    let mounted = true;
    const measure = () => {
      if (!mounted) return;
      const next = { viewport: viewport.clientWidth, text: text.scrollWidth };
      if (geometry.viewport !== next.viewport || geometry.text !== next.text) {
        setGeometry(next);
        setCompleted(null);
      }
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(viewport);
    observer?.observe(text);
    window.addEventListener("resize", measure);
    const fonts = document.fonts;
    void fonts?.ready.then(measure);
    fonts?.addEventListener("loadingdone", measure);
    measure();
    return () => {
      mounted = false;
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      fonts?.removeEventListener("loadingdone", measure);
    };
  }, [playbackKey]);

  return (
    <span
      ref={viewportRef}
      className="console-overflow-text"
      title={value}
      tabIndex={distance > 0 ? 0 : undefined}
      data-overflow={distance > 0}
      data-at-end={completed === playbackKey}
      style={{
        "--overflow-text-travel": `${-distance}px`,
        "--overflow-text-duration": `${distance / 40}s`,
      } as CSSProperties}
      onMouseLeave={(event) => {
        if (document.activeElement !== event.currentTarget) setCompleted(null);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.matches(":hover")) setCompleted(null);
      }}
    >
      <span key={playbackKey} ref={textRef} onAnimationEnd={() => setCompleted(playbackKey)}>{value}</span>
    </span>
  );
}
