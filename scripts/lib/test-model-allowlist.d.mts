export const ALLOWED_DEEPSEEK_TEST_MODELS: readonly string[];
export function assertAllowedTestModel(provider: string | undefined, model: string | undefined): void;
export function resolveDeepSeekTestModel(env?: Record<string, string | undefined>): string;
export function assertTestModelEnvironment(env?: Record<string, string | undefined>): void;
