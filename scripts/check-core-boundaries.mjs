import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import {
  providerPackageBoundaryViolations,
  providerWorkspaceBoundaryViolations,
} from "./provider-package-boundaries.mjs";

const CORE_PACKAGES = [
  "packages/execution-control",
  "packages/managed-agents-domain",
  "packages/managed-agents-application",
  "packages/managed-agents-api",
  "packages/openai-agents-api",
  "packages/openai-agents-compat",
  "packages/managed-agents-app",
  "packages/session-outcomes",
  "packages/session-subagents",
  "packages/sandbox-gateway",
];

const FORBIDDEN_PREFIXES = [
  "cloudflare:",
  "node:",
  "better-sqlite3",
  "postgres",
  "drizzle-orm",
  "@aws-sdk/",
  "@open-managed-agents/managed-agents-adapters-",
  "@open-managed-agents/platform-node",
  "@open-managed-agents/sql-client",
];

const PROVIDER_NEUTRAL_PACKAGES = [
  "packages/sandbox",
  "packages/managed-runtime-sandbox",
];

const PROVIDER_NEUTRAL_ALLOWED_DEPENDENCIES = new Map([
  ["packages/sandbox", new Set([
    "@open-managed-agents/observability",
    // Provider-free, dependency-free vocabulary (ADR 0014 §7).
    "@open-managed-agents/runtime-resource-contract",
    "@open-managed-agents/shared",
  ])],
  ["packages/managed-runtime-sandbox", new Set([
    "@open-managed-agents/blob-store",
    "@open-managed-agents/runtime-resource-contract",
    "@open-managed-agents/sandbox",
    "effect",
  ])],
]);

// Runtime orchestration may use Effect internally, but the dependency must not
// spread into public contracts, provider adapters, or unrelated sandbox code.
const RESTRICTED_NEUTRAL_IMPORTS = new Map([
  ["effect", new Set([
    "packages/managed-runtime-sandbox/src/effect-kernel.ts",
    "packages/managed-runtime-sandbox/src/provider-runtime.ts",
  ])],
]);

const PROVIDER_DEPENDENCY_PREFIXES = [
  "e2b",
  "@daytona/",
  "@daytonaio/",
  "@boxlite-ai/",
  "@cloudflare/sandbox",
  "@open-managed-agents/sandbox-adapter-",
  "@open-managed-agents/managed-runtime-",
];

const violations = [];

for (const packageDirectory of CORE_PACKAGES) {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (isForbidden(dependency)) {
      violations.push(`${packageJsonPath}: dependency ${dependency}`);
    }
  }

  for (const sourcePath of await sourceFiles(join(packageDirectory, "src"))) {
    const source = await readFile(sourcePath, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (isForbidden(specifier)) violations.push(`${sourcePath}: import ${specifier}`);
    }
  }
}

for (const packageDirectory of PROVIDER_NEUTRAL_PACKAGES) {
  const packageJsonPath = join(packageDirectory, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const declaredDependencies = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
    ...packageJson.peerDependencies,
  };
  const allowedDependencies = PROVIDER_NEUTRAL_ALLOWED_DEPENDENCIES.get(
    packageDirectory,
  );
  if (allowedDependencies === undefined) {
    throw new Error(`Missing provider-neutral dependency allowlist: ${packageDirectory}`);
  }
  for (const dependency of Object.keys(declaredDependencies)) {
    if (!allowedDependencies.has(dependency)) {
      violations.push(`${packageJsonPath}: unapproved dependency ${dependency}`);
    } else if (isProviderSpecific(dependency)) {
      violations.push(`${packageJsonPath}: provider dependency ${dependency}`);
    }
  }
  for (const sourcePath of await sourceFiles(join(packageDirectory, "src"))) {
    const source = await readFile(sourcePath, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (!isAllowedNeutralImport(specifier, allowedDependencies)) {
        violations.push(`${sourcePath}: unapproved import ${specifier}`);
      } else if (!isAllowedRestrictedNeutralImport(sourcePath, specifier)) {
        violations.push(`${sourcePath}: restricted import ${specifier}`);
      } else if (isProviderSpecific(specifier)) {
        violations.push(`${sourcePath}: provider import ${specifier}`);
      }
    }
  }
}

function isAllowedRestrictedNeutralImport(sourcePath, specifier) {
  const allowedPaths = RESTRICTED_NEUTRAL_IMPORTS.get(specifier);
  return allowedPaths === undefined || allowedPaths.has(sourcePath);
}

// The harness (apps/agent/src/harness) is shared by the Cloudflare and Node
// hosts: host capabilities reach it as Ports on HarnessContext (design §0.7
// "harness 里的 CF 类型"). Ratchet: no Durable Object types at all, and the
// remaining Cloudflare storage types only in their current files.
const SHARED_HARNESS_DIRECTORY = "apps/agent/src/harness";
const SHARED_HARNESS_FORBIDDEN_TYPES = /\b(DurableObjectNamespace|DurableObjectStub|DurableObjectState|DurableObjectId)\b/;
const SHARED_HARNESS_CF_STORAGE_TYPES = /\b(KVNamespace|R2Bucket|D1Database)\b/;
const SHARED_HARNESS_CF_STORAGE_ALLOWED = new Set([
  join(SHARED_HARNESS_DIRECTORY, "interface.ts"),
  join(SHARED_HARNESS_DIRECTORY, "llm-logging-middleware.ts"),
  join(SHARED_HARNESS_DIRECTORY, "skills.ts"),
]);
for (const sourcePath of await sourceFiles(SHARED_HARNESS_DIRECTORY)) {
  const source = await readFile(sourcePath, "utf8");
  if (SHARED_HARNESS_FORBIDDEN_TYPES.test(source)) {
    violations.push(`${sourcePath}: Durable Object type in the shared harness (inject a Port instead)`);
  }
  if (SHARED_HARNESS_CF_STORAGE_TYPES.test(source) && !SHARED_HARNESS_CF_STORAGE_ALLOWED.has(sourcePath)) {
    violations.push(`${sourcePath}: Cloudflare storage type in the shared harness (inject a Port instead)`);
  }
}

// The Session sandbox core (design §0.0 rule 15, §0.7) is one
// implementation in packages/session-runtime over the Sandbox SDK v2
// vocabulary only (session-runtime itself depends on sql-client, so this is
// a file-level rule). Hosts compose it: node-managed no longer wires egress
// or Memory sync itself, and the two host files only shrink.
const SESSION_SANDBOX_CORE = /^packages\/session-runtime\/src\/(ports-session-sandbox|session-sandbox-[a-z-]+)\.ts$/;
const SESSION_SANDBOX_CORE_IMPORTS = new Set([
  "@open-managed-agents/sandbox",
  "@open-managed-agents/runtime-resource-contract",
]);
for (const sourcePath of await sourceFiles("packages/session-runtime/src")) {
  if (!SESSION_SANDBOX_CORE.test(sourcePath.split("\\").join("/"))) continue;
  for (const specifier of importSpecifiers(await readFile(sourcePath, "utf8"))) {
    if (!specifier.startsWith(".") && !SESSION_SANDBOX_CORE_IMPORTS.has(specifier)) {
      violations.push(`${sourcePath}: Session sandbox core import ${specifier} (only the Sandbox SDK v2 Ports)`);
    }
  }
}
const NODE_SESSION_SANDBOX_HOST = "packages/control-plane-node/src/modules/node-managed.ts";
if (/\b(prepareSandboxEgress|synchronizeManagedSessionMemoryWorkspaces|synchronizeNodeManagedMemoryStores)\b/.test(await readFile(NODE_SESSION_SANDBOX_HOST, "utf8"))) {
  violations.push(`${NODE_SESSION_SANDBOX_HOST}: sandbox egress / Memory sync wired in the host (compose the Session sandbox core instead)`);
}
const HOST_LINE_CEILINGS = new Map([
  ["apps/agent/src/runtime/session-do.ts", 8292],
  [NODE_SESSION_SANDBOX_HOST, 1430],
]);
for (const [path, ceiling] of HOST_LINE_CEILINGS) {
  const lines = (await readFile(path, "utf8")).split("\n").length - 1;
  if (lines > ceiling) violations.push(`${path}: ${lines} lines, above its ratchet of ${ceiling} (move code out, then lower the ceiling)`);
}

violations.push(...await providerWorkspaceBoundaryViolations(process.cwd()));
violations.push(...await providerPackageBoundaryViolations(process.cwd()));

if (violations.length > 0) {
  throw new Error(
    `Core boundary violation(s):\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
}

console.log(
  `Core boundary check passed for ${CORE_PACKAGES.length} core, ${PROVIDER_NEUTRAL_PACKAGES.length} provider-neutral packages, and all isolated provider adapters.`,
);

function isForbidden(specifier) {
  return FORBIDDEN_PREFIXES.some((prefix) =>
    specifier === prefix || specifier.startsWith(prefix),
  );
}

function isProviderSpecific(specifier) {
  return PROVIDER_DEPENDENCY_PREFIXES.some((prefix) =>
    specifier === prefix || specifier.startsWith(prefix),
  );
}

function isAllowedNeutralImport(specifier, allowedDependencies) {
  if (specifier.startsWith(".") || specifier.startsWith("node:")) return true;
  return [...allowedDependencies].some((dependency) =>
    specifier === dependency || specifier.startsWith(`${dependency}/`)
  );
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx", ".mts"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function importSpecifiers(source) {
  const imports = new Set();
  for (const pattern of [
    // Static import/export grammar requires whitespace after `from`. Using
    // `\s*` also matched ordinary string values such as `"from"` followed by
    // another quoted expression later on the line.
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
  ]) {
    for (const match of source.matchAll(pattern)) imports.add(match[1]);
  }
  return [...imports];
}
