import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Approved for test/live scaffolding; this is not the production model catalog.
export const ALLOWED_DEEPSEEK_TEST_MODELS = Object.freeze(["deepseek-flash"]);

/** Validate wire ids, including provider-qualified ids used by ACP. */
export function assertAllowedTestModel(provider, model) {
  const providerId = String(provider ?? "").trim().toLowerCase();
  const modelId = String(model ?? "");
  const isDeepSeek = providerId === "deepseek" || providerId === "deepseek-official"
    || /(^|\/)deepseek(?:-|\/)/i.test(modelId.trim());
  if (!isDeepSeek) return;

  const wireId = modelId.startsWith("deepseek/") ? modelId.slice("deepseek/".length) : modelId;
  if (!ALLOWED_DEEPSEEK_TEST_MODELS.includes(wireId)) {
    throw new Error(
      `Disallowed DeepSeek test model ${JSON.stringify(model)} (provider: ${providerId || "inferred"}). `
      + `Allowed DeepSeek test models: ${ALLOWED_DEEPSEEK_TEST_MODELS.join(", ")}.`,
    );
  }
}

export function resolveDeepSeekTestModel(env = process.env) {
  const model = env.PROBE_MODEL ?? ALLOWED_DEEPSEEK_TEST_MODELS[0];
  assertAllowedTestModel("deepseek", model);
  return model.replace(/^deepseek\//, "");
}

/** Check explicit E2E overrides before even a health check or backend startup. */
export function assertTestModelEnvironment(env = process.env) {
  if (env.OMA_E2E_MODEL !== undefined) assertAllowedTestModel(env.OMA_E2E_PROVIDER, env.OMA_E2E_MODEL);
  if (env.PROBE_MODEL !== undefined) assertAllowedTestModel(undefined, env.PROBE_MODEL);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (process.argv[2] === "--check-env") {
      assertTestModelEnvironment();
    } else if (process.argv[2] === "--check" && process.argv.length === 5) {
      assertAllowedTestModel(process.argv[3], process.argv[4]);
    } else {
      throw new Error("Usage: test-model-allowlist.mjs --check <provider> <model> | --check-env");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
