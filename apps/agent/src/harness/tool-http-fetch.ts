/** Timed outbound HTTP for harness tools (e.g. web_search). No redirect policy. */

export function mergeAbortSignals(
  signals: (AbortSignal | null | undefined)[],
): AbortSignal | undefined {
  const active = signals.filter((s): s is AbortSignal => s != null);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const sig of active) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export interface TimedHttpFetchOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  options: TimedHttpFetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = mergeAbortSignals([init.signal, options.abortSignal, timeoutSignal]);
  const url = typeof input === "string" ? input : input.toString();
  return fetch(url, { ...init, signal });
}

export function httpFetchErrorMessage(err: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return `Request timed out after ${timeoutMs}ms`;
    }
    return err.message;
  }
  return String(err);
}

export async function fetchWebSearchGet(
  target: string,
  abortSignal?: AbortSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetchWithTimeout(target, {}, { abortSignal, timeoutMs });
  } catch (err) {
    throw new Error(httpFetchErrorMessage(err, timeoutMs));
  }
}

export const WEB_SEARCH_DDG_TIMEOUT_MS = 20_000;
export const WEB_SEARCH_TAVILY_TIMEOUT_MS = 30_000;

export async function postTavilySearch(
  body: string,
  abortSignal?: AbortSignal,
): Promise<Response> {
  const timeoutMs = WEB_SEARCH_TAVILY_TIMEOUT_MS;
  try {
    return await fetchWithTimeout(
      "https://api.tavily.com/search",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      { abortSignal, timeoutMs },
    );
  } catch (err) {
    throw new Error(httpFetchErrorMessage(err, timeoutMs));
  }
}
