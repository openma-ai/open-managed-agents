import { describe, expect, it } from "vitest";

import type { InferenceConfigAdapter, InferenceProtocolEndpoint } from "../src/inference/types.js";
import {
  InferenceProtocolUnsupportedError,
  selectInferenceProtocol,
} from "../src/inference/index.js";

const deepseekEndpoints: InferenceProtocolEndpoint[] = [
  {
    protocol: "openai-responses",
    proxyPathSegment: "openai/v1",
    upstreamBaseUrl: "https://api.deepseek.com",
  },
  {
    protocol: "anthropic-messages",
    proxyPathSegment: "anthropic",
    upstreamBaseUrl: "https://api.deepseek.com/anthropic",
  },
];
const deepseekWithoutResponses = deepseekEndpoints.filter((endpoint) => endpoint.protocol !== "openai-responses");

const codexStubAdapter: InferenceConfigAdapter = {
  id: "codex",
  supportedProtocols: ["openai-responses"],
  matches: () => true,
  plan: () => ({
    protocol: "openai-responses",
    env: {},
    unsetEnv: [],
    files: [],
  }),
};

describe("selectInferenceProtocol", () => {
  it("prefers Messages when both supported endpoints are present", () => {
    const adapter: InferenceConfigAdapter = {
      id: "test",
      supportedProtocols: ["openai-responses", "anthropic-messages"],
      matches: () => true,
      plan: () => ({
        protocol: "anthropic-messages",
        env: {},
        unsetEnv: [],
        files: [],
      }),
    };
    const endpoints = [...deepseekEndpoints].reverse();
    const selected = selectInferenceProtocol(adapter, endpoints);
    expect(selected.protocol).toBe("anthropic-messages");
  });

  it("fails fast when codex requires responses but DeepSeek lacks it", () => {
    expect(() => selectInferenceProtocol(codexStubAdapter, deepseekWithoutResponses)).toThrow(
      InferenceProtocolUnsupportedError,
    );
  });
});
