import type {
  Model,
  ModelsApplicationPort,
} from "../src/index";

export const modelView = {
  id: "claude-opus-5",
  allowedFallbackModels: null,
  capabilities: null,
  createdAt: "2026-08-20T00:00:00.000Z",
  displayName: "Claude Opus 5",
  maxInputTokens: null,
  maxTokens: null,
} satisfies Model;

export function makeModelsPort(
  overrides: Partial<ModelsApplicationPort>,
): ModelsApplicationPort {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected Models port call: ${name}`);
  };
  return {
    retrieveModel: unexpected("retrieveModel"),
    listModels: unexpected("listModels"),
    ...overrides,
  } as ModelsApplicationPort;
}
