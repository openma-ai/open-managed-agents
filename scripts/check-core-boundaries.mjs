import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const CORE_PACKAGES = [
  "packages/managed-agents-domain",
  "packages/managed-agents-application",
  "packages/managed-agents-api",
  "packages/managed-agents-app",
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

if (violations.length > 0) {
  throw new Error(
    `Core boundary violation(s):\n${violations.map((violation) => `  - ${violation}`).join("\n")}`,
  );
}

console.log(
  `Core boundary check passed for ${CORE_PACKAGES.length} packages (no platform/storage adapter dependencies).`,
);

function isForbidden(specifier) {
  return FORBIDDEN_PREFIXES.some((prefix) =>
    specifier === prefix || specifier.startsWith(prefix),
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
  const imports = [];
  const pattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}
