import { useEffect, useRef, useState } from "react";

// Cloudflare Turnstile widget — vanilla CF JS, no dependency.
//
// Loads `https://challenges.cloudflare.com/turnstile/v0/api.js` on mount
// (idempotent — once per page) and renders a widget into the host div.
// Calls `onToken` when CF mints a token; `onExpire` when it expires
// (Turnstile tokens are single-use AND short-lived, ~5 min).
//
// Pass `siteKey={null}` to render a no-op placeholder — this happens when
// the backend hasn't been configured with a Turnstile site yet, in which
// case the auth middleware soft-passes too.

interface TurnstileProps {
  siteKey: string | null;
  onToken: (token: string) => void;
  onExpire?: () => void;
  onError?: (code: string) => void;
  /** Reset the existing official widget after consuming a single-use token. */
  resetKey?: number;
  /** Per CF: "interaction-only" shows the widget only when CF
   *  decides interaction is needed; "always" (default) keeps it visible; "execute"
   *  is for invisible widgets that the page calls programmatically. */
  appearance?: "interaction-only" | "always" | "execute";
}

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: (code: string) => void;
          "timeout-callback"?: () => void;
          "unsupported-callback"?: () => void;
          "before-interactive-callback"?: () => void;
          size?: "normal" | "compact";
          appearance?: "interaction-only" | "always" | "execute";
          theme?: "light" | "dark" | "auto";
        },
      ) => string;
      remove: (widgetId: string) => void;
      reset: (widgetId: string) => void;
    };
  }
}

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptLoaded: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (scriptLoaded) return scriptLoaded;
  scriptLoaded = new Promise<void>((resolve, reject) => {
    if (window.turnstile) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${SCRIPT_SRC}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("Turnstile script failed to load")), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Turnstile script failed to load"));
    document.head.appendChild(script);
  });
  return scriptLoaded.catch((error) => {
    scriptLoaded = null;
    document.querySelector(`script[src="${SCRIPT_SRC}"]`)?.remove();
    throw error;
  });
}

export function Turnstile({ siteKey, onToken, onExpire, onError, resetKey = 0, appearance = "always" }: TurnstileProps) {
  const ref = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState("loading");
  const [size, setSize] = useState<"normal" | "compact">("normal");
  const sizeRef = useRef(size);
  const previousReset = useRef(resetKey);
  const callbacks = useRef({ onToken, onExpire, onError });
  callbacks.current = { onToken, onExpire, onError };

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      const next = host.clientWidth > 0 && host.clientWidth < 300 ? "compact" : "normal";
      if (next !== sizeRef.current) {
        sizeRef.current = next;
        callbacks.current.onExpire?.();
        setSize(next);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [siteKey]);

  useEffect(() => {
    if (previousReset.current === resetKey) return;
    previousReset.current = resetKey;
    if (widgetId.current && window.turnstile) {
      setError("");
      setStatus("ready");
      window.turnstile.reset(widgetId.current);
    }
  }, [resetKey]);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    setStatus("loading");
    setError("");
    const invalidate = (code: string, message: string) => {
      if (cancelled) return;
      setStatus("error");
      setError(message);
      callbacks.current.onError?.(code);
    };
    loadTurnstileScript()
      .then(() => {
        if (cancelled || !window.turnstile || !ref.current) return;
        setStatus("ready");
        widgetId.current = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          callback: (token) => {
            if (cancelled) return;
            setError("");
            setStatus("success");
            callbacks.current.onToken(token);
          },
          "expired-callback": () => {
            if (cancelled) return;
            setStatus("expired");
            callbacks.current.onExpire?.();
          },
          "before-interactive-callback": () => {
            if (cancelled) return;
            callbacks.current.onExpire?.();
            setStatus("interactive");
          },
          "error-callback": (code) => invalidate(code, "Security verification failed. Please try again."),
          "timeout-callback": () => invalidate("timeout", "Security verification timed out. Please try again."),
          "unsupported-callback": () => invalidate("unsupported", "Security verification is not supported in this browser."),
          appearance,
          theme: "auto",
          size,
        });
      })
      .catch(() => invalidate("load", "Security verification could not load. Please refresh and try again."));
    return () => {
      cancelled = true;
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch {}
        widgetId.current = null;
        callbacks.current.onExpire?.();
      }
    };
  }, [siteKey, appearance, size]);

  if (!siteKey) return null;

  return (
    <div className="w-full min-w-0 space-y-1" data-turnstile-state={status}>
      <div ref={ref} className={`flex justify-center ${size === "compact" ? "min-h-[140px]" : "min-h-[65px]"}`} />
      {error && <div role="alert" className="text-xs text-danger">{error}</div>}
    </div>
  );
}
