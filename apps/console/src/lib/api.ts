const BASE = "";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { FatalSseError, streamSse } from "./sse";

/**
 * Server error envelope after the Anthropic-compatible migration:
 *   { type: "error", error: { type, message }, request_id? }
 * Older endpoints still emit the bare-string shape `{ error: "<string>" }`,
 * which we read defensively in `readApiError`.
 */
interface ApiErrorBody {
  type?: "error";
  error?:
    | string
    | {
        type?: string;
        message?: string;
      };
  request_id?: string;
}

export interface ApiErrorInfo {
  /** Stable error code from the server, e.g. `"not_a_member"`. Empty
   *  string when the response only carried a message. */
  code: string;
  /** Human-readable message, suitable for toasts. Falls back to
   *  `HTTP <status>` when the body had nothing usable. */
  message: string;
}

/** Parse `{code, message}` out of an API response body. Handles both the
 *  current Anthropic-style envelope and the legacy bare-string shape so
 *  callers can dispatch on `code` (stable wire-format identifier) without
 *  ever string-matching the human message. */
export function readApiError(body: unknown, status: number): ApiErrorInfo {
  if (body && typeof body === "object") {
    const e = (body as ApiErrorBody).error;
    if (typeof e === "string") return { code: "", message: e };
    if (e && typeof e === "object") {
      return {
        code: typeof e.type === "string" ? e.type : "",
        message: typeof e.message === "string" ? e.message : `HTTP ${status}`,
      };
    }
  }
  return { code: "", message: `HTTP ${status}` };
}

/** Back-compat wrapper for the older message-only callers (readApiErrorMessage
 *  was the single export before the `code` channel existed). New code should
 *  reach for `readApiError` and use `code` for dispatch. */
export function readApiErrorMessage(body: unknown, status: number): string {
  return readApiError(body, status).message;
}

/**
 * Structured API error. Replaces the previous `Error & { status?: number }`
 * property-extension trick — callers branch on `err instanceof ApiError`
 * and then read `status` / `code` rather than poking at an Error object's
 * tacked-on properties (which break under structuredClone, Error
 * subclassing, and most error-reporting libraries).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(info: ApiErrorInfo & { status: number; requestId?: string }) {
    super(info.message);
    this.name = "ApiError";
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
  }
}

/** localStorage key for the active tenant the Console wants to operate as.
 *  Sent on every /v1/* request as `x-active-tenant`; the backend validates
 *  membership before honoring. Single-tenant users never write this. */
export const ACTIVE_TENANT_KEY = "oma_active_tenant_id";

export function getActiveTenantId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_TENANT_KEY, id);
    else localStorage.removeItem(ACTIVE_TENANT_KEY);
  } catch {
    // localStorage may be disabled (private mode, embedded webview);
    // the user just won't get the multi-tenant switcher.
  }
}

/** Endpoints whose 401/403 are part of normal app flow and should NOT
 *  surface as a toast. /auth-info is checked on every page load to decide
 *  whether to show the login screen — a 401 means "not logged in", which
 *  the login screen already communicates. /v1/me 401 is handled the same
 *  way by the sidebar bootstrapping path. */
const SILENT_AUTH_PATHS = ["/auth-info", "/v1/me"];

function shouldSilenceAuthError(path: string, status: number): boolean {
  if (status !== 401 && status !== 403) return false;
  return SILENT_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
}

export function useApi() {
  // `api` and `streamEvents` are wrapped in useCallback with an empty dep
  // list so a render of any consumer doesn't produce a fresh closure.
  // Before this, every component calling `useApi()` got new function identities
  // each render — including them in a `useEffect` dep array would loop the
  // effect, so callers had to either omit `api` (eslint-disable) or stash it
  // in a ref. With these stable refs, `useApiQuery` / `useInfiniteApiQuery` /
  // `useEffect([id])` can include `api` cleanly without retriggering.
  // `toast` is imported from sonner at module scope; the module-level
  // function reference is stable across renders.
  const api = useCallback(
    async function api<T = unknown>(
      path: string,
      init?: RequestInit
    ): Promise<T> {
      const activeTenant = getActiveTenantId();
      // Don't auto-set JSON content-type for FormData — the browser must add
      // multipart boundaries itself, and a manually set content-type without
      // the boundary breaks parsing on the server.
      const isFormData = init?.body instanceof FormData;
      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, {
          ...init,
          credentials: "include",
          headers: {
            ...(init?.body && !isFormData ? { "content-type": "application/json" } : {}),
            // Pin the workspace for this request. Backend validates membership;
            // a stale value (deleted tenant, removed membership) yields 403 and
            // the sidebar's catch-and-retry path clears + reloads.
            ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
            ...init?.headers,
          },
        });
      } catch (err) {
        // Network-level failure (DNS, CORS, offline, request aborted by route
        // change). Show a single toast — the caller's catch likely just renders
        // an empty state otherwise.
        const msg = err instanceof Error ? err.message : "network error";
        // Don't toast aborted requests (component unmount is a normal flow).
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          // User-facing toast: skip the METHOD path: prefix (debug noise);
          // log the full thing to console for dev triage.
          console.error(`[api] ${(init?.method || "GET")} ${path}: ${msg}`);
          toast.error(`Network error: ${msg}`);
        }
        throw err;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const info = readApiError(body, res.status);
        const requestId = (body as { request_id?: unknown })?.request_id;

        // Safety net for stale-tenant lockout. The primary fix is in Login.tsx
        // (clears localStorage on every successful auth transition). This still
        // catches edge cases the login fix can't:
        //   - User opens 2 tabs, signs out + signs in as a different user in
        //     tab A; tab B still has the old user's tenant pin in localStorage
        //   - A tenant the user belonged to gets revoked while they're already
        //     logged in
        //   - Cross-domain edge cases where localStorage carries over via
        //     extension / shared profile sync
        // Dispatch on the stable wire-format code (`not_a_member`) rather
        // than the human message — the backend emits this from auth.ts /
        // http-routes/tenants/index.ts / apps/main/src/auth.ts via the
        // Anthropic-style envelope. Reload-loop guard prevents bouncing if
        // 403 is from some unrelated membership check.
        if (
          res.status === 403 &&
          activeTenant &&
          info.code === "not_a_member" &&
          !sessionStorage.getItem("oma_tenant_self_heal")
        ) {
          sessionStorage.setItem("oma_tenant_self_heal", "1");
          setActiveTenantId(null);
          toast.info("Reset stored workspace pin (was unrecognized) — reloading");
          // Give the toast a tick to render before navigation.
          setTimeout(() => location.reload(), 250);
          throw new ApiError({ ...info, status: res.status });
        }

        // Surface non-OK responses to the user. Silently dropped errors had us
        // chasing "why don't I see anything" issues for far too long; almost
        // every endpoint failure here is something the user could act on
        // (re-login, switch tenant, retry) once they know it happened.
        //
        // Toast format: server message verbatim. The previous shape prefixed
        // the API path (e.g. "/v1/sessions: Insufficient balance.") which
        // leaked debug info into UX. Path + status still go to console for
        // dev triage.
        if (!shouldSilenceAuthError(path, res.status)) {
          console.error(`[api] ${res.status} ${path}: ${info.message}`);
          toast.error(info.message);
        }
        throw new ApiError({
          ...info,
          status: res.status,
          requestId: typeof requestId === "string" ? requestId : undefined,
        });
      }
      // Successful response — clear the self-heal sentinel so a future stale
      // tenant can self-heal again later in the same browser session.
      sessionStorage.removeItem("oma_tenant_self_heal");
      return res.json() as Promise<T>;
    },
    [],
  );

  const streamEvents = useCallback(
    (
      sessionId: string,
      onEvent: (event: Record<string, unknown>) => void,
      signal?: AbortSignal,
    ) => {
      const activeTenant = getActiveTenantId();
      // SSE endpoint goes through the same auth middleware so it needs the
      // header too. The native fetch we use under the hood lets us set it;
      // EventSource wouldn't.
      //
      // Console opts into both `chunks` (token-by-token rendering, pending
      // queue events, session.warning, extra spans) and `replay=1` (full
      // history on connect — Console renders the persistent timeline view
      // and the dedup keyset at SessionDetail.tsx:108-121 already handles
      // any seq-overlap from concurrent live broadcasts; replay-on-reconnect
      // is therefore safe — duplicates get dropped before render).
      //
      // Default endpoint behavior is Anthropic-spec — third-party clients
      // using @anthropic-ai/sdk against an OMA server get a clean stream
      // without these flags. See SPEC_EVENT_TYPES in @open-managed-agents/api-types.
      const path = `/v1/sessions/${sessionId}/events/stream?include=chunks&replay=1`;

      // Reconnect schedule for transient failures (network blip, 5xx, EOF).
      // Resets to zero on a successful onOpen so a healthy session that
      // briefly drops doesn't keep accumulating backoff. After 5 consecutive
      // failures we surface a single "Reconnecting…" toast — silent before
      // that so a 1-second blip doesn't pop UI noise.
      const backoffMs = [1000, 2000, 4000, 8000];
      let consecutiveFailures = 0;
      let reconnectToastShown = false;

      void streamSse(path, {
        signal,
        headers: activeTenant ? { "x-active-tenant": activeTenant } : {},
        async onOpen(response) {
          if (response.ok) {
            // Connection (re)established — clear the failure counter so the
            // next drop starts a fresh backoff schedule, and clear the toast
            // sentinel so a future degraded period can re-notify the user.
            consecutiveFailures = 0;
            reconnectToastShown = false;
            return;
          }
          if (response.status >= 400) {
            // Surface stream open failures the same way as regular API calls —
            // previously a 401 / 500 on the SSE handshake meant the timeline
            // just never updated. 4xx and 5xx alike get the same toast format
            // so the user sees a real error message instead of silence.
            const body = await response.json().catch(() => ({}));
            const message = readApiErrorMessage(body, response.status);
            toast.error(`/v1/sessions/${sessionId}/events/stream: ${message}`);
            // Non-retriable: 401/403/404 won't fix themselves on retry, and
            // hammering a 5xx that's surfaced to the user is also pointless.
            throw new FatalSseError(message);
          }
          // Anything non-ok that isn't ≥400 (3xx etc.) — fall through to
          // onError for the retry decision.
          throw new Error(`status ${response.status}`);
        },
        onMessage(data) {
          try {
            onEvent(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // Malformed payload — silently skip, matches prior behavior.
          }
        },
        onError(err) {
          // FatalSseError or caller abort never reach here — streamSse
          // re-throws them directly. Everything else is a transient
          // failure: stream closed cleanly, network blip, transient
          // 5xx. Apply the backoff schedule and reconnect.
          if (err instanceof FatalSseError) return null;
          consecutiveFailures += 1;
          if (consecutiveFailures === 5 && !reconnectToastShown) {
            reconnectToastShown = true;
            toast.info("Reconnecting…");
          }
          const idx = Math.min(consecutiveFailures - 1, backoffMs.length - 1);
          return backoffMs[idx];
        },
      }).catch(() => {
        // Promise rejects on FatalSseError (already toasted) or an abort
        // we missed — both are expected terminal states. Nothing more to do.
      });
    },
    [],
  );

  return useMemo(() => ({ api, streamEvents }), [api, streamEvents]);
}
