import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("root Cloudflare test discovery excludes generated and Node-only trees", () => {
  const buildDir = mkdtempSync(join(repoRoot, "apps/agent/build-vitest-discovery-"));
  const fixturePath = join(buildDir, "generated-artifact.test.ts");
  const relativeFixturePath = relative(repoRoot, fixturePath).split(sep).join("/");

  try {
    writeFileSync(
      fixturePath,
      'import { test } from "vitest";\ntest("generated artifact", () => {});\n',
    );

    const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const result = spawnSync(
      pnpm,
      ["exec", "vitest", "list", "--filesOnly", "--staticParse"],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const collectedFiles = result.stdout.split(/\r?\n/).filter(Boolean);
    assert.ok(
      !collectedFiles.includes(relativeFixturePath),
      `generated test artifact was collected by the root Cloudflare test project: ${relativeFixturePath}`,
    );
    const nodeOnlyAcpTests = collectedFiles.filter((path) =>
      path.startsWith("packages/acp-runtime/"),
    );
    assert.deepEqual(
      nodeOnlyAcpTests,
      [],
      `Node-only ACP runtime tests were collected by the root Cloudflare test project: ${nodeOnlyAcpTests.join(", ")}`,
    );
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
});
