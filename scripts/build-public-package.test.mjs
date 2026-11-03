import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bareImports,
  bundleEntries,
  isExternalSpecifier,
  leakedSpecifiers,
  privateDependencyErrors,
  publishToolError,
  undeclaredImports,
} from "./build-public-package.mjs";

test("bundleEntries maps source exports to their published dist files", () => {
  assert.deepEqual(bundleEntries({
    name: "@openma/x",
    exports: { ".": "./src/index.ts", "./modules": "./src/modules.ts", "./package.json": "./package.json" },
    publishConfig: {
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./modules": { types: "./dist/modules.d.ts", default: "./dist/modules.js" },
      },
    },
  }), { index: "src/index.ts", modules: "src/modules.ts" });
});

test("bundleEntries rejects wildcard exports and unpublished entries", () => {
  assert.throws(() => bundleEntries({ name: "x", exports: { "./*": "./src/*.ts" } }), /wildcard/);
  assert.throws(() => bundleEntries({ name: "x", exports: { ".": "./src/index.ts" } }), /publishConfig/);
});

test("isExternalSpecifier keeps @openma, node builtins and declared packages external", () => {
  const declared = ["effect", "better-sqlite3"];
  assert.equal(isExternalSpecifier("@openma/core/storage", declared), true);
  assert.equal(isExternalSpecifier("node:fs", declared), true);
  assert.equal(isExternalSpecifier("effect/Schedule", declared), true);
  assert.equal(isExternalSpecifier("@open-managed-agents/sql-client", declared), false);
  assert.equal(isExternalSpecifier("effectful", declared), false);
});

test("privateDependencyErrors rejects private workspace packages in runtime dependencies", () => {
  const errors = privateDependencyErrors({
    name: "@openma/x",
    dependencies: { "@openma/core": "workspace:^", "@open-managed-agents/app": "workspace:*" },
    peerDependencies: { "internal-private": "*" },
    devDependencies: { "@open-managed-agents/platform": "workspace:*" },
  }, new Set(["internal-private"]));
  assert.equal(errors.length, 2);
  assert.match(errors[0], /dependencies lists private workspace package @open-managed-agents\/app/);
  assert.match(errors[1], /peerDependencies lists private workspace package internal-private/);
});

test("leakedSpecifiers finds private imports in JavaScript and declarations", () => {
  const source = [
    'import { a } from "@open-managed-agents/app";',
    "export * from '@open-managed-agents/platform/x';",
    'const m = await import("@open-managed-agents/lazy");',
    'import "@openma/core";',
  ].join("\n");
  assert.deepEqual(leakedSpecifiers(source).sort(), [
    "@open-managed-agents/app",
    "@open-managed-agents/lazy",
    "@open-managed-agents/platform/x",
  ]);
});

test("undeclaredImports reports bare imports that are neither declared nor builtins", () => {
  const source = [
    'import { Effect } from "effect";',
    'import fs from "fs";',
    'import { x } from "node:path";',
    'import { y } from "./chunks/a.js";',
    'const d = await import(/* @vite-ignore */ "mysql2/promise");',
    'import { z } from "@openma/common/protocol/managed";',
    'import "left-pad";',
  ].join("\n");
  assert.deepEqual(undeclaredImports(bareImports(source), ["effect", "mysql2"]), [
    "@openma/common/protocol/managed",
    "left-pad",
  ]);
});

test("publishToolError only accepts pnpm, which applies publishConfig", () => {
  assert.equal(publishToolError("pnpm/11.0.8 npm/? node/v24.0.0 linux x64"), null);
  assert.match(publishToolError("npm/11.0.0 node/v24.0.0 linux x64"), /pnpm/);
  assert.match(publishToolError(undefined), /pnpm/);
});
