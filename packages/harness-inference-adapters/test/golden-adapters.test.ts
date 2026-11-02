import { describe, expect, it } from "vitest";

import {
  claudeInferenceAdapter,
  codexInferenceAdapter,
  dshInferenceAdapter,
  geminiInferenceAdapter,
  kimiCodeInferenceAdapter,
  opencodeInferenceAdapter,
  piInferenceAdapter,
} from "../src/index.js";
import {
  assertNoSecretInFiles,
  DEEPSEEK_ENDPOINTS,
  OPENAI_ENDPOINTS,
  planFor,
  PROXY,
} from "./helpers.js";
import { resolveProtocolEndpointsFromModelCard } from "../src/endpoint-catalog.js";
import { projectHostedInferenceForAcpAgent } from "@open-managed-agents/acp-runtime/inference-config";
import { InferenceConfigAdapterRegistry } from "@open-managed-agents/acp-runtime/inference-config";
import { InferenceProtocolUnsupportedError } from "@open-managed-agents/acp-runtime/inference-config";

describe("golden harness inference adapters", () => {
  it("pi", () => {
    const plan = planFor(piInferenceAdapter, {
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      endpoints: DEEPSEEK_ENDPOINTS,
      wireModel: "deepseek-chat",
      providerId: "deepseek",
    });
    expect(plan.env).toEqual({ PI_ACP_MODEL: "deepseek/deepseek-chat" });
    expect(plan.files[0]?.content).toContain("/openai/v1");
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("dsh", () => {
    const plan = planFor(dshInferenceAdapter, {
      agent: { id: "dsh-acp", command: "dsh-acp" },
      nativePath: "/native/dsh",
      endpoints: DEEPSEEK_ENDPOINTS,
      wireModel: "deepseek-chat",
      providerId: "deepseek",
    });
    expect(plan.env.DEEPSEEK_BASE_URL).toContain("/anthropic");
    expect(plan.env.DEEPSEEK_API_KEY).toBe(PROXY.proxyToken);
    expect(plan.env.DSH_MODEL).toBe("deepseek-chat");
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("claude", () => {
    const plan = planFor(claudeInferenceAdapter, {
      agent: { id: "claude-acp", command: "claude-acp" },
      nativePath: "/native/claude",
      endpoints: [{
        protocol: "anthropic-messages",
        proxyPathSegment: "anthropic",
        upstreamBaseUrl: "https://api.anthropic.com",
      }],
      wireModel: "claude-sonnet-4-6",
      providerId: "anthropic",
    });
    expect(plan.unsetEnv).toContain("ANTHROPIC_API_KEY");
    expect(plan.env.ANTHROPIC_AUTH_TOKEN).toBe(PROXY.proxyToken);
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("codex", () => {
    const plan = planFor(codexInferenceAdapter, {
      agent: { id: "codex-acp", command: "codex-acp" },
      nativePath: "/native/codex",
      endpoints: OPENAI_ENDPOINTS,
      wireModel: "gpt-5",
      providerId: "openai",
    });
    expect(plan.files[0]?.content).toContain('env_key = "HOSTED_INFERENCE_TOKEN"');
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("gemini", () => {
    const plan = planFor(geminiInferenceAdapter, {
      agent: { id: "gemini", command: "gemini" },
      nativePath: "/native/gemini",
      endpoints: [{
        protocol: "gemini",
        proxyPathSegment: "gemini",
        upstreamBaseUrl: "https://generativelanguage.googleapis.com",
      }],
      wireModel: "gemini-2.5",
      providerId: "google",
    });
    expect(plan.env.GEMINI_API_KEY).toBe("");
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("opencode", () => {
    const plan = planFor(opencodeInferenceAdapter, {
      agent: { id: "opencode", command: "opencode" },
      nativePath: "/native/opencode",
      endpoints: DEEPSEEK_ENDPOINTS,
      wireModel: "deepseek-chat",
      providerId: "deepseek",
    });
    expect(plan.env.OPENCODE_CONFIG_CONTENT).toContain("{env:HOSTED_INFERENCE_TOKEN}");
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  it("kimi-code", () => {
    const plan = planFor(kimiCodeInferenceAdapter, {
      agent: { id: "kimi-code", command: "kimi-code" },
      nativePath: "/native/kimi",
      endpoints: DEEPSEEK_ENDPOINTS,
      wireModel: "deepseek-chat",
      providerId: "deepseek",
    });
    expect(plan.env.KIMI_MODEL_API_KEY).toBe(PROXY.proxyToken);
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });
});

describe("endpoint catalog", () => {
  it("resolves DeepSeek dual-protocol endpoints from model card fields", () => {
    const endpoints = resolveProtocolEndpointsFromModelCard({
      providerId: "deepseek",
      baseUrl: null,
    });
    expect(endpoints.map((item) => item.protocol).sort()).toEqual([
      "anthropic-messages",
      "openai-chat",
    ]);
    expect(endpoints.find((item) => item.protocol === "anthropic-messages")?.upstreamBaseUrl)
      .toBe("https://api.deepseek.com/anthropic");
  });

  it("fails codex projection for DeepSeek cards", () => {
    const registry = new InferenceConfigAdapterRegistry();
    registry.register(codexInferenceAdapter);
    expect(() => projectHostedInferenceForAcpAgent({
      sessionId: "s",
      gatewayBaseUrl: "https://api.openma.test",
      sessionsToken: "token",
      env: {},
      agent: { id: "codex-acp", command: "codex-acp" },
      nativePath: "/n",
      target: {
        wireModel: "deepseek-chat",
        providerId: "deepseek",
        protocolEndpoints: resolveProtocolEndpointsFromModelCard({
          providerId: "deepseek",
          baseUrl: null,
        }),
      },
      adapterRegistry: registry,
    })).toThrow(InferenceProtocolUnsupportedError);
  });
});
