import { describe, expect, it } from "vitest";
import { resolveCompactionWireInput } from "../src/agents/compaction-wire";

describe("compaction wire normalization", () => {
  it("stores Anthropic context_management shape", () => {
    const result = resolveCompactionWireInput({
      contextManagement: {
        edits: [
          {
            type: "compact_20260112",
            trigger: { type: "input_tokens", value: 200_000 },
            instructions: "Keep tool traces.",
          },
        ],
      },
    });
    expect(result.type).toBe("ok");
    if (result.type !== "ok") return;
    expect(result.patch.compactionWireFormat).toBe("anthropic_context_management");
    expect(result.patch.contextManagement?.edits[0]?.type).toBe("compact_20260112");
  });

  it("stores OpenAI model_settings shape", () => {
    const result = resolveCompactionWireInput({
      openaiModelSettings: {
        max_tokens: 16_384,
        context_management: [{ type: "compaction", compact_threshold: 220_000 }],
      },
    });
    expect(result.type).toBe("ok");
    if (result.type !== "ok") return;
    expect(result.patch.compactionWireFormat).toBe("openai_model_settings");
    expect(result.patch.openaiModelSettings?.context_management?.[0]?.compact_threshold).toBe(
      220_000,
    );
  });

  it("rejects conflicting compaction thresholds", () => {
    const result = resolveCompactionWireInput({
      contextManagement: {
        edits: [{ type: "compact", trigger: { type: "input_tokens", value: 100 } }],
      },
      openaiModelSettings: {
        context_management: [{ type: "compaction", compact_threshold: 200 }],
      },
    });
    expect(result).toEqual({
      type: "error",
      message:
        "Conflicting compaction thresholds between _oma.context_management and _oma.model_settings",
    });
  });

  it("rejects dual compaction definitions even when thresholds match", () => {
    const result = resolveCompactionWireInput({
      contextManagement: {
        edits: [{ type: "compact", trigger: { type: "input_tokens", value: 200 } }],
      },
      openaiModelSettings: {
        context_management: [{ type: "compaction", compact_threshold: 200 }],
      },
    });
    expect(result).toEqual({
      type: "error",
      message:
        "Provide compaction via either _oma.context_management or _oma.model_settings, not both",
    });
  });
});
