#!/usr/bin/env node

/**
 * Keep the public Session route layer runtime-neutral.
 *
 * The Hono handlers live in packages/http-routes. Cloudflare and Node only
 * provide SessionRouter adapters. This guard catches a future split where a
 * runtime adds its own public route tree or stops implementing the shared
 * adapter contract.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = {
  sharedRoutes: "packages/http-routes/src/sessions/index.ts",
  sessionRouter: "packages/session-runtime/src/router.ts",
  cfEntry: "apps/main/src/index.ts",
  cfAdapter: "apps/main/src/lib/cf-session-router.ts",
  nodeEntry: "packages/control-plane-node/src/modules/node-http.ts",
  nodeAdapter: "packages/control-plane-node/src/lib/node-session-router.ts",
};

const source = Object.fromEntries(
  Object.entries(files).map(([name, path]) => [name, readFileSync(join(root, path), "utf8")]),
);

const failures = [];
const requireText = (name, pattern, description) => {
  if (!pattern.test(source[name])) failures.push(`${files[name]}: ${description}`);
};

requireText("sharedRoutes", /SessionRouter/u, "must depend on the shared SessionRouter contract");
requireText("cfEntry", /buildSessionRoutes/u, "must mount the shared Session routes");
requireText("cfEntry", /new CfSessionRouter/u, "must use the Cloudflare SessionRouter adapter");
requireText("nodeEntry", /buildSessionRoutes/u, "must mount the shared Session routes");
requireText("nodeEntry", /new NodeSessionRouter/u, "must use the Node SessionRouter adapter");
requireText("cfAdapter", /class CfSessionRouter implements SessionRouter/u, "must implement SessionRouter");
requireText("nodeAdapter", /class NodeSessionRouter implements SessionRouter/u, "must implement SessionRouter");

const methods = [...source.sessionRouter.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\(/gmu)].map((match) => match[1]);
for (const adapter of ["cfAdapter", "nodeAdapter"]) {
  for (const method of methods) {
    if (!new RegExp(`\\b${method}\\s*\\(`, "u").test(source[adapter])) {
      failures.push(`${files[adapter]}: missing SessionRouter method ${method}()`);
    }
  }
}

if (failures.length > 0) {
  console.error("Session route parity check failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Session route parity passed: shared HTTP routes with ${methods.length} Node/CF adapter methods.`);
