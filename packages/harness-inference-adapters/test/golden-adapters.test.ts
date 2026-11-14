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

describe("golden harness inference adapters", () => {
  it("pi", () => {
    const plan = planFor(piInferenceAdapter, {
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      endpoints: DEEPSEEK_ENDPOINTS,
      wireModel: "deepseek-chat",
      providerId: "deepseek",
    });
    expect(plan.env).toEqual({});
    expect(plan.files[0]?.content).toContain("/anthropic");
    expect(JSON.parse(plan.files[0]!.content).providers.deepseek.api).toBe("anthropic-messages");
    assertNoSecretInFiles(plan.files, PROXY.proxyToken);
  });

  // e2e 42d7c785 (session_hLxyQiRfRNX8Gc2KS7wh8): pi sent the literal
  // "{env:HOSTED_INFERENCE_TOKEN}" as its bearer and ignored PI_ACP_MODEL, so
  // the turn ended with only pi-acp's banner and no model output.
  it.each([
    ["deepseek", "deepseek-v4-flash", "deepseek"],
    ["openai", "gpt-5", "oma-hosted"],
  ])("pi reads the gateway token from env and the upstream model from settings (%s)", (providerId, wireModel, piProvider) => {
    const plan = planFor(piInferenceAdapter, {
      agent: { id: "pi-acp", command: "pi-acp" },
      nativePath: "/native/pi",
      endpoints: providerId === "deepseek" ? DEEPSEEK_ENDPOINTS : OPENAI_ENDPOINTS,
      wireModel,
      providerId,
    });
    const file = (name: string) => JSON.parse(plan.files.find((f) => f.path === `/native/pi/home/.pi/agent/${name}`)!.content);
    // pi interpolates only $VAR / ${VAR} (docs/models.md "Value Resolution").
    expect(file("models.json").providers[piProvider].apiKey).toBe("$HOSTED_INFERENCE_TOKEN");
    expect(file("settings.json")).toEqual({ defaultProvider: piProvider, defaultModel: wireModel, quietStartup: true });
    if (piProvider === "oma-hosted") expect(file("models.json").providers[piProvider].models).toEqual([{ id: wireModel }]);
    else expect(file("models.json").providers[piProvider].models).toBeUndefined();
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
    expect(plan.files[0]?.content).toContain('api_key_env = "HOSTED_INFERENCE_TOKEN"');
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
      "openai-responses",
    ]);
    expect(endpoints.find((item) => item.protocol === "anthropic-messages")?.upstreamBaseUrl)
      .toBe("https://api.deepseek.com/anthropic");
  });

  it("projects the Responses endpoint for DeepSeek cards", () => {
    const registry = new InferenceConfigAdapterRegistry();
    registry.register(codexInferenceAdapter);
    expect(projectHostedInferenceForAcpAgent({
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
    }).files[0]?.content).toContain('wire_api = "responses"');
  });
});
