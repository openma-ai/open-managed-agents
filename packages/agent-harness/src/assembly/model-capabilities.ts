import type { Api, Model } from "@earendil-works/pi-ai";

/**
 * Whether the model's transport can declare tools mid-conversation without resending the tool list
 * (Anthropic `tool_addition` blocks, or OpenAI-compatible system messages with `tools`).
 *
 * Mirrors the compat flags pi-ai checks when it serializes transcript tool changes, so the assembly
 * picks native loading exactly when pi-ai would send native tool changes. Without them pi-ai resends
 * the whole tool list, which invalidates the cached prompt prefix on every load.
 */
export function supportsNativeToolLoading(model: Model<Api>): boolean {
  const compat = (model.compat ?? {}) as {
    supportsMidConvoSystemMessages?: boolean;
    supportsMidConvoToolChanges?: boolean;
    supportsMidConvoToolAdditions?: boolean;
  };
  if (compat.supportsMidConvoSystemMessages !== true) return false;
  return compat.supportsMidConvoToolChanges === true || compat.supportsMidConvoToolAdditions === true;
}
