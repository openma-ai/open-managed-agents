#!/usr/bin/env node
/**
 * Build one public `@openma/*` package from its workspace sources (ADR 0015).
 *
 * Run from the package directory (`"build": "node ../../scripts/build-public-package.mjs"`).
 *
 * Modes:
 * - `--types-only`: emit declarations with `tsc -p tsconfig.build.json` and an
 *   empty ESM stub next to every `.d.ts`, so a value import of a type-only
 *   module resolves to nothing instead of failing. The package must not
 *   declare runtime dependencies.
 * - default (bundle): every key of `exports` that maps to a `.ts` source is an
 *   entry. JavaScript is bundled with esbuild and declarations with
 *   rollup-plugin-dts. Private workspace packages are inlined; `@openma/*`
 *   packages and the package's own `dependencies` / `peerDependencies` stay
 *   external. Private workspace packages therefore belong in
 *   `devDependencies`, the way `@openma/cli` bundles its internals.
 *
 * Both modes finish with a leak check: the built files and the runtime
 * dependency lists may not name a private workspace package.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PRIVATE_SCOPE = "@open-managed-agents/";

export function runtimeDependencyNames(manifest) {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ];
}

/** True when `specifier` must stay an import in the published output. */
export function isExternalSpecifier(specifier, externals) {
  if (specifier.startsWith("node:")) return true;
  if (specifier.startsWith("@openma/")) return true;
  return externals.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

/** `{ "./x": "./src/x.ts" }` + publishConfig `{ "./x": { default: "./dist/x.js" } }` → `{ "x": "src/x.ts" }`. */
export function bundleEntries(manifest) {
  const published = manifest.publishConfig?.exports ?? {};
  const entries = {};
  for (const [key, source] of Object.entries(manifest.exports ?? {})) {
    if (typeof source !== "string" || !source.endsWith(".ts")) continue;
    if (source.includes("*")) {
      throw new Error(`${manifest.name}: wildcard export ${key} is only supported with --types-only`);
    }
    const target = published[key];
    const output = typeof target === "string" ? target : target?.default ?? target?.import;
    if (typeof output !== "string" || !output.startsWith("./dist/") || !output.endsWith(".js")) {
      throw new Error(`${manifest.name}: publishConfig.exports[${JSON.stringify(key)}] must point at ./dist/*.js`);
    }
    entries[output.slice("./dist/".length, -".js".length)] = source.replace(/^\.\//, "");
  }
  if (Object.keys(entries).length === 0) throw new Error(`${manifest.name}: no .ts entries in exports`);
  return entries;
}

export function privateDependencyErrors(manifest, privateNames) {
  const errors = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (name.startsWith(PRIVATE_SCOPE) || privateNames.has(name)) {
        errors.push(`${manifest.name}: ${field} lists private workspace package ${name}; bundle it (devDependencies) instead`);
      }
    }
  }
  return errors;
}

/** Import specifiers of private workspace packages left in built files. */
export function leakedSpecifiers(source) {
  const leaked = new Set();
  for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+|require\s*\(\s*)["'](@open-managed-agents\/[^"']+)["']/g)) {
    leaked.add(match[1]);
  }
  return [...leaked];
}

/** Bare module specifiers a built JavaScript file imports. */
export function bareImports(source) {
  const found = new Set();
  for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*(?:\/\*[^*]*\*\/\s*)?|^\s*import\s+|\brequire\s*\(\s*)["']([^"'./][^"']*)["']/gm)) {
    found.add(match[1]);
  }
  return [...found];
}

/** Bare imports that are neither declared dependencies nor Node builtins. */
export function undeclaredImports(specifiers, declared) {
  return specifiers.filter((specifier) => {
    if (specifier.startsWith("node:")) return false;
    const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (builtinModules.includes(name)) return false;
    return !declared.includes(name);
  });
}

function workspacePrivateNames() {
  const names = new Set();
  for (const parent of ["packages", "apps"]) {
    const directory = path.join(repoRoot, parent);
    for (const name of readdirSync(directory)) {
      const manifestPath = path.join(directory, name, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private === true && typeof manifest.name === "string") names.add(manifest.name);
    }
  }
  return names;
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) files.push(...walk(file));
    else files.push(file);
  }
  return files;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
}

function buildTypesOnly(packageDir, manifest) {
  if (runtimeDependencyNames(manifest).length > 0) {
    throw new Error(`${manifest.name} is types-only and may not declare runtime dependencies`);
  }
  const typescriptDir = path.dirname(createRequire(path.join(repoRoot, "package.json")).resolve("typescript/package.json"));
  run(process.execPath, [path.join(typescriptDir, "bin", "tsc"), "-p", "tsconfig.build.json", "--emitDeclarationOnly"], packageDir);
  for (const file of walk(path.join(packageDir, "dist"))) {
    if (file.endsWith(".d.ts")) writeFileSync(`${file.slice(0, -".d.ts".length)}.js`, "export {};\n");
  }
}

async function buildBundle(packageDir, manifest) {
  const requireFromRoot = createRequire(path.join(repoRoot, "package.json"));
  const esbuild = await import(pathToFileURL(requireFromRoot.resolve("esbuild")).href);
  const { rollup } = await import(pathToFileURL(requireFromRoot.resolve("rollup")).href);
  const { dts } = await import(pathToFileURL(requireFromRoot.resolve("rollup-plugin-dts")).href);

  const entries = bundleEntries(manifest);
  const externals = runtimeDependencyNames(manifest);
  const outdir = path.join(packageDir, "dist");
  mkdirSync(outdir, { recursive: true });

  await esbuild.build({
    absWorkingDir: packageDir,
    entryPoints: entries,
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "node",
    target: "node20",
    chunkNames: "chunks/[name]-[hash]",
    logLevel: "warning",
    legalComments: "none",
    plugins: [{
      name: "openma-externals",
      setup(build) {
        build.onResolve({ filter: /^[^./]/ }, (args) => (
          isExternalSpecifier(args.path, externals) ? { path: args.path, external: true } : undefined
        ));
      },
    }],
  });

  const bundle = await rollup({
    input: Object.fromEntries(Object.entries(entries).map(([name, source]) => [name, path.join(packageDir, source)])),
    external: (id) => !id.startsWith(".") && !path.isAbsolute(id) && isExternalSpecifier(id, externals),
    plugins: [{
      // pnpm links one workspace package under many node_modules paths. Use
      // the real path so each source file is one module, not one per link.
      name: "openma-realpath",
      async resolveId(source, importer, options) {
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (!resolved || resolved.external || !path.isAbsolute(resolved.id)) return resolved;
        return { ...resolved, id: realpathSync(resolved.id) };
      },
    }, dts({
      respectExternal: true,
      tsconfig: path.join(packageDir, "tsconfig.json"),
      compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true },
    })],
    onwarn(warning, warn) {
      if (["CIRCULAR_DEPENDENCY", "EMPTY_BUNDLE", "UNUSED_EXTERNAL_IMPORT"].includes(warning.code)) return;
      warn(warning);
    },
  });
  await bundle.write({ dir: outdir, format: "es", entryFileNames: "[name].d.ts", chunkFileNames: "chunks/[name]-[hash].d.ts" });
  await bundle.close();
}

/**
 * `prepublishOnly` guard. Only pnpm applies `publishConfig.exports` and
 * rewrites `workspace:` ranges; `changeset publish` uses pnpm in this repo.
 */
export function publishToolError(userAgent) {
  return /^pnpm\//.test(userAgent ?? "")
    ? null
    : "Publish @openma packages with pnpm (changeset publish): npm keeps the source exports and workspace: ranges";
}

async function main() {
  if (process.argv.includes("--assert-pnpm-publish")) {
    const error = publishToolError(process.env.npm_config_user_agent);
    if (error) throw new Error(error);
    return;
  }
  const packageDir = process.cwd();
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const privateNames = workspacePrivateNames();
  const manifestErrors = privateDependencyErrors(manifest, privateNames);
  if (manifestErrors.length > 0) throw new Error(manifestErrors.join("\n"));

  rmSync(path.join(packageDir, "dist"), { recursive: true, force: true });
  if (process.argv.includes("--types-only")) buildTypesOnly(packageDir, manifest);
  else await buildBundle(packageDir, manifest);

  const leaks = [];
  const declared = runtimeDependencyNames(manifest);
  for (const file of walk(path.join(packageDir, "dist"))) {
    if (!/\.(?:js|d\.ts)$/.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const relative = path.relative(packageDir, file);
    for (const specifier of leakedSpecifiers(source)) leaks.push(`${relative} imports private ${specifier}`);
    for (const specifier of undeclaredImports(bareImports(source), declared)) {
      leaks.push(`${relative} imports ${specifier}, which is not a dependency or peerDependency`);
    }
  }
  if (leaks.length > 0) throw new Error(`${manifest.name} build has invalid imports:\n${leaks.join("\n")}`);
  console.log(`built ${manifest.name}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
