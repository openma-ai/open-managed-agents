import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classificationOf, classificationRules, evaluateRatchets, importSpecifiers, isSessionPackageDirectory, lineCount, main,
  packageImportCounts, tightenBaseline,
} from "./check-session-ratchets.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseline = () => ({
  maxLines: { "host.ts": 10 },
  agentImports: { package: "packages/node", specifier: "@x/agent", maxPerFile: { "src/a.ts": 2 } },
  unclassifiedPackages: ["packages/session-old"],
});
const current = (overrides = {}) => ({
  lines: { "host.ts": 10 },
  agentImports: { "src/a.ts": 2 },
  sessionPackages: ["packages/session-core", "packages/session-old"],
  classification: { "packages/session-core": "CORE_PACKAGES", "packages/session-old": null },
  ...overrides,
});

test("lineCount matches wc -l", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\nb"), 2);
});

test("agent imports are counted per file, every import form, package and subpaths only", () => {
  const sources = {
    "src/a.ts": 'import { x } from "@x/agent/harness";\nexport type { Y } from "@x/agent";\nconst z = await import("@x/agent/runtime");',
    "src/b.ts": 'import { x } from "@x/agent-store";\nimport "./local";',
  };
  assert.deepEqual(importSpecifiers(sources["src/b.ts"]), ["@x/agent-store", "./local"]);
  assert.deepEqual(packageImportCounts(sources, "@x/agent"), { "src/a.ts": 3 });
});

test("classification reads the boundary scripts' lists and adapter prefixes", () => {
  const rules = classificationRules(
    'const CORE_PACKAGES = [\n  "packages/session-core",\n];\nconst PROVIDER_NEUTRAL_PACKAGES = ["packages/sandbox"];\nconst SESSION_ADAPTER_PACKAGES = new Set(["packages/session-core-sql"]);\nconst OTHER_PACKAGES = ["packages/session-x"];',
    'function isProviderAdapterDirectory(name) {\n  if (name.startsWith("sandbox-adapter-")) return true;\n  if (\n    name.startsWith("environment-activation-")\n    && !name.startsWith("environment-activation-store-")\n  ) return true;\n  return false;\n}',
  );
  assert.deepEqual(rules.adapterPrefixes, ["sandbox-adapter-"]);
  assert.equal(classificationOf("packages/session-core", rules), "CORE_PACKAGES");
  assert.equal(classificationOf("packages/sandbox", rules), "PROVIDER_NEUTRAL_PACKAGES");
  assert.equal(classificationOf("packages/session-core-sql", rules), "SESSION_ADAPTER_PACKAGES");
  assert.equal(classificationOf("packages/sandbox-adapter-e2b", rules), "provider adapter (sandbox-adapter-*)");
  assert.equal(classificationOf("packages/session-x", rules), null);
  assert.throws(() => classificationRules("const CORE_PACKAGES = [];", ""), /PROVIDER_NEUTRAL_PACKAGES list not found/u);
});

test("Session package directories are session-*, sandbox and sandbox-*", () => {
  assert.deepEqual(["packages/sandbox", "packages/sandbox-gateway", "packages/session-runtime", "packages/sandboxes", "packages/sessions-store", "packages/shared"]
    .filter(isSessionPackageDirectory), ["packages/sandbox", "packages/sandbox-gateway", "packages/session-runtime"]);
});

test("at the baseline nothing fails or tightens", () => {
  assert.deepEqual(evaluateRatchets(baseline(), current()), { violations: [], tightenings: [] });
});

test("growth fails: host lines, agent imports in a known or new file, an unclassified new package", () => {
  const { violations } = evaluateRatchets(baseline(), current({
    lines: { "host.ts": 11 },
    agentImports: { "src/a.ts": 3, "src/new.ts": 1 },
    sessionPackages: ["packages/session-core", "packages/session-new", "packages/session-old"],
    classification: { "packages/session-core": "CORE_PACKAGES", "packages/session-new": null, "packages/session-old": null },
  }));
  assert.equal(violations.length, 4);
  assert.match(violations[0], /host\.ts: 11 lines, above its ratchet of 10/u);
  assert.match(violations[1], /packages\/node\/src\/a\.ts: 3 import\(s\) of @x\/agent, ratchet 2/u);
  assert.match(violations[2], /packages\/node\/src\/new\.ts: 1 import\(s\) of @x\/agent, ratchet 0/u);
  assert.match(violations[3], /packages\/session-new: unclassified Session package/u);
});

test("shrinking passes with hints, and --update only tightens", () => {
  const shrunk = current({
    lines: { "host.ts": 7 },
    agentImports: {},
    sessionPackages: ["packages/session-core", "packages/session-old"],
    classification: { "packages/session-core": "CORE_PACKAGES", "packages/session-old": "CORE_PACKAGES" },
  });
  const { violations, tightenings } = evaluateRatchets(baseline(), shrunk);
  assert.deepEqual(violations, []);
  assert.equal(tightenings.length, 3);
  assert.deepEqual(tightenBaseline(baseline(), shrunk), {
    maxLines: { "host.ts": 7 },
    agentImports: { package: "packages/node", specifier: "@x/agent", maxPerFile: {} },
    unclassifiedPackages: [],
  });
  // Never loosens: values above the baseline keep the baseline.
  assert.deepEqual(tightenBaseline(baseline(), current({ lines: { "host.ts": 99 }, agentImports: { "src/a.ts": 5 } })).maxLines, { "host.ts": 10 });
});

test("the gate reads this repository: the recorded baseline holds", () => {
  const output = [];
  const log = console.log;
  console.log = (line) => output.push(line);
  try {
    main([], repoRoot);
  } finally {
    console.log = log;
  }
  assert.match(output.at(-1), /^Session ratchets passed/u);
});

test("--update rewrites only the baseline file, tighter", () => {
  const root = mkdtempSync(join(tmpdir(), "session-ratchets-"));
  try {
    for (const path of ["scripts/check-core-boundaries.mjs", "scripts/provider-package-boundaries.mjs"]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repoRoot, path), join(root, path));
    }
    mkdirSync(join(root, "packages/session-old"), { recursive: true });
    writeFileSync(join(root, "packages/session-old/package.json"), "{}");
    mkdirSync(join(root, "packages/node/src"), { recursive: true });
    writeFileSync(join(root, "packages/node/src/a.ts"), 'import { x } from "@x/agent/h";\n');
    writeFileSync(join(root, "host.ts"), "one\ntwo\n");
    writeFileSync(join(root, "scripts/session-ratchets.json"), JSON.stringify(baseline()));
    const log = console.log;
    console.log = () => {};
    try {
      main(["--update"], root);
    } finally {
      console.log = log;
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, "scripts/session-ratchets.json"), "utf8")), {
      maxLines: { "host.ts": 2 },
      agentImports: { package: "packages/node", specifier: "@x/agent", maxPerFile: { "src/a.ts": 1 } },
      unclassifiedPackages: ["packages/session-old"],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
