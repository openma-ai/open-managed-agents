/**
 * Credentials + machine-id persistence.
 *
 * `credentials.json` is mode 0600 (owner read/write only) — the runtime
 * token is a long-lived bearer credential and we don't want any
 * user/group on the box reading it. The directory is mode 0700 so the
 * file's permissions can't be evaded by traversing the parent.
 *
 * `machine-id` is just a UUID generated on first run and persisted —
 * survives daemon reinstalls but is per-user (same machine, different
 * unix user → different machine_id, by design; runtimes are per-user).
 *
 * Shape evolution (multi-tenant rollout):
 *   - v1 (single-tenant, pre-rollout): no `v` field, top-level
 *     `agentApiKey`. One key per daemon, scoped to the single tenant the
 *     daemon was registered against.
 *   - v2 (multi-tenant, post-step-3): `v: 2`, `tenants: [{id, name,
 *     agentApiKey}]`. Daemon picks the right key per session based on the
 *     `tenant_id` field the server now injects on every session.start /
 *     .prompt / .cancel / .dispose message.
 *
 * v1 files are auto-migrated on first read via `GET /agents/runtime/me`
 * — the server returns the runtime's authorized tenant list, and we
 * synthesize a v2 file where every tenant in the response gets the same
 * v1 `agentApiKey` as a stub. The next `oma bridge refresh` rotates each
 * tenant to its own real per-tenant key.
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { paths } from "./platform.js";

/**
 * Legacy single-tenant credentials shape. Kept around purely so
 * `readCreds()` can recognize and migrate v1 files written by older
 * daemons; no new code should construct these.
 */
export interface CredentialsV1 {
  /** API root, e.g. "https://app.openma.dev". WS attach swaps https→wss. */
  serverUrl: string;
  /** Runtime row id returned by /agents/runtime/exchange. */
  runtimeId: string;
  /** sk_machine_… — bearer token for /agents/runtime/_attach. */
  token: string;
  /** Single per-daemon `oma_*` PAT. v1 daemons only ever knew one tenant. */
  agentApiKey?: string;
  /** Echoed for diagnostics; daemon also reads machineIdFile directly. */
  machineId: string;
  /** When this machine was first registered (unix seconds). */
  createdAt: number;
}

/**
 * Multi-tenant credentials shape (v2). The daemon may be authorized for
 * N tenants; per-session API-key lookup happens via SessionManager's
 * `#tenantKeys` map (populated from this array at startup + after every
 * `oma bridge refresh`).
 */
export interface CredentialsV2 {
  v: 2;
  /** API root, e.g. "https://app.openma.dev". WS attach swaps https→wss. */
  serverUrl: string;
  /** Runtime row id returned by /agents/runtime/exchange. */
  runtimeId: string;
  /** sk_machine_… — bearer token for /agents/runtime/_attach. */
  token: string;
  /**
   * One entry per (runtime, tenant) authorization. `agentApiKey` is the
   * `oma_*` PAT the daemon hands to spawned ACP children as the
   * `mcpServers[].authorization_token` so they can call OMA's mcp-proxy
   * for THAT tenant.
   */
  tenants: Array<{ id: string; name: string; agentApiKey: string }>;
  /** Echoed for diagnostics; daemon also reads machineIdFile directly. */
  machineId: string;
  /** When this machine was first registered (unix seconds). */
  createdAt: number;
}

/** Canonical credentials shape. All non-migration code uses CredentialsV2. */
export type Credentials = CredentialsV2;

/**
 * Synthetic tenant id used when the v1→v2 migration fetch fails (offline
 * / server down). Lets the daemon keep running with its single legacy
 * key under an `__unknown__` tenant; the next `oma bridge refresh` after
 * connectivity is restored replaces it with real ids. The server NEVER
 * sees this id; it stays daemon-side until refresh wipes it.
 */
const UNKNOWN_TENANT_ID = "__unknown__";

interface RuntimeMeResponse {
  runtime: { id: string; machine_id: string; hostname: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

export async function readCreds(): Promise<CredentialsV2 | null> {
  // We deliberately do NOT migrate from any "legacy" config dir. The shared
  // `~/.config/oma/credentials.json` belongs to `oma auth login` and has a
  // different shape (Pattern A multi-tenant token bag); reusing those bytes
  // here would silently overwrite the user's CLI auth.
  let text: string;
  try {
    text = await readFile(paths().credsFile, "utf-8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const parsed = JSON.parse(text) as Partial<CredentialsV2> & Partial<CredentialsV1>;
  if (parsed.v === 2 && Array.isArray(parsed.tenants)) {
    return parsed as CredentialsV2;
  }
  // Anything without `v: 2` is treated as v1. We don't validate the v1
  // shape strictly — if the file is too corrupt to migrate, the daemon
  // will fail downstream and the user re-runs `oma bridge setup --force`.
  const v1 = parsed as CredentialsV1;
  const v2 = await migrateV1ToV2(v1);
  // Persist on disk so next startup is fast (no server round-trip).
  // Best-effort: if the write fails (read-only fs, perms surprise), the
  // returned in-memory object is still usable for this run.
  try { await writeCreds(v2); } catch { /* keep going with in-memory v2 */ }
  return v2;
}

/**
 * Synthesize a CredentialsV2 from a CredentialsV1 file. Calls
 * `/agents/runtime/me` to enumerate the runtime's authorized tenants;
 * every tenant gets the same v1 `agentApiKey` as a placeholder since v1
 * daemons only ever held one key. The next `oma bridge refresh` rotates
 * each tenant to a real per-tenant key.
 *
 * If the fetch fails (offline / server unreachable / 5xx), falls back to
 * a single-tenant v2 stub with a synthetic `__unknown__` id so the
 * daemon can keep running. User fixes via `oma bridge refresh` once
 * network's back.
 */
async function migrateV1ToV2(v1: CredentialsV1): Promise<CredentialsV2> {
  const stubKey = v1.agentApiKey ?? "";
  let tenants: Array<{ id: string; name: string; agentApiKey: string }>;
  try {
    const url = `${v1.serverUrl.replace(/\/$/, "")}/agents/runtime/me`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${v1.token}` },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = (await res.json()) as RuntimeMeResponse;
    if (!Array.isArray(body.tenants) || body.tenants.length === 0) {
      throw new Error("server returned no tenants");
    }
    tenants = body.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      agentApiKey: stubKey,
    }));
  } catch {
    // Offline / 5xx / unparseable response — fall back to a synthetic
    // single-tenant entry so the daemon can still spawn ACP children
    // with the v1 key. The synthesized id stays daemon-local; the next
    // `oma bridge refresh` (after connectivity is restored) replaces
    // this stub with the real per-tenant authorizations.
    tenants = [
      { id: UNKNOWN_TENANT_ID, name: "Unknown workspace", agentApiKey: stubKey },
    ];
  }
  return {
    v: 2,
    serverUrl: v1.serverUrl,
    runtimeId: v1.runtimeId,
    token: v1.token,
    tenants,
    machineId: v1.machineId,
    createdAt: v1.createdAt,
  };
}

export async function writeCreds(creds: CredentialsV2): Promise<void> {
  const file = paths().credsFile;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // chmod again in case the file already existed with looser perms.
  await chmod(file, 0o600);
}

export async function deleteCreds(): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(paths().credsFile);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Get-or-create the per-user machine fingerprint. Generated once and
 * persisted; survives daemon reinstalls but is not tied to hardware
 * (so a `~` restore from backup keeps the same id, which is what we
 * want — the user's runtime continues to be "the same machine").
 */
export async function getOrCreateMachineId(): Promise<string> {
  const file = paths().machineIdFile;
  try {
    const id = (await readFile(file, "utf-8")).trim();
    if (id.length >= 32) return id;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const id = randomUUID();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, id + "\n", { mode: 0o600 });
  return id;
}
