/** Read OMA agent model extensions from harness / legacy API shapes. */
export interface HarnessAgentModelSettings {
  maxTokens?: number;
}

export function readHarnessAgentModelSettings(
  model: unknown,
): HarnessAgentModelSettings | undefined {
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }
  const record = model as Record<string, unknown>;
  const maxTokens =
    typeof record.max_tokens === "number"
      ? record.max_tokens
      : typeof record.maxTokens === "number"
        ? record.maxTokens
        : undefined;
  if (maxTokens === undefined) return undefined;
  return { maxTokens };
}
