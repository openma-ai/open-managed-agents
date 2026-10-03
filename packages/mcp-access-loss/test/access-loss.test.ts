import { describe, expect, it, vi } from "vitest";

import {
  applyAccessLossEffect,
  classifyUpstreamAccess,
  type AccessLossEffect,
  type AccessLossEffectStore,
  type AccessLossEffectPorts,
} from "../src/index";

function observation(overrides: Partial<Parameters<typeof classifyUpstreamAccess>[0]> = {}) {
  return {
    httpStatus: 200,
    bodyText: "",
    serverName: "slack",
    requestBody: null,
    refreshed: false,
    refreshFailed: false,
    refreshFailureCode: null,
    ...overrides,
  };
}

describe("classifyUpstreamAccess", () => {
  it("maps Slack channel loss and keeps token revocation on the credential", () => {
    expect(classifyUpstreamAccess(observation({
      bodyText: JSON.stringify({ result: { isError: true, content: [{ text: "not_in_channel" }] } }),
      requestBody: JSON.stringify({
        method: "tools/call",
        params: { arguments: { channel_id: "C123" } },
      }),
    }))).toEqual({
      class: "scope_lost",
      provider: "slack",
      code: "not_in_channel",
      resource: { type: "channel", id: "C123" },
    });
    expect(classifyUpstreamAccess(observation({
      bodyText: '{"error":"channel_not_found"}',
    })).class).toBe("scope_lost");
    expect(classifyUpstreamAccess(observation({
      bodyText: '{"error":"token_revoked"}',
    })).class).toBe("credential_lost");
    expect(classifyUpstreamAccess(observation({
      bodyText: '{"error":"account_inactive"}',
    })).class).toBe("credential_lost");
  });

  it("maps Linear and GitHub scope loss", () => {
    expect(classifyUpstreamAccess(observation({
      serverName: "linear",
      bodyText: "Could not find referenced Issue",
    }))).toMatchObject({ class: "scope_lost", provider: "linear", code: "issue_not_found" });
    expect(classifyUpstreamAccess(observation({
      serverName: "linear",
      bodyText: "You are not assigned to this issue",
    }))).toMatchObject({ code: "issue_unassigned" });
    expect(classifyUpstreamAccess(observation({
      serverName: "github",
      bodyText: '{"error":"installation_not_found"}',
    }))).toMatchObject({ class: "scope_lost", provider: "github", code: "installation_not_found" });
    expect(classifyUpstreamAccess(observation({
      serverName: "github",
      bodyText: "Repository not found",
    }))).toMatchObject({ code: "repository_not_found" });
  });

  it("leaves network failures, rate limits, 5xx, and generic 401s retryable", () => {
    expect(classifyUpstreamAccess(observation({ httpStatus: null })).class).toBe("retryable");
    expect(classifyUpstreamAccess(observation({ httpStatus: 429, bodyText: "not_in_channel" })).class).toBe("retryable");
    expect(classifyUpstreamAccess(observation({ httpStatus: 500, bodyText: "not_in_channel" })).class).toBe("retryable");
    expect(classifyUpstreamAccess(observation({
      httpStatus: 401,
      bodyText: '{"error":"unauthorized"}',
    })).class).toBe("retryable");
    expect(classifyUpstreamAccess(observation({
      httpStatus: 401,
      bodyText: '{"error":"unauthorized"}',
      refreshFailed: true,
    })).class).toBe("retryable");
    expect(classifyUpstreamAccess(observation({
      httpStatus: 401,
      refreshFailed: true,
      refreshFailureCode: "invalid_grant",
    }))).toMatchObject({ class: "credential_lost", provider: "generic", code: "invalid_grant" });
  });
});

function effect(overrides: Partial<AccessLossEffect> = {}): AccessLossEffect {
  return {
    id: "ale_1",
    workspaceId: "tenant",
    sessionId: "session",
    serverName: "slack",
    provider: "slack",
    kind: "scope_lost",
    code: "not_in_channel",
    publicationId: "pub",
    resource: { type: "channel", id: "C1" },
    generation: 1,
    createdAt: "2026-10-02T00:00:00.000Z",
    ...overrides,
  };
}

function memoryStore(): AccessLossEffectStore & { status: string | null } {
  const state: { status: string | null } = { status: null };
  return {
    get status() {
      return state.status;
    },
    async record(next) {
      if (state.status) return { type: "exists", status: state.status as "recorded" };
      state.status = "recorded";
      void next;
      return { type: "recorded" };
    },
    async markApplied() {
      if (state.status !== "recorded") return false;
      state.status = "applied";
      return true;
    },
    async markSuperseded() {
      if (state.status === "recorded") state.status = "superseded";
    },
  };
}

function ports(overrides: Partial<AccessLossEffectPorts> = {}): AccessLossEffectPorts {
  return {
    maxGeneration: async () => 1,
    closeScope: async () => ({ type: "closed" }),
    cancelWakeups: async () => ({ cancelled: 1 }),
    stopExecution: async () => undefined,
    pauseCredential: async () => undefined,
    ...overrides,
  };
}

describe("applyAccessLossEffect", () => {
  it("closes the scope, cancels wakeups, and notifies once", async () => {
    const store = memoryStore();
    const closeScope = vi.fn(async () => ({ type: "closed" as const }));
    const cancelWakeups = vi.fn(async () => ({ cancelled: 2 }));
    const notify = vi.fn(async () => undefined);
    const first = await applyAccessLossEffect(effect(), store, ports({
      closeScope,
      cancelWakeups,
      notify,
    }));
    const second = await applyAccessLossEffect(effect(), store, ports({
      closeScope,
      cancelWakeups,
      notify,
    }));
    expect(first).toMatchObject({ type: "applied", wakeupsCancelled: 2 });
    expect(second).toEqual({ type: "already_applied" });
    expect(closeScope).toHaveBeenCalledOnce();
    expect(cancelWakeups).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("does not close a newer generation and still commits when notification throws", async () => {
    const stale = memoryStore();
    const closeScope = vi.fn(async () => ({ type: "closed" as const }));
    const result = await applyAccessLossEffect(effect({ generation: 1 }), stale, ports({
      maxGeneration: async () => 2,
      closeScope,
    }));
    expect(result).toEqual({ type: "superseded" });
    expect(closeScope).not.toHaveBeenCalled();
    expect(stale.status).toBe("superseded");

    const store = memoryStore();
    const applied = await applyAccessLossEffect(effect(), store, ports({
      notify: async () => {
        throw new Error("smtp down");
      },
    }));
    expect(applied.type).toBe("applied");
    expect(store.status).toBe("applied");
  });

  it("pauses a credential without closing scopes or cancelling wakeups", async () => {
    const closeScope = vi.fn(async () => ({ type: "closed" as const }));
    const cancelWakeups = vi.fn(async () => ({ cancelled: 1 }));
    const pauseCredential = vi.fn(async () => undefined);
    const result = await applyAccessLossEffect(effect({
      kind: "credential_lost",
      code: "token_revoked",
    }), memoryStore(), ports({ closeScope, cancelWakeups, pauseCredential }));
    expect(result.type).toBe("applied");
    expect(closeScope).not.toHaveBeenCalled();
    expect(cancelWakeups).not.toHaveBeenCalled();
    expect(pauseCredential).toHaveBeenCalledOnce();
  });
});
