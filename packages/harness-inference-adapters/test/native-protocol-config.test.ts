import { describe, expect, it } from "vitest";
import {
  INFERENCE_PROTOCOL_PROXY_PATH,
  selectInferenceProtocol,
  type InferenceWireProtocol,
} from "@open-managed-agents/acp-runtime/inference-config";

import {
  kimiCodeInferenceAdapter,
  opencodeInferenceAdapter,
  geminiInferenceAdapter,
} from "../src/index.js";
import { planFor, PROXY, assertNoSecretInFiles } from "./helpers.js";

const protocols: InferenceWireProtocol[] = [
  "anthropic-messages", "openai-responses", "gemini",
];
const endpointFor = (protocol: InferenceWireProtocol) => ({
  protocol,
  proxyPathSegment: INFERENCE_PROTOCOL_PROXY_PATH[protocol],
  upstreamBaseUrl: "https://upstream.invalid",
});
const plan = (adapter: typeof kimiCodeInferenceAdapter, protocol: InferenceWireProtocol) =>
  planFor(adapter, {
    agent: { id: adapter.id, command: adapter.id },
    nativePath: "/native/test",
    providerId: "custom",
    wireModel: "chosen-model",
    endpoints: [endpointFor(protocol)],
  });

describe("native protocol configuration contracts", () => {
  it.each(protocols)("Kimi config uses native %s without env-model override", (protocol) => {
    const p = plan(kimiCodeInferenceAdapter, protocol);
    expect(p.protocol).toBe(protocol);
    const type = {
      "anthropic-messages": "anthropic",
      "openai-responses": "openai_responses",
      gemini: "google-genai",
    }[protocol];
    const config = p.files.find((f) => f.path.endsWith("/config.toml"))!;
    expect(config.content).toContain(`type = "${type}"`);
    expect(config.content).toContain('model = "chosen-model"');
    expect(config.content).toContain('api_key_env = "HOSTED_INFERENCE_TOKEN"');
    // This required field preserves the former upstream env-model default.
    expect(config.content).toContain("max_context_size = 262144");
    expect(config.content).toContain(PROXY.proxyBaseUrl + "/" + INFERENCE_PROTOCOL_PROXY_PATH[protocol]);
    expect(p.unsetEnv).toContain("KIMI_MODEL_NAME");
    expect(p.env.KIMI_MODEL_NAME).toBeUndefined();
    assertNoSecretInFiles(p.files, PROXY.proxyToken);
  });

  it.each(protocols)("OpenCode v1 selects native SDK for %s", (protocol) => {
    const p = plan(opencodeInferenceAdapter, protocol);
    expect(p.protocol).toBe(protocol);
    const c = JSON.parse(p.env.OPENCODE_CONFIG_CONTENT!);
    expect(c.provider.oma.npm).toBe({
      "anthropic-messages": "@ai-sdk/anthropic",
      "openai-responses": "@ai-sdk/openai",
      gemini: "@ai-sdk/google",
    }[protocol]);
    // A custom provider needs a model entry: selecting oma/<id> alone is insufficient.
    expect(c.provider.oma.models["chosen-model"].name).toBe("chosen-model");
    expect(c.provider.oma.options.baseURL).toBe(PROXY.proxyBaseUrl + "/" + INFERENCE_PROTOCOL_PROXY_PATH[protocol]);
    expect(c.provider.oma.options.apiKey).toBe("{env:HOSTED_INFERENCE_TOKEN}");
    expect(c.model).toBe("oma/chosen-model");
    expect(p.env.OPENCODE_CONFIG_CONTENT).not.toContain(PROXY.proxyToken);
  });

  it.each([kimiCodeInferenceAdapter, opencodeInferenceAdapter])("$id prefers Messages and rejects no intersection", (adapter) => {
    expect(selectInferenceProtocol(adapter, [...protocols].reverse().map(endpointFor)).protocol)
      .toBe("anthropic-messages");
    expect(() => selectInferenceProtocol(adapter, [])).toThrow();
  });

  it("Gemini header parser receives a scoped bearer, not unsupported interpolation", () => {
    const p = plan(geminiInferenceAdapter, "gemini");
    const header = p.env.GEMINI_CLI_CUSTOM_HEADERS!;
    // Upstream customHeaderUtils slices the first colon; it does not interpolate env references.
    expect(header.slice(header.indexOf(":") + 1).trim()).toBe(`Bearer ${PROXY.proxyToken}`);
    assertNoSecretInFiles(p.files, PROXY.proxyToken);
  });
});
