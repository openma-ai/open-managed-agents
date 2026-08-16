// Shared fetch wrapper used by all provider clients. Extracted from
// client.ts so per-provider sub-clients (LinearClient, SlackClient,
// GitHubClient, FeishuClient) can live in their own files without
// dragging in unrelated providers for coverage.

export interface RequestError extends Error {
  status?: number;
}

export async function request<T = unknown>(
  basePath: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${basePath}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    // Server may emit either the legacy `{error: "<str>", details?}` shape
    // (older endpoints) or the Anthropic-compat envelope `{type:"error",
    // error:{type, message}, request_id}`. Honor both so thrown errors
    // carry a real message either way.
    const body = (await res.json().catch(() => ({}))) as {
      error?: string | { message?: string };
      details?: string;
    };
    let msg: string;
    if (body.details) msg = body.details;
    else if (typeof body.error === "string") msg = body.error;
    else if (body.error && typeof body.error === "object" && body.error.message)
      msg = body.error.message;
    else msg = `HTTP ${res.status}`;
    const err = new Error(msg) as RequestError;
    err.status = res.status;
    throw err;
  }
  return (await res.json()) as T;
}