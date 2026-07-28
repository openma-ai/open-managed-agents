// @ts-nocheck
/**
 * Unit tests for the multi-tenant CLI bridge — step 3 deliverables.
 *
 * Covers the two behaviors the daemon's correctness rests on:
 *
 *   1. config.ts — v1→v2 inline migration. A daemon upgraded from a
 *      pre-rollout build MUST be able to read its existing on-disk
 *      credentials.json without user intervention. The migration calls
 *      `GET /agents/runtime/me`, synthesizes a v2 stub where every
 *      tenant in the response carries the same legacy `agentApiKey`,
 *      and rewrites the file on disk. If the server fetch fails, we
 *      fall back to a synthetic `__unknown__` tenant so the daemon can
 *      still spawn ACP children with the v1 key.
 *
 *   2. v2 fast-path — files with `v: 2` are returned verbatim, no
 *      network round-trip.
 *
 * SessionManager's per-tenant key lookup is NOT covered here as a unit
 * test: importing session-manager.ts pulls @open-managed-agents/acp-runtime,
 * which imports node:child_process + node:stream at module evaluation
 * time. Those modules aren't supported in workerd's vitest pool (the
 * worker segfaults on startup). The integration test in
 * `test/e2e/bridge-acp-flow.test.ts` exercises that path against a
 * live daemon + ACP child.
 *
 * Test isolation: each test sets a unique `OMA_PROFILE` slug so
 * `paths().credsFile` resolves to its own subdir under HOME
 * (~/.oma/bridge-<profile>/credentials.json). HOME redirection via
 * env var is NOT honored by `os.homedir()` in workerd, so profile-
 * scoped paths are the only available isolation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readCreds,
  writeCreds,
  type CredentialsV1,
  type CredentialsV2,
} from "../../packages/cli/src/bridge/lib/config";

let profileCounter = 0;

describe("config.ts — CredentialsV2 + v1→v2 inline migration", () => {
  const ORIGINAL_PROFILE = process.env.OMA_PROFILE;
  const ORIGINAL_FETCH = globalThis.fetch;
  let profile: string;
  let bridgeDir: string;
  let credsFile: string;

  beforeEach(async () => {
    // Unique profile per test → unique configDir → no cross-test
    // pollution. The "z" suffix keeps the slug PROFILE_SLUG_RE-valid
    // (must end with [a-z0-9]).
    profileCounter += 1;
    profile = `unit${profileCounter}testz`;
    process.env.OMA_PROFILE = profile;
    bridgeDir = join(homedir(), `.oma/bridge-${profile}`);
    credsFile = join(bridgeDir, "credentials.json");
    await mkdir(bridgeDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    if (ORIGINAL_PROFILE === undefined) delete process.env.OMA_PROFILE;
    else process.env.OMA_PROFILE = ORIGINAL_PROFILE;
    globalThis.fetch = ORIGINAL_FETCH;
    // Best-effort: remove the unique bridge dir so a re-run starts clean.
    await rm(bridgeDir, { recursive: true, force: true });
  });

  it("returns v2 file as-is without touching the network", async () => {
    const v2: CredentialsV2 = {
      v: 2,
      serverUrl: "https://app.openma.dev",
      runtimeId: "rt-deadbeef",
      token: "sk_machine_xxx",
      tenants: [
        { id: "ten-a", name: "Acme", agentApiKey: "oma_a" },
        { id: "ten-b", name: "Beta", agentApiKey: "oma_b" },
      ],
      machineId: "m-1",
      createdAt: 1_700_000_000,
    };
    await writeCreds(v2);
    // Fail loudly if the migration path tries to hit the network — v2
    // files must short-circuit before any fetch().
    globalThis.fetch = vi.fn(() => {
      throw new Error("fetch must not be called for v2 reads");
    }) as unknown as typeof fetch;
    const got = await readCreds();
    expect(got).toEqual(v2);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("migrates v1 to v2 by fetching /agents/runtime/me and stamps the same legacy key on every tenant", async () => {
    const v1: CredentialsV1 = {
      serverUrl: "https://app.openma.dev",
      runtimeId: "rt-cafe",
      token: "sk_machine_v1",
      agentApiKey: "oma_legacy",
      machineId: "m-1",
      createdAt: 1_700_000_000,
    };
    await writeFile(credsFile, JSON.stringify(v1), { mode: 0o600 });

    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://app.openma.dev/agents/runtime/me");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer sk_machine_v1",
      );
      return new Response(
        JSON.stringify({
          runtime: { id: "rt-cafe", machine_id: "m-1", hostname: "host" },
          tenants: [
            { id: "ten-a", name: "Acme", role: "owner" },
            { id: "ten-b", name: "Beta", role: "admin" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const got = await readCreds();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(got).toEqual({
      v: 2,
      serverUrl: "https://app.openma.dev",
      runtimeId: "rt-cafe",
      token: "sk_machine_v1",
      tenants: [
        // Both tenants get the SAME v1 key — by design. /refresh rotates
        // them to per-tenant keys on next user action.
        { id: "ten-a", name: "Acme", agentApiKey: "oma_legacy" },
        { id: "ten-b", name: "Beta", agentApiKey: "oma_legacy" },
      ],
      machineId: "m-1",
      createdAt: 1_700_000_000,
    });

    // On-disk upgrade — next start is now a fast-path (no fetch) even
    // if the network is offline at boot.
    const raw = await readFile(credsFile, "utf-8");
    expect(JSON.parse(raw).v).toBe(2);
  });

  it("falls back to a single __unknown__ tenant when the migration fetch fails", async () => {
    const v1: CredentialsV1 = {
      serverUrl: "https://app.openma.dev",
      runtimeId: "rt-offline",
      token: "sk_machine_v1",
      agentApiKey: "oma_legacy",
      machineId: "m-1",
      createdAt: 1_700_000_000,
    };
    await writeFile(credsFile, JSON.stringify(v1), { mode: 0o600 });

    // Simulate offline: fetch rejects. Daemon should still get a
    // usable v2 with the legacy key under the synthetic tenant id, so
    // it can keep running until the user does `oma bridge refresh`.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const got = await readCreds();
    expect(got).not.toBeNull();
    expect(got!.tenants).toEqual([
      { id: "__unknown__", name: "Unknown workspace", agentApiKey: "oma_legacy" },
    ]);
    // Still upgraded on disk so we don't re-attempt the fetch on every
    // start while offline.
    const raw = await readFile(credsFile, "utf-8");
    expect(JSON.parse(raw).v).toBe(2);
  });

  it("falls back to __unknown__ when the server replies 5xx during migration", async () => {
    const v1: CredentialsV1 = {
      serverUrl: "https://app.openma.dev",
      runtimeId: "rt-5xx",
      token: "sk_machine_v1",
      agentApiKey: "oma_legacy",
      machineId: "m-1",
      createdAt: 1_700_000_000,
    };
    await writeFile(credsFile, JSON.stringify(v1), { mode: 0o600 });
    globalThis.fetch = vi.fn(async () => new Response("oops", { status: 503 })) as unknown as typeof fetch;
    const got = await readCreds();
    expect(got).not.toBeNull();
    expect(got!.tenants[0].id).toBe("__unknown__");
    expect(got!.tenants[0].agentApiKey).toBe("oma_legacy");
  });

  it("returns null when no credentials file exists", async () => {
    // beforeEach created the dir but no creds file in it.
    const got = await readCreds();
    expect(got).toBeNull();
  });
});
