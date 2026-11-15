#!/usr/bin/env node
/**
 * Classify changed paths into graded CI surfaces and decide which jobs to run.
 *
 * Surfaces: docs | web | cf | node | lockfile | shared | meta
 *
 * Job decision (see #417):
 * - docs-only / web-only → that job only
 * - CF code (+ lockfile) without node_code → cf only  (#298-style bumps)
 * - Node code (+ lockfile) without cf_code → node only
 * - shared, or lockfile alone, or uncategorized non-meta → cf + node
 * - meta-only (markdown / root docs / license) → no heavy jobs
 *
 * Usage:
 *   node scripts/ci-impact-surfaces.mjs [--write-github-output] [path ...]
 *   git diff --name-only ... | node scripts/ci-impact-surfaces.mjs --write-github-output
 *
 * Without paths on argv, reads newline-separated paths from stdin.
 *
 * Session runtime routing does not depend on the cf/node lists below: CI also
 * runs a job when the multi-platform parity gate selects it
 * (`scripts/check-platform-parity.mjs affected`: changed files -> owning
 * package -> pnpm reverse dependents -> affected platforms), and the job
 * conditions are `cf || parity_cf` / `node || parity_node`. These lists only
 * cover the other surfaces.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const CF_APPS = new Set([
  "main",
  "agent",
  "integrations",
  "matter",
  "oma-vault",
]);

const NODE_APPS = new Set([
  "main-node",
  "main-fly",
  "main-vercel",
  "console",
]);

const CF_PACKAGES = new Set([
  "cf-billing",
  "cost-attribution-cloudflare",
  "environment-dispatch-cloudflare",
  "integrations-adapters-cf",
  "managed-runtime-cloudflare",
  "managed-runtime-cloudflare-bridge",
  "platform-cloudflare",
  "session-wakeup-cloudflare",
]);

const NODE_PACKAGES = new Set([
  "cli",
  "control-plane-node",
  "cost-attribution-blaxel",
  "cost-attribution-vercel",
  "environment-activation-aws",
  "environment-dispatch-gke",
  "environment-dispatch-vercel",
  "integrations-adapters-node",
  "managed-runtime-blaxel",
  "managed-runtime-boxlite",
  "managed-runtime-daytona",
  "managed-runtime-e2b",
  "managed-runtime-host",
  "managed-runtime-modal",
  "managed-runtime-node",
  "managed-runtime-sandbox",
  "managed-runtime-sprites",
  "managed-runtime-superserve",
  "managed-runtime-vercel",
  "node-database",
  "node-database-mysql",
  "node-database-postgres",
  "node-database-sqlite",
  "openai-agents-api",
  "openai-agents-compat",
  "openai-agents-sdk-audit",
  "platform-node",
  "sandbox",
  "sandbox-adapter-boxrun",
  "sandbox-adapter-daytona",
  "sandbox-adapter-e2b",
  "sandbox-adapter-litebox",
  "sandbox-adapter-opensandbox",
  "sdk",
  "vercel-sandbox-contract",
]);

const CF_SCRIPTS = [
  "setup-cf.sh",
  "lint-wrangler-jsonc.mjs",
  "deploy.sh",
  "lane-generate.mjs",
  "local-build-env.sh",
];

const CF_ROOT_FILES = new Set([
  "vitest.config.ts",
  "wrangler.test.jsonc",
  "drizzle.cf-auth.config.ts",
  "drizzle.cf-integrations.config.ts",
  "drizzle.cf-router.config.ts",
]);

const NODE_ROOT_FILES = new Set([
  "vitest.acp-recovery.config.ts",
  "vitest.harness-tools-wiring.config.ts",
  "vitest.harness-web-http.config.ts",
  "vitest.pi.config.ts",
  "vitest.protocol.config.ts",
  "vitest.session-coordination.config.ts",
  "vitest.storage.config.ts",
  "playwright.config.ts",
  "playwright.agent-editor.config.ts",
  "drizzle.node-pg.config.ts",
  "drizzle.node-sqlite.config.ts",
  "docker-compose.yml",
  "docker-compose.postgres.yml",
  "fly.toml",
  "vercel.json",
  "vercel.preview.json",
  "Dockerfile.sprites-certification",
]);

const LOCKFILE_FILES = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".pnpm-approve-builds.json",
  ".node-version",
]);

const META_EXACT = new Set([
  "LICENSE",
  "NOTICE",
  "logo.svg",
  "codecov.yml",
  ".gitignore",
  ".gitattributes",
  ".nvmrc",
]);

/**
 * @param {string} path
 * @returns {"docs"|"web"|"cf"|"node"|"lockfile"|"shared"|"meta"|"unknown"}
 */
export function classifyPath(path) {
  const p = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!p || p.endsWith("/")) return "meta";

  if (LOCKFILE_FILES.has(p)) return "lockfile";

  if (
    p.startsWith("apps/docs/") ||
    p === "apps/docs" ||
    p === "apps/docs/package.json"
  ) {
    return "docs";
  }
  if (
    p.startsWith("apps/web/") ||
    p === "apps/web" ||
    p === "apps/web/package.json"
  ) {
    return "web";
  }

  const appMatch = /^apps\/([^/]+)(?:\/|$)/.exec(p);
  if (appMatch) {
    const app = appMatch[1];
    if (CF_APPS.has(app)) return "cf";
    if (NODE_APPS.has(app)) return "node";
    return "shared";
  }

  const pkgMatch = /^packages\/([^/]+)(?:\/|$)/.exec(p);
  if (pkgMatch) {
    const pkg = pkgMatch[1];
    if (CF_PACKAGES.has(pkg)) return "cf";
    if (NODE_PACKAGES.has(pkg)) return "node";
    return "shared";
  }

  if (p.startsWith(".github/workflows/ci.yml") || p === ".github/workflows/ci.yml") {
    return "shared";
  }
  if (p.startsWith(".github/actions/")) return "shared";
  if (p.startsWith(".github/workflows/")) {
    // Image / release workflows — not the graded PR verify matrix.
    return "meta";
  }
  if (p.startsWith(".github/")) return "meta";

  if (p.startsWith("scripts/")) {
    const base = p.slice("scripts/".length);
    if (CF_SCRIPTS.some((name) => base === name || base.startsWith(name))) {
      return "cf";
    }
    // Graded-CI classifier itself is shared (touches both job graphs).
    if (base.startsWith("ci-impact-surfaces")) return "shared";
    return "shared";
  }

  if (CF_ROOT_FILES.has(p)) return "cf";
  if (NODE_ROOT_FILES.has(p)) return "node";

  if (p.startsWith("test/")) {
    // Root Vitest worker stubs + CF pool fixtures live here; Node e2e too.
    if (p.startsWith("test/e2e/")) return "node";
    return "cf";
  }

  if (p.startsWith("docs/") || p.startsWith(".changeset/") || p.startsWith("skills/") || p.startsWith("rl/") || p.startsWith("api/")) {
    return "meta";
  }

  if (META_EXACT.has(p) || p.endsWith(".md") || p.endsWith(".mdx")) return "meta";

  if (
    p.startsWith("tsconfig") ||
    p === "CONTRIBUTING.md" ||
    p === "AGENTS.md"
  ) {
    // CONTRIBUTING/AGENTS already caught by .md → meta. tsconfig is shared.
    return p.startsWith("tsconfig") ? "shared" : "meta";
  }

  return "unknown";
}

/**
 * @param {string[]} paths
 */
export function summarize(paths) {
  const labels = {
    docs: false,
    web: false,
    cf: false,
    node: false,
    lockfile: false,
    shared: false,
    meta: false,
    unknown: false,
  };

  /** @type {Record<string, string[]>} */
  const samples = {
    docs: [],
    web: [],
    cf: [],
    node: [],
    lockfile: [],
    shared: [],
    meta: [],
    unknown: [],
  };

  for (const raw of paths) {
    const path = String(raw).trim();
    if (!path) continue;
    const label = classifyPath(path);
    labels[label] = true;
    if (samples[label].length < 8) samples[label].push(path);
  }

  const docs = labels.docs;
  const web = labels.web;
  const cfCode = labels.cf;
  const nodeCode = labels.node;
  const lockfile = labels.lockfile;
  const shared = labels.shared || labels.unknown;
  const metaOnly =
    labels.meta &&
    !docs &&
    !web &&
    !cfCode &&
    !nodeCode &&
    !lockfile &&
    !shared;

  // Lockfile with only docs/web (no cf/node/shared): do not drag CF/Node.
  const lockfileWithDocsOrWebOnly =
    lockfile && !cfCode && !nodeCode && !shared && (docs || web);

  const runDocs = docs;
  const runWeb = web;
  const runCf =
    !metaOnly &&
    (shared ||
      cfCode ||
      (lockfile && !nodeCode && !lockfileWithDocsOrWebOnly));
  const runNode =
    !metaOnly &&
    (shared ||
      nodeCode ||
      (lockfile && !cfCode && !lockfileWithDocsOrWebOnly));

  return {
    labels,
    samples,
    metaOnly,
    run: {
      docs: runDocs,
      web: runWeb,
      cf: runCf,
      node: runNode,
    },
  };
}

function parseArgs(argv) {
  const writeGithub = argv.includes("--write-github-output");
  const paths = argv.filter((a) => a !== "--write-github-output" && !a.endsWith("ci-impact-surfaces.mjs"));
  return { writeGithub, paths };
}

function bool(v) {
  return v ? "true" : "false";
}

async function readStdinPaths() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.split(/\r?\n/);
}

async function main() {
  const { writeGithub, paths: argvPaths } = parseArgs(process.argv.slice(2));
  const paths = argvPaths.length > 0 ? argvPaths : await readStdinPaths();
  const result = summarize(paths);

  const payload = {
    docs: bool(result.run.docs),
    web: bool(result.run.web),
    cf: bool(result.run.cf),
    node: bool(result.run.node),
    meta_only: bool(result.metaOnly),
    labels: Object.fromEntries(
      Object.entries(result.labels).map(([k, v]) => [k, bool(v)]),
    ),
    samples: result.samples,
  };

  console.log(JSON.stringify(payload, null, 2));

  if (writeGithub) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out) {
      throw new Error("--write-github-output requires GITHUB_OUTPUT");
    }
    const lines = [
      `docs=${payload.docs}`,
      `web=${payload.web}`,
      `cf=${payload.cf}`,
      `node=${payload.node}`,
      `meta_only=${payload.meta_only}`,
    ];
    writeFileSync(out, `${lines.join("\n")}\n`, { flag: "a" });
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
