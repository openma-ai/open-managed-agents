import { describe, expect, it } from "vitest";
import { agentView, makeAgentsPort } from "./fixtures";
import { buildAgentsTestApi } from "./test-api";

const headers = {
  "anthropic-beta": "managed-agents-2026-04-01",
  "content-type": "application/json",
};

const unpinned = [
  ["claude-acp", /must pin a version/],
  ["claude-acp@latest", /must pin a version/],
  ["nope@1.0.0", /Unknown ACP registry agent \\"nope\\"/],
  ["claude-acp@0.93.0", /claude-acp@0\.93\.0 is not pinned/],
] as const;

function rejectingApi(calls: unknown[]) {
  return buildAgentsTestApi(
    makeAgentsPort({
      createAgent: async (input) => {
        calls.push(input);
        throw new Error("create port must not run for an unpinned registry reference");
      },
      updateAgent: async (input) => {
        calls.push(input);
        throw new Error("update port must not run for an unpinned registry reference");
      },
    }),
  );
}

describe("Managed Agents API — ACP registry pins are validated at save time", () => {
  it.each(unpinned)("rejects create with registry %s and names the pinned references", async (registry, message) => {
    const calls: unknown[] = [];
    const response = await rejectingApi(calls).request("/v1/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "n",
        model: "claude-opus-5",
        _oma: { harness: "acp-sandbox", acp: { agent: { registry } } },
      }),
    });

    expect(response.status).toBe(400);
    const body = JSON.stringify(await response.json());
    expect(body).toMatch(message);
    expect(body).toContain("pinned ACP registry agents: claude-acp@0.94.0");
    expect(calls).toEqual([]);
  });

  it.each(unpinned)("rejects update with registry %s", async (registry, message) => {
    const calls: unknown[] = [];
    const response = await rejectingApi(calls).request(`/v1/agents/${agentView.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ _oma: { acp: { agent: { registry } } } }),
    });

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toMatch(message);
    expect(calls).toEqual([]);
  });

  it("accepts the pinned reference on update", async () => {
    const calls: unknown[] = [];
    const api = buildAgentsTestApi(
      makeAgentsPort({
        updateAgent: async (input) => {
          calls.push(input);
          return { type: "updated", agent: agentView };
        },
      }),
    );
    const response = await api.request(`/v1/agents/${agentView.id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ _oma: { acp: { agent: { registry: "claude-acp@0.94.0" } } } }),
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
