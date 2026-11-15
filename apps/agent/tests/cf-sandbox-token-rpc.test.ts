import { expect, it } from "vitest";
import { issueCfSandboxTokenResult } from "../../main/src/lib/cf-sandbox-token-rpc";
import type { SandboxTokenStore, SandboxTokenSession } from "@open-managed-agents/sandbox-gateway";

const request = { tenantId: "ws", sessionId: "sess-legacy", attempt: { workspaceId: "ws", sessionId: "sess-legacy", executionId: "exec", attemptId: "att", ownerId: "owner", generation: 1 }, harness: null };
const managed: SandboxTokenSession = { workspaceId: "ws", sessionId: "session_managed", archivedAt: null, environmentId: "env", vaultIds: [], agent: { id: "agent", version: 1 }, skills: [], fileIds: [], memoryStores: [] };
function fixture(options: { session?: SandboxTokenSession | null; replace?: "replaced" | "stale" | "scope_mismatch"; legacy?: boolean; active?: boolean; errorAt?: "lookup" | "replace" | "legacy" | "fence" } = {}) {
  const failure = new Error("private database password=secret");
  let mutations = 0;
  const store: SandboxTokenStore = { find: async () => null, findSession: async () => { if (options.errorAt === "lookup") throw failure; return options.session ?? null; }, replaceTokenHash: async () => { mutations++; if (options.errorAt === "replace") throw failure; return options.replace ?? "replaced"; } };
  return { deps: { store, legacySession: async () => { if (options.errorAt === "legacy") throw failure; return options.legacy ? { archivedAt: null } : null; }, legacyFenceActive: async () => { if (options.errorAt === "fence") throw failure; return options.active ?? true; }, report: () => undefined }, mutations: () => mutations };
}
it("only a positively existing legacy Session with a live fence may bind no token", async () => {
  const f = fixture({ legacy: true });
  expect(await issueCfSandboxTokenResult(f.deps, request)).toMatchObject({ type: "legacy_without_token", phase: "session_lookup" });
  expect(f.mutations()).toBe(0);
});
it("missing Session is a refusal, not legacy inferred from its id", async () => {
  expect(await issueCfSandboxTokenResult(fixture().deps, request)).toMatchObject({ type: "failed", code: "session_not_found" });
});
it("missing or expired legacy fence refuses without issuing", async () => {
  const f = fixture({ legacy: true, active: false });
  expect(await issueCfSandboxTokenResult(f.deps, request)).toMatchObject({ type: "failed", code: "stale_fence" });
  expect(f.mutations()).toBe(0);
});
it.each(["lookup", "replace", "legacy", "fence"] as const)("%s database failure is sanitized and fail closed", async errorAt => {
  const f = fixture({ session: errorAt === "replace" ? managed : null, legacy: true, errorAt });
  const result = await issueCfSandboxTokenResult(f.deps, request);
  expect(result).toMatchObject({ type: "failed", code: "unavailable" });
  expect(JSON.stringify(result)).not.toContain("secret");
  expect(JSON.stringify(result)).not.toContain("password");
});
it.each(["stale", "scope_mismatch"] as const)("managed %s rejects, not no-token", async replace => {
  const result = await issueCfSandboxTokenResult(fixture({ session: managed, replace }).deps, request);
  expect(result).toMatchObject({ type: "failed", phase: "token_replace", code: replace === "stale" ? "stale_fence" : "scope_mismatch" });
});
it("invalid fence identity rejects before mutation", async () => {
  const f = fixture({ session: managed });
  expect(await issueCfSandboxTokenResult(f.deps, { ...request, attempt: { ...request.attempt, workspaceId: "other" } })).toMatchObject({ type: "failed", code: "invalid_request" });
  expect(f.mutations()).toBe(0);
});
it("managed issuance retains existing authority scope and token mutation", async () => {
  const f = fixture({ session: managed });
  expect(await issueCfSandboxTokenResult(f.deps, request)).toMatchObject({ type: "issued", token: expect.stringMatching(/^oma_sbx_/) });
  expect(f.mutations()).toBe(1);
});
