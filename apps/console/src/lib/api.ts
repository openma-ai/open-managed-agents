const BASE = "";
const CONSOLE_API_BETAS = [
  "managed-agents-2026-04-01",
  "files-api-2025-04-14",
  "skills-2025-10-02",
  "agent-memory-2026-07-22",
  "dreaming-2026-04-21",
  "mcp-tunnels-2026-06-22",
  "user-profiles-2026-08-18",
].join(",");

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { iterateJsonSseStream } from "./sse";

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
 *  the login screen already communicates. /v1/oma/me 401 is handled the same
 *  way by the sidebar bootstrapping path. */
const SILENT_AUTH_PATHS = ["/auth-info", "/v1/oma/me"];

function shouldSilenceAuthError(path: string, status: number): boolean {
  if (status !== 401 && status !== 403) return false;
  return SILENT_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
}

function getApiToastMessage(info: ApiErrorInfo, status: number): string {
  if (info.message !== `HTTP ${status}`) return info.message;
  if (status >= 500) return "Server error. Please try again.";
  return `Request failed (HTTP ${status}).`;
}

export function useApi() {
  // The request transports are wrapped in useCallback so a render of any
  // consumer doesn't produce fresh closures.
  // Before this, every component calling `useApi()` got new function identities
  // each render — including them in a `useEffect` dep array would loop the
  // effect, so callers had to either omit `api` (eslint-disable) or stash it
  // in a ref. With these stable refs, `useApiQuery` / `useInfiniteApiQuery` /
  // `useEffect([id])` can include `api` cleanly without retriggering.
  // `toast` is imported from sonner at module scope; the module-level
  // function reference is stable across renders.
  const apiRaw = useCallback(
    async function apiRaw(
      path: string,
      init?: RequestInit
    ): Promise<Response> {
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
            "anthropic-beta": CONSOLE_API_BETAS,
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
          toast.error(getApiToastMessage(info, res.status), {
            id: `api-error:${res.status}:${info.code || info.message}`,
          });
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
      return res;
    },
    [],
  );

  const api = useCallback(
    async function api<T = unknown>(
      path: string,
      init?: RequestInit,
    ): Promise<T> {
      const response = await apiRaw(path, init);
      return response.json() as Promise<T>;
    },
    [apiRaw],
  );

  const apiStream = useCallback(
    async function apiStream<T>(
      path: string,
      init?: RequestInit,
    ): Promise<AsyncIterable<T>> {
      const response = await apiRaw(path, {
        ...init,
        cache: "no-store",
        headers: {
          Accept: "text/event-stream",
          ...init?.headers,
        },
      });
      if (!response.body) {
        throw new Error("Managed Agents event stream response has no body");
      }
      return iterateJsonSseStream<T>(response.body);
    },
    [apiRaw],
  );

  return useMemo(
    () => ({ api, apiRaw, apiStream }),
    [api, apiRaw, apiStream],
  );
}
