import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { HarnessContext, HarnessRuntime } from "../src/harness/interface";
import { createPiToolAssembly } from "../src/harness/assembly/adapters/pi";
import { SKILL_ASSEMBLY_WARNING_SOURCE } from "../src/harness/assembly/loaded-skills-state";

describe("Pi assembly skill mounts", () => {
  it("uses progressive skill section instead of inlined bodies", () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const events: never[] = [];
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: vi.fn() },
      sandbox: {},
      broadcast: vi.fn(),
      broadcastStreamStart: vi.fn(),
      broadcastChunk: vi.fn(),
      broadcastStreamEnd: vi.fn(),
      broadcastThinkingStart: vi.fn(),
      broadcastThinkingChunk: vi.fn(),
      broadcastThinkingEnd: vi.fn(),
      broadcastToolInputStart: vi.fn(),
      broadcastToolInputChunk: vi.fn(),
      broadcastToolInputEnd: vi.fn(),
      reportUsage: vi.fn(),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;

    const ctx = {
      agent: {
        id: "agent-test",
        model: faux.getModel().id,
        metadata: { skill_mount: "progressive" },
      },
      userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      session_id: "session-test",
      tools: {
        read: {
          description: "Read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
      },
      model: {} as HarnessContext["model"],
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Base agent prompt.",
      skillMounts: [{
        skillId: "skill_demo",
        name: "Demo Skill",
        description: "A demo",
        mountRoot: "/workspace/.openma/skills/skill_demo/latest/",
        body: "SECRET_SKILL_BODY",
        source: "custom",
      }],
      env: {},
      runtime,
    } as unknown as HarnessContext;

    const assembly = createPiToolAssembly(ctx);
    expect(assembly.systemPrompt).toContain("<available-skills>");
    expect(assembly.systemPrompt).not.toContain("SECRET_SKILL_BODY");
    expect(assembly.systemPrompt).toContain("Base agent prompt.");
  });

  it("exposes tool_search when budgeted mode defers skills without MCP tools", () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const events: never[] = [];
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: vi.fn() },
      sandbox: {},
      broadcast: vi.fn(),
      broadcastStreamStart: vi.fn(),
      broadcastChunk: vi.fn(),
      broadcastStreamEnd: vi.fn(),
      broadcastThinkingStart: vi.fn(),
      broadcastThinkingChunk: vi.fn(),
      broadcastThinkingEnd: vi.fn(),
      broadcastToolInputStart: vi.fn(),
      broadcastToolInputChunk: vi.fn(),
      broadcastToolInputEnd: vi.fn(),
      reportUsage: vi.fn(),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;

    const heavyMounts = Array.from({ length: 4 }, (_, i) => ({
      skillId: `skill_${i}`,
      name: `Skill ${i}`,
      description: "x".repeat(3_500),
      mountRoot: `/workspace/.openma/skills/skill_${i}/latest/`,
      body: `# Skill ${i}`,
      source: "custom" as const,
    }));

    const ctx = {
      agent: {
        id: "agent-test",
        model: faux.getModel().id,
        metadata: { skill_mount: "budgeted", skill_list_budget: 0.01 },
      },
      userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      session_id: "session-test",
      tools: {
        read: {
          description: "Read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
      },
      model: {} as HarnessContext["model"],
      pi: { models, model: { ...faux.getModel(), contextWindow: 2_000 }, thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Base.",
      skillMounts: heavyMounts,
      env: {},
      runtime,
    } as unknown as HarnessContext;

    const assembly = createPiToolAssembly(ctx);
    expect(assembly.initialTools.map((t) => t.name)).toContain("tool_search");
  });

  it("skill tool loads body and persists via session.warning", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const events: SessionEvent[] = [];
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: (e: SessionEvent) => events.push(e) },
      sandbox: {},
      broadcast: (e: SessionEvent) => events.push(e),
      broadcastStreamStart: vi.fn(),
      broadcastChunk: vi.fn(),
      broadcastStreamEnd: vi.fn(),
      broadcastThinkingStart: vi.fn(),
      broadcastThinkingChunk: vi.fn(),
      broadcastThinkingEnd: vi.fn(),
      broadcastToolInputStart: vi.fn(),
      broadcastToolInputChunk: vi.fn(),
      broadcastToolInputEnd: vi.fn(),
      reportUsage: vi.fn(),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;

    const ctx = {
      agent: {
        id: "agent-test",
        model: faux.getModel().id,
        metadata: { skill_mount: "tool" },
      },
      userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      session_id: "session-test",
      tools: {
        read: {
          description: "Read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
      },
      model: {} as HarnessContext["model"],
      pi: { models, model: faux.getModel(), thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Base.",
      skillMounts: [{
        skillId: "skill_tool",
        name: "Tool Skill",
        description: "desc",
        mountRoot: "/workspace/.openma/skills/skill_tool/latest/",
        body: "INLINE_SKILL_BODY",
        source: "custom",
      }],
      env: {},
      runtime,
    } as unknown as HarnessContext;

    const assembly = createPiToolAssembly(ctx);
    const skillTool = assembly.initialTools.find((t) => t.name === "skill");
    expect(skillTool?.execute).toBeTypeOf("function");
    const result = await skillTool!.execute!("call-1", { skill_id: "skill_tool" });
    expect(result.content[0]).toMatchObject({ type: "text", text: "INLINE_SKILL_BODY" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "session.warning",
      source: SKILL_ASSEMBLY_WARNING_SOURCE,
      details: { loadedSkillIds: ["skill_tool"] },
    }));
  });

  it("tool_search on deferred skill without body includes Read path", async () => {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const models = createModels();
    models.setProvider(faux.provider);
    const events: SessionEvent[] = [];
    const runtime = {
      history: { getEvents: () => events, getMessages: () => [], append: (e: SessionEvent) => events.push(e) },
      sandbox: {},
      broadcast: (e: SessionEvent) => events.push(e),
      broadcastStreamStart: vi.fn(),
      broadcastChunk: vi.fn(),
      broadcastStreamEnd: vi.fn(),
      broadcastThinkingStart: vi.fn(),
      broadcastThinkingChunk: vi.fn(),
      broadcastThinkingEnd: vi.fn(),
      broadcastToolInputStart: vi.fn(),
      broadcastToolInputChunk: vi.fn(),
      broadcastToolInputEnd: vi.fn(),
      reportUsage: vi.fn(),
      pendingConfirmations: [],
    } as unknown as HarnessRuntime;

    const mountRoot = "/workspace/.openma/skills/skill_deferred/latest/";
    const ctx = {
      agent: {
        id: "agent-test",
        model: faux.getModel().id,
        metadata: { skill_mount: "budgeted", skill_list_budget: 0.005 },
      },
      userMessage: { type: "user.message", content: [{ type: "text", text: "hi" }] },
      session_id: "session-test",
      tools: {
        read: {
          description: "Read",
          inputSchema: z.object({ path: z.string() }),
          execute: async () => "ok",
        },
      },
      model: {} as HarnessContext["model"],
      pi: { models, model: { ...faux.getModel(), contextWindow: 1_500 }, thinkingLevel: "off", speed: "standard" },
      systemPrompt: "Base.",
      skillMounts: [
        {
          skillId: "skill_listed",
          name: "Listed",
          description: "short",
          mountRoot: "/workspace/.openma/skills/skill_listed/latest/",
          source: "custom",
        },
        {
          skillId: "skill_deferred",
          name: "Deferred",
          description: "y".repeat(4_000),
          mountRoot,
          source: "custom",
        },
      ],
      env: {},
      runtime,
    } as unknown as HarnessContext;

    const assembly = createPiToolAssembly(ctx);
    const search = assembly.initialTools.find((t) => t.name === "tool_search");
    const out = await search!.execute!("call-2", { query: "select:skill__skill_deferred" });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain(`Read: \`${mountRoot}SKILL.md\``);
  });
});
