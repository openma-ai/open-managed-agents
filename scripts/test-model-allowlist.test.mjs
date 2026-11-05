import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_DEEPSEEK_TEST_MODELS,
  assertAllowedTestModel,
  assertTestModelEnvironment,
  resolveDeepSeekTestModel,
} from "./lib/test-model-allowlist.mjs";
import { runDeepSeekCertification } from "./deepseek-live-certification.mjs";
import { runHarnessInSandboxCertification } from "./harness-in-sandbox-live-certification.mjs";
import { resolveLiveConfig } from "./backchat-live-config.mjs";
import { runLiveCertification } from "./live-certification.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// Construct negative cases so the scanner can enforce even its own source.
const rejectedModels = ["chat", "reasoner", "v4-flash", "v4-pro", "future-model"].map((id) => `deepseek-${id}`);

test("only the approved DeepSeek wire id is allowed, including ACP qualification", () => {
  assert.deepEqual(ALLOWED_DEEPSEEK_TEST_MODELS, ["deepseek-flash"]);
  assert.ok(Object.isFrozen(ALLOWED_DEEPSEEK_TEST_MODELS));
  for (const provider of ["deepseek", "DEEPSEEK", "deepseek-official", "oai-compatible", undefined]) {
    assert.doesNotThrow(() => assertAllowedTestModel(provider, "deepseek-flash"));
    assert.doesNotThrow(() => assertAllowedTestModel(provider, "deepseek/deepseek-flash"));
    for (const model of rejectedModels) {
      for (const id of [model, `deepseek/${model}`]) {
        assert.throws(() => assertAllowedTestModel(provider, id), /Disallowed DeepSeek test model.*Allowed DeepSeek test models: deepseek-flash/);
      }
    }
  }
});

test("DeepSeek cannot escape the guard via empty, unknown, padded or case-altered ids", () => {
  for (const model of [undefined, null, "", "gpt-5", "deepseek-flash ", "deepseek-flash".toUpperCase(), "deepseek-flash/other"]) {
    assert.throws(() => assertAllowedTestModel("deepseek", model), /Disallowed DeepSeek test model/);
  }
  assert.throws(() => assertAllowedTestModel("oai-compatible", `proxy/${rejectedModels[0]}`));
  assert.throws(() => assertAllowedTestModel(undefined, ` ${rejectedModels[0]} `));
});

test("other providers and opaque model-card handles remain usable", () => {
  for (const [provider, model] of [["anthropic", "claude-sonnet-4-6"], ["openai", "gpt-5"], [undefined, "workspace-main"], ["ant-compatible", "openma-e2e-mock"]]) {
    assert.doesNotThrow(() => assertAllowedTestModel(provider, model));
  }
  assert.equal(resolveDeepSeekTestModel({}), "deepseek-flash");
  assert.equal(resolveDeepSeekTestModel({ PROBE_MODEL: "deepseek-flash" }), "deepseek-flash");
  assert.equal(resolveDeepSeekTestModel({ PROBE_MODEL: "deepseek/deepseek-flash" }), "deepseek-flash");
  assert.throws(() => resolveDeepSeekTestModel({ PROBE_MODEL: "" }));
  assert.doesNotThrow(() => assertTestModelEnvironment({}));
  assert.doesNotThrow(() => assertTestModelEnvironment({ OMA_E2E_MODEL: "deepseek-flash", PROBE_MODEL: "deepseek-flash" }));
});

test("environment overrides and orchestrators reject before credentials or child commands", async () => {
  for (const model of rejectedModels) {
    assert.throws(() => assertTestModelEnvironment({ OMA_E2E_MODEL: model }));
    assert.throws(() => assertTestModelEnvironment({ PROBE_MODEL: model }));
    for (const run of [runDeepSeekCertification, runHarnessInSandboxCertification]) {
      await assert.rejects(run({ env: { PROBE_MODEL: model, PATH: "" } }), /Disallowed DeepSeek test model/);
    }
    await assert.rejects(runLiveCertification({
      env: { PROBE_MODEL: model },
      lanes: [{ provider: "fixture", credentialRequirements: [], command: ["must-not-run"] }],
      execute: () => assert.fail("must reject before starting any certification lane"),
    }), /Disallowed DeepSeek test model/);
    assert.throws(() => resolveLiveConfig({ baseUrl: "http://localhost", model }, {}), /Disallowed DeepSeek test model/);
  }
});

test("direct live entrypoints validate without credentials or runtime dependencies", () => {
  const scripts = [
    "scripts/deepseek-live-certification.mjs",
    "scripts/harness-in-sandbox-live-certification.mjs",
    "scripts/probe-pi-deepseek-compaction-cache.ts",
    "apps/main-node/scripts/acp-deepseek-native-cache.e2e.ts",
    "apps/main-node/scripts/pi-deepseek-harness.e2e.ts",
    "apps/main-node/scripts/pi-acp-deepseek-docker.e2e.ts",
    "apps/main-node/scripts/pi-acp-deepseek-sprites.e2e.ts",
  ];
  for (const script of scripts) {
    for (const [model, status] of [["deepseek-flash", 0], [rejectedModels[0], 1]]) {
      const result = spawnSync(process.execPath, [join(root, script), "--check"], {
        env: { PATH: process.env.PATH, PROBE_MODEL: model }, encoding: "utf8",
      });
      assert.equal(result.status, status, `${script}: ${result.stderr}`);
      if (status) assert.match(result.stderr, /Disallowed DeepSeek test model/);
    }
  }
});

test("MCode validates its model before preparing a profile or reading credentials", async () => {
  const { buildMcodeDeepSeekConfig, getLiveHarnessProfile } = await import("../apps/main-node/scripts/harness-in-sandbox/live-profiles.ts");
  const previous = process.env.PROBE_MODEL;
  try {
    process.env.PROBE_MODEL = rejectedModels[0];
    assert.throws(() => getLiveHarnessProfile("mcode", "/tmp/native"), /Disallowed DeepSeek test model/);
    assert.throws(() => buildMcodeDeepSeekConfig(""), /Disallowed DeepSeek test model/);
  } finally {
    if (previous === undefined) delete process.env.PROBE_MODEL;
    else process.env.PROBE_MODEL = previous;
  }
});

test("shell entrypoints fail before curl or backend startup, even without credentials", () => {
  for (const script of ["start-local-backend.sh", "release-gate.sh"]) {
    const result = spawnSync("bash", [join(root, "test/e2e", script), "--check"], {
      cwd: "/tmp",
      env: { PATH: process.env.PATH, OMA_E2E_MODEL: rejectedModels[0] },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Disallowed DeepSeek test model/);
    assert.doesNotMatch(result.stdout, /validated|ready/);
  }
});

// These exact tokens name a provider, a certification lane, a repository, or
// script files, not model ids. No model families/prefixes are exempted.
const nonModelReferences = new Set([
  "deepseek-official",
  "deepseek-model",
  "deepseek-harness-acp",
  "deepseek-live-certification.mjs",
  "deepseek-live-certification.test.mjs",
]);

function violations(source) {
  return source.split(/\r?\n/).flatMap((line, index) =>
    [...line.matchAll(/(?<![\w.-])deepseek-[a-z0-9.-]+/gi)]
      .filter((match) => {
        const [id] = match;
        if (ALLOWED_DEEPSEEK_TEST_MODELS.includes(id)) return false;
        // A reference exception must never exempt an actual model field.
        const before = line.slice(0, match.index);
        const modelField = /(?:(?:model|wireModel|modelId|model_id|id)["']?\s*[:=]\s*["']?|--model["']\s*,\s*["'])(?:deepseek\/)?$/i.test(before);
        return modelField || !nonModelReferences.has(id);
      })
      .map(([id]) => `${index + 1}: ${id}`));
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // Never follow symlinks into dependencies or another checkout.
    if (entry.isDirectory()) {
      return ["node_modules", ".git", "dist", ".wrangler", "coverage", "artifacts"].includes(entry.name) ? [] : files(path);
    }
    return entry.isFile() ? [path] : [];
  });
}

test("scanner catches arbitrary model ids in literals, qualified ids and YAML", () => {
  for (const model of rejectedModels) {
    assert.equal(violations(`model: "${model}"\nmodel: deepseek/${model}\n${model}: {}`).length, 3);
  }
  assert.deepEqual(violations('model: "deepseek-flash"'), []);
  for (const reference of nonModelReferences) {
    assert.equal(violations(`model: "${reference}"`).length, 1);
    assert.equal(violations(`["--model", "${reference}"]`).length, 1);
  }
});

test("all test and live scaffolding uses approved DeepSeek model ids", () => {
  const roots = [join(root, "test"), join(root, "scripts")];
  for (const group of ["apps", "packages"]) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const parent = join(root, group, entry.name);
      for (const child of readdirSync(parent, { withFileTypes: true })) {
        if (child.isDirectory() && ["test", "tests", "scripts"].includes(child.name)) roots.push(join(parent, child.name));
      }
    }
  }
  const failures = roots.flatMap(files).flatMap((path) =>
    violations(readFileSync(path, "utf8")).map((failure) => `${relative(root, path)}:${failure}`));
  assert.deepEqual(failures, [], `Disallowed DeepSeek model ids in test scaffolding:\n${failures.join("\n")}`);
});
