// An in-memory SandboxTokenStore for relay / installer tests that need a
// working gateway but not SQL (the SQL adapters run the conformance suite).
// The real authority, scope and egress code runs on top of it.
import { authenticateSandboxEgress, issueSandboxToken, type SandboxTokenScope, type SandboxTokenStore } from "../src/index";

export function memorySandboxTokens(options: { sessionId?: string; workspaceId?: string; vaultIds?: () => readonly string[] } = {}) {
  const sessionId = options.sessionId ?? "session";
  const workspaceId = options.workspaceId ?? "ws";
  const fence = { workspaceId, sessionId, executionId: "exe", attemptId: "att", ownerId: "owner", generation: 1 };
  let entries: Array<{ hash: string; scope: SandboxTokenScope }> = [];
  let state: "running" | "settled" = "running";
  let archived = false;
  let failing = false;
  const seenTokens: string[] = [];
  const store: SandboxTokenStore = {
    async find(input) {
      if (failing) throw new Error("database unavailable");
      if (input.sessionId !== sessionId) return null;
      const entry = state === "running" ? entries.find((candidate) => candidate.hash === input.tokenSha256) : undefined;
      return {
        session: { workspaceId, sessionId, archivedAt: archived ? "2026-01-01T00:00:00Z" : null, environmentId: "env", vaultIds: options.vaultIds?.() ?? ["vault"], agent: { id: "agent", version: 1 }, skills: [], fileIds: [], memoryStores: [] },
        attempt: entry === undefined ? null : { ...fence, claimedAtMs: 0, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER, tokenScope: entry.scope },
      };
    },
    async findSession() {
      return { workspaceId, sessionId, archivedAt: null, environmentId: "env", vaultIds: [], agent: { id: "agent", version: 1 }, skills: [], fileIds: [], memoryStores: [] };
    },
    async replaceTokenHash(input) {
      if (state !== "running") return "stale";
      if (entries.some((entry) => entry.scope !== input.scope)) return "scope_mismatch";
      entries = [{ hash: input.tokenSha256, scope: input.scope }];
      return "replaced";
    },
  };
  return {
    store, sessionId, fence,
    issue: (scope: SandboxTokenScope = "egress") => issueSandboxToken(store, fence, { scope }),
    authenticate: (authorization: string | null) => {
      const basic = /^Basic (\S+)$/u.exec(authorization ?? "")?.[1];
      if (basic !== undefined) seenTokens.push(atob(basic).split(":").slice(1).join(":"));
      return authenticateSandboxEgress(store, authorization);
    },
    /** The sandbox tokens the gateway was shown, in order. */
    seenTokens,
    /** The attempt ends (settle / take-over): every token of it is refused. */
    settle() { state = "settled"; entries = []; },
    /** A new attempt claims the execution: an empty token set, running again. */
    claimNext() { fence.generation++; fence.attemptId = `att-${fence.generation}`; state = "running"; entries = []; },
    archive() { archived = true; },
    /** The database cannot be read: 503, the forwarder stays up. */
    fail(value = true) { failing = value; },
  };
}
