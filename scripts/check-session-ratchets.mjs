#!/usr/bin/env node
/**
 * Session structure ratchets (design §0.7 测试门禁 1). Each only tightens:
 *
 *   maxLines           the two Session hosts (SessionDO, Node node-managed)
 *                      may not grow; code moves out into session-* packages.
 *   agentImports       packages/control-plane-node may not add imports of
 *                      @open-managed-agents/agent (apps/agent): per file, no
 *                      more than recorded, and none in a new file.
 *   unclassified       every packages/session-* and packages/sandbox* is a
 *                      classified domain or adapter package: listed in
 *                      scripts/check-core-boundaries.mjs (CORE_PACKAGES,
 *                      PROVIDER_NEUTRAL_PACKAGES or an *ADAPTER_PACKAGES list)
 *                      or a provider adapter by the directory rule of
 *                      scripts/provider-package-boundaries.mjs. Packages that
 *                      predate this gate are recorded and may only leave.
 *
 * Baseline: scripts/session-ratchets.json. Going over it fails; coming in
 * under it prints what can tighten, and `--update` writes the tighter
 * numbers (it never loosens). Reads files only; needs no node_modules.
 *
 * Usage:
 *   node scripts/check-session-ratchets.mjs            # gate
 *   node scripts/check-session-ratchets.mjs --update   # tighten the baseline
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BASELINE_PATH = "scripts/session-ratchets.json";
export const CORE_BOUNDARIES_PATH = "scripts/check-core-boundaries.mjs";
export const PROVIDER_BOUNDARIES_PATH = "scripts/provider-package-boundaries.mjs";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

export function lineCount(text) {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Import / export-from / dynamic import / require specifiers, every occurrence. */
export function importSpecifiers(source) {
  const specifiers = [];
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']/gu,
    /\bimport\s+["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

export function isPackageImport(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

/** file (relative to the package) -> number of imports of `packageName`. */
export function packageImportCounts(sources, packageName) {
  const counts = {};
  for (const [file, source] of Object.entries(sources)) {
    const count = importSpecifiers(source).filter((specifier) => isPackageImport(specifier, packageName)).length;
    if (count > 0) counts[file] = count;
  }
  return counts;
}

/**
 * Directories the boundary scripts classify. From check-core-boundaries.mjs:
 * string entries of CORE_PACKAGES, PROVIDER_NEUTRAL_PACKAGES and any
 * *ADAPTER_PACKAGES array or Set. From provider-package-boundaries.mjs: the
 * name.startsWith(...) prefixes of isProviderAdapterDirectory.
 */
export function classificationRules(coreBoundariesSource, providerBoundariesSource) {
  const lists = {};
  for (const match of coreBoundariesSource.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_PACKAGES)\s*=\s*(?:new\s+Set\(\s*)?\[([\s\S]*?)\]/gu)) {
    const [, name, body] = match;
    if (name === "CORE_PACKAGES" || name === "PROVIDER_NEUTRAL_PACKAGES" || name.endsWith("ADAPTER_PACKAGES")) {
      lists[name] = [...body.matchAll(/["'](packages\/[^"']+)["']/gu)].map((entry) => entry[1]);
    }
  }
  for (const required of ["CORE_PACKAGES", "PROVIDER_NEUTRAL_PACKAGES"]) {
    if (!lists[required]) throw new Error(`${CORE_BOUNDARIES_PATH}: ${required} list not found; update scripts/check-session-ratchets.mjs to read the new name`);
  }
  const adapterRule = /function\s+isProviderAdapterDirectory\s*\(\s*name\s*\)\s*\{([\s\S]*?)\n\}/u.exec(providerBoundariesSource);
  if (!adapterRule) throw new Error(`${PROVIDER_BOUNDARIES_PATH}: isProviderAdapterDirectory(name) not found; update scripts/check-session-ratchets.mjs`);
  // Only unconditional `if (name.startsWith("x")) return true;` lines classify.
  const adapterPrefixes = [...adapterRule[1].matchAll(/if\s*\(\s*name\.startsWith\(\s*["']([^"']+)["']\s*\)\s*\)\s*return\s+true/gu)].map((entry) => entry[1]);
  return { lists, adapterPrefixes };
}

export function classificationOf(directory, rules) {
  for (const [name, entries] of Object.entries(rules.lists)) if (entries.includes(directory)) return name;
  const base = directory.slice("packages/".length);
  const prefix = rules.adapterPrefixes.find((candidate) => base.startsWith(candidate));
  return prefix === undefined ? null : `provider adapter (${prefix}*)`;
}

export function isSessionPackageDirectory(directory) {
  return /^packages\/(?:session-[^/]+|sandbox(?:-[^/]+)?)$/u.test(directory);
}

/** Pure verdict: `violations` fail the gate, `tightenings` are hints. */
export function evaluateRatchets(baseline, current) {
  const violations = [];
  const tightenings = [];
  for (const [file, max] of Object.entries(baseline.maxLines)) {
    const lines = current.lines[file];
    if (lines === undefined) tightenings.push(`${file}: gone; remove it from maxLines`);
    else if (lines > max) violations.push(`${file}: ${lines} lines, above its ratchet of ${max}. Move code out into a session-* package instead of growing the host`);
    else if (lines < max) tightenings.push(`${file}: ${lines} lines, ratchet ${max}`);
  }
  const { package: packageDir, specifier, maxPerFile } = baseline.agentImports;
  for (const [file, count] of Object.entries(current.agentImports)) {
    const max = maxPerFile[file] ?? 0;
    if (count > max) {
      violations.push(`${packageDir}/${file}: ${count} import(s) of ${specifier}, ratchet ${max}. Node must not add apps/agent dependencies; move the shared code into a package`);
    }
  }
  for (const [file, max] of Object.entries(maxPerFile)) {
    const count = current.agentImports[file] ?? 0;
    if (count < max) tightenings.push(`${packageDir}/${file}: ${count} import(s) of ${specifier}, ratchet ${max}`);
  }
  const grandfathered = new Set(baseline.unclassifiedPackages);
  for (const directory of current.sessionPackages) {
    if (current.classification[directory] === null && !grandfathered.has(directory)) {
      violations.push(`${directory}: unclassified Session package. Add it to CORE_PACKAGES (domain), PROVIDER_NEUTRAL_PACKAGES or an *ADAPTER_PACKAGES list in ${CORE_BOUNDARIES_PATH}`);
    }
  }
  for (const directory of grandfathered) {
    if (!current.sessionPackages.includes(directory)) tightenings.push(`${directory}: gone; remove it from unclassifiedPackages`);
    else if (current.classification[directory] !== null) tightenings.push(`${directory}: now classified (${current.classification[directory]}); remove it from unclassifiedPackages`);
  }
  return { violations, tightenings };
}

/** The baseline with every number lowered to the current value; never raised. */
export function tightenBaseline(baseline, current) {
  const maxLines = {};
  for (const [file, max] of Object.entries(baseline.maxLines)) {
    if (current.lines[file] !== undefined) maxLines[file] = Math.min(max, current.lines[file]);
  }
  const maxPerFile = {};
  for (const [file, max] of Object.entries(baseline.agentImports.maxPerFile)) {
    const count = Math.min(max, current.agentImports[file] ?? 0);
    if (count > 0) maxPerFile[file] = count;
  }
  return {
    ...baseline,
    maxLines,
    agentImports: { ...baseline.agentImports, maxPerFile },
    unclassifiedPackages: baseline.unclassifiedPackages.filter((directory) =>
      current.sessionPackages.includes(directory) && current.classification[directory] === null),
  };
}

function sourceFiles(root, directory) {
  const files = [];
  if (!existsSync(join(root, directory))) return files;
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...sourceFiles(root, path));
    } else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

export function readCurrent(root, baseline) {
  const read = (path) => readFileSync(join(root, path), "utf8");
  const lines = {};
  for (const file of Object.keys(baseline.maxLines)) if (existsSync(join(root, file))) lines[file] = lineCount(read(file));
  const { package: packageDir, specifier } = baseline.agentImports;
  const sources = Object.fromEntries(sourceFiles(root, packageDir).map((path) => [
    relative(packageDir, path).split(sep).join("/"), read(path),
  ]));
  const rules = classificationRules(read(CORE_BOUNDARIES_PATH), read(PROVIDER_BOUNDARIES_PATH));
  const sessionPackages = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
    .map((entry) => `packages/${entry.name}`)
    .filter(isSessionPackageDirectory)
    .sort();
  return {
    lines,
    agentImports: packageImportCounts(sources, specifier),
    sessionPackages,
    classification: Object.fromEntries(sessionPackages.map((directory) => [directory, classificationOf(directory, rules)])),
  };
}

export function main(argv, root = process.cwd()) {
  const baselinePath = join(root, BASELINE_PATH);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const current = readCurrent(root, baseline);
  const { violations, tightenings } = evaluateRatchets(baseline, current);
  if (violations.length > 0) {
    throw new Error(`Session ratchet violation(s):\n${violations.map((violation) => `  - ${violation}`).join("\n")}`);
  }
  if (argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(tightenBaseline(baseline, current), null, 2)}\n`);
    console.log(`Tightened ${BASELINE_PATH} (${tightenings.length} change(s)).`);
    return;
  }
  if (tightenings.length > 0) {
    console.log(`Session ratchets can tighten; run \`node scripts/check-session-ratchets.mjs --update\` and commit ${BASELINE_PATH}:\n${tightenings.map((t) => `  - ${t}`).join("\n")}`);
  }
  const imports = Object.values(current.agentImports).reduce((sum, count) => sum + count, 0);
  console.log(
    `Session ratchets passed: ${Object.entries(current.lines).map(([file, lines]) => `${file.split("/").pop()} ${lines} lines`).join(", ")}; ${imports} ${baseline.agentImports.specifier} imports in ${Object.keys(current.agentImports).length} ${baseline.agentImports.package} files; ${current.sessionPackages.length} Session packages, ${baseline.unclassifiedPackages.length} recorded unclassified.`,
  );
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
