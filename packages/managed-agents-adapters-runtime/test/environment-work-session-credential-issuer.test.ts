import { describe, expect, it } from "vitest";
import {
  authenticateEnvironmentWorkSessionBearer,
  OpaqueEnvironmentWorkSessionCredentialIssuer,
  SealedEnvironmentWorkSessionCredentialIssuer,
} from "../src";

const environment = {
  id: "env_self_01",
  archivedAt: null,
  config: { type: "self_hosted" as const },
  createdAt: "2026-08-26T09:00:00.000Z",
  description: null,
  metadata: {},
  name: "Self hosted",
  updatedAt: "2026-08-26T09:00:00.000Z",
};

const session = {
  id: "session_01",
  agent: {
    id: "agent_01",
    description: null,
    mcpServers: [],
    model: { id: "claude-opus-5" },
    multiagent: null,
    name: "Agent",
    skills: [
      { skillId: "skill_allowed", type: "custom" as const, version: "3" },
    ],
    system: null,
    tools: [],
    version: 1,
  },
  archivedAt: null,
  budget: null,
  createdAt: "2026-08-26T09:20:00.000Z",
  environmentId: "env_self_01",
  metadata: {},
  outcomeEvaluations: [],
  resources: [
    {
      type: "memory_store" as const,
      memoryStoreId: "mem_read_only",
      access: "read_only" as const,
    },
    {
      type: "memory_store" as const,
      memoryStoreId: "mem_read_write",
      access: "read_write" as const,
    },
  ],
  stats: {},
  status: "running" as const,
  title: null,
  updatedAt: "2026-08-26T09:20:00.000Z",
  usage: {},
  vaultIds: [],
};

describe("Environment Work Session credential issuer", () => {
  it("issues the structured runner secret without wire encoding", async () => {
    const issuer = new OpaqueEnvironmentWorkSessionCredentialIssuer({
      nextToken: () => "credential_01",
      apiBaseUrl: "https://openma.test",
    });

    await expect(
      issuer.issue({
        workspaceId: "workspace_01",
        environment,
        session,
        workId: "work_01",
      }),
    ).resolves.toEqual({
      type: "issued",
      secret: {
        sessionsToken: "sk-ant-req-credential_01",
        apiBaseUrl: "https://openma.test",
      },
    });
  });

  it("issues a sealed per-work token and authorizes only its worker resource paths", async () => {
    const sealed = new Map<string, string>();
    let counter = 0;
    const crypto = {
      encrypt: async (plaintext: string) => {
        const ciphertext = `cipher_${++counter}`;
        sealed.set(ciphertext, plaintext);
        return ciphertext;
      },
      decrypt: async (ciphertext: string) => {
        const plaintext = sealed.get(ciphertext);
        if (plaintext === undefined) throw new Error("invalid ciphertext");
        return plaintext;
      },
    };
    const now = new Date("2026-09-03T04:00:00.000Z");
    const issuer = new SealedEnvironmentWorkSessionCredentialIssuer({
      crypto,
      now: () => now,
      ttlMs: 60_000,
      apiBaseUrl: "https://openma.test",
    });
    const issued = await issuer.issue({
      workspaceId: "workspace_01",
      environment,
      session,
      workId: "work_01",
    });
    if (issued.type !== "issued") throw new Error("expected issued credential");
    expect(issued.secret.apiBaseUrl).toBe("https://openma.test");
    expect(issued.secret.sessionsToken).toMatch(/^sk-ant-req-v1\./);

    const authorize = (method: string, path: string, at = now) =>
      authenticateEnvironmentWorkSessionBearer({
        token: issued.secret.sessionsToken,
        method,
        path,
        crypto,
        now: () => at,
      });

    for (const [method, path] of [
      ["POST", "/v1/environments/env_self_01/work/work_01/heartbeat"],
      ["POST", "/v1/environments/env_self_01/work/work_01/stop"],
      ["GET", "/v1/sessions/session_01"],
      ["GET", "/v1/sessions/session_01/events"],
      ["POST", "/v1/sessions/session_01/events"],
      ["GET", "/v1/sessions/session_01/events/stream"],
      ["GET", "/v1/skills/skill_allowed/versions/3"],
      ["GET", "/v1/skills/skill_allowed/versions/3/content"],
      ["GET", "/v1/memory_stores/mem_read_only/memories"],
      ["POST", "/v1/memory_stores/mem_read_write/memories"],
      ["DELETE", "/v1/memory_stores/mem_read_write/memories/memory_01"],
    ] as const) {
      await expect(authorize(method, path)).resolves.toEqual({
        sessionId: "session_01",
        workspaceId: "workspace_01",
      });
    }

    for (const [method, path] of [
      ["POST", "/v1/environments/env_self_01/work/work_other/heartbeat"],
      ["GET", "/v1/sessions/session_other"],
      ["POST", "/v1/sessions/session_01"],
      ["GET", "/v1/skills/skill_other/versions/3/content"],
      ["POST", "/v1/memory_stores/mem_read_only/memories"],
      ["GET", "/v1/memory_stores/mem_other/memories"],
      ["GET", "/v1/agents"],
    ] as const) {
      await expect(authorize(method, path)).resolves.toBeNull();
    }
    await expect(
      authorize("GET", "/v1/sessions/session_01", new Date(now.getTime() + 60_001)),
    ).resolves.toBeNull();
    await expect(
      authenticateEnvironmentWorkSessionBearer({
        token: `${issued.secret.sessionsToken}tampered`,
        method: "GET",
        path: "/v1/sessions/session_01",
        crypto,
        now: () => now,
      }),
    ).resolves.toBeNull();
  });
});
