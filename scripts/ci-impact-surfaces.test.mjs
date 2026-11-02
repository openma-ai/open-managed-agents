import assert from "node:assert/strict";
import test from "node:test";
import { classifyPath, summarize } from "./ci-impact-surfaces.mjs";

test("classifyPath labels core surfaces", () => {
  assert.equal(classifyPath("apps/docs/src/content/docs/index.mdx"), "docs");
  assert.equal(classifyPath("apps/web/src/pages/index.astro"), "web");
  assert.equal(classifyPath("apps/agent/package.json"), "cf");
  assert.equal(classifyPath("apps/main/wrangler.jsonc"), "cf");
  assert.equal(classifyPath("packages/managed-runtime-cloudflare/src/index.ts"), "cf");
  assert.equal(classifyPath("packages/integrations-adapters-cf/src/index.ts"), "cf");
  assert.equal(classifyPath("apps/main-node/src/index.ts"), "node");
  assert.equal(classifyPath("apps/console/src/App.tsx"), "node");
  assert.equal(classifyPath("packages/sandbox-adapter-litebox/src/index.ts"), "node");
  assert.equal(classifyPath("packages/shared/src/index.ts"), "shared");
  assert.equal(classifyPath("pnpm-lock.yaml"), "lockfile");
  assert.equal(classifyPath("package.json"), "lockfile");
  assert.equal(classifyPath("README.md"), "meta");
  assert.equal(classifyPath("docs/architecture.md"), "meta");
  assert.equal(classifyPath("vitest.config.ts"), "cf");
  assert.equal(classifyPath("vitest.storage.config.ts"), "node");
  assert.equal(classifyPath(".github/workflows/ci.yml"), "shared");
  assert.equal(classifyPath(".github/workflows/release.yml"), "meta");
  assert.equal(classifyPath("scripts/ci-impact-surfaces.mjs"), "shared");
  assert.equal(classifyPath("scripts/setup-cf.sh"), "cf");
});

test("docs-only does not run cf or node", () => {
  const r = summarize(["apps/docs/src/content/docs/index.mdx"]);
  assert.deepEqual(r.run, { docs: true, web: false, cf: false, node: false });
});

test("web-only does not run cf or node", () => {
  const r = summarize(["apps/web/src/pages/index.astro"]);
  assert.deepEqual(r.run, { docs: false, web: true, cf: false, node: false });
});

test("CF bump with lockfile (#298 style) skips node", () => {
  const r = summarize([
    "apps/agent/package.json",
    "apps/agent/Dockerfile",
    "packages/managed-runtime-cloudflare/package.json",
    "pnpm-lock.yaml",
    "package.json",
    "vitest.config.ts",
  ]);
  assert.equal(r.run.cf, true);
  assert.equal(r.run.node, false);
  assert.equal(r.run.docs, false);
});

test("Node package + lockfile skips cf", () => {
  const r = summarize([
    "apps/main-node/src/server.ts",
    "packages/sandbox/package.json",
    "pnpm-lock.yaml",
  ]);
  assert.equal(r.run.node, true);
  assert.equal(r.run.cf, false);
});

test("shared package runs both", () => {
  const r = summarize(["packages/shared/src/index.ts"]);
  assert.equal(r.run.cf, true);
  assert.equal(r.run.node, true);
});

test("lockfile alone runs both", () => {
  const r = summarize(["pnpm-lock.yaml"]);
  assert.equal(r.run.cf, true);
  assert.equal(r.run.node, true);
});

test("meta-only runs nothing heavy", () => {
  const r = summarize(["README.md", "docs/architecture.md", "LICENSE"]);
  assert.equal(r.metaOnly, true);
  assert.deepEqual(r.run, { docs: false, web: false, cf: false, node: false });
});

test("ci.yml change runs both", () => {
  const r = summarize([".github/workflows/ci.yml", "scripts/ci-impact-surfaces.mjs"]);
  assert.equal(r.run.cf, true);
  assert.equal(r.run.node, true);
});

test("docs + lockfile does not invent cf/node", () => {
  const r = summarize(["apps/docs/package.json", "pnpm-lock.yaml"]);
  assert.equal(r.run.docs, true);
  assert.equal(r.run.cf, false);
  assert.equal(r.run.node, false);
});
