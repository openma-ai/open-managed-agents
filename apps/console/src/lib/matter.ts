import { getActiveTenantId } from "./api";

/**
 * Calls to the OpenMatter service (apps/matter), which the control plane
 * proxies at `/matter/*` after authenticating the user.
 */

export class MatterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly problems: readonly string[] = [],
  ) {
    super(code ?? `HTTP ${status}`);
  }
}

export async function matter<T>(path: string, init?: RequestInit): Promise<T> {
  const tenant = getActiveTenantId();
  const res = await fetch(`/matter${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(tenant ? { "x-active-tenant": tenant } : {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: unknown; problems?: unknown };
    throw new MatterError(
      res.status,
      typeof body.error === "string" ? body.error : undefined,
      Array.isArray(body.problems) ? body.problems.filter((p): p is string => typeof p === "string") : [],
    );
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** A Loop template as `GET /matter/loop-templates` lists it. */
export interface LoopTemplate {
  id: string;
  /** Display name a deployment gave its own template. */
  name?: string;
  version: string;
  provider: "feishu" | "gitlab";
  description: string;
  configSchema: {
    properties: Record<string, FieldSchema>;
    required: string[];
  };
}

export interface FieldSchema {
  type?: string;
  title?: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  items?: FieldSchema;
  "x-oma-widget"?: string;
  /** "session": an OpenMA session setting the host adds to every template. */
  "x-oma-section"?: string;
  "x-bond-provider"?: string;
}

export interface Loop {
  id: string;
  template: string;
  provider?: "feishu" | "gitlab";
  config: Record<string, unknown> & { bond: string };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  state: { running: boolean; lastError?: { message: string; at: string } };
}

export interface SetupReport {
  ready: boolean;
  problems: string[];
  links?: { scopes?: string; events?: string; bot?: string; publish?: string };
}

export interface Bond {
  id: string;
  provider: "feishu" | "gitlab";
  label: string;
  connectedAt: string;
  running: boolean;
  lastError?: { message: string; at: string };
  loops: number;
  setup?: SetupReport;
  details: Record<string, unknown>;
}

export interface BondResource {
  id: string;
  kind: string;
  title: string;
  url?: string;
}
