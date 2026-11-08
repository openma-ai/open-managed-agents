// Runner registration for the multi-platform parity gate (design §0.7
// gate 3). Plain ESM so both the TypeScript runners and the Node gate script
// (scripts/check-platform-parity.mjs) read the same declaration.
//
// Platforms are NOT listed here: the gate discovers them from the workspace
// dependency graph (every apps/* package that reaches
// @open-managed-agents/session-runtime). This file only says, for each
// discovered platform, how it runs the shared scenarios. A discovered
// platform missing from this file fails the gate.

/**
 * @typedef {{ kind: "runner", runner: string }} OwnRunner
 * @typedef {{ kind: "reuse", runner: string, entry: string, composition: string }} ReusedRunner
 * @typedef {{ kind: "not-a-session-host", cause: string }} NotASessionHost
 * @typedef {OwnRunner | ReusedRunner | NotASessionHost} PlatformRegistration
 */

/** Runners that actually execute the scenarios. */
export const PARITY_RUNNERS = {
  cloudflare: {
    /** Root workerd Vitest (pnpm exec vitest run, part of test:ci:cf). */
    file: "test/integration/platform-parity.cf.test.ts",
    ciScript: "test:ci:cf",
    ciJob: "cf",
  },
  node: {
    /** main-node Vitest (pnpm --filter main-node test, part of test:ci:node). */
    file: "apps/main-node/test/platform-parity.node.test.ts",
    ciScript: "test:ci:node",
    ciJob: "node",
  },
};

/** @type {Record<string, PlatformRegistration>} */
export const PLATFORM_REGISTRATIONS = {
  // apps/agent (SessionDO) and apps/main (HTTP worker) are one deployment;
  // the combined test worker test/test-worker.ts serves both.
  "@open-managed-agents/agent": { kind: "runner", runner: "cloudflare" },
  "@open-managed-agents/main": { kind: "runner", runner: "cloudflare" },
  "@open-managed-agents/main-node": { kind: "runner", runner: "node" },
  // Both entries assemble the Session runtime exclusively through
  // main-node's createNodeControlPlane(await nodeDefaults(loadNodeConfig(env))).
  // The gate re-proves this from the graph and the entry module on every run.
  "@open-managed-agents/main-fly": {
    kind: "reuse",
    runner: "node",
    entry: "apps/main-fly/src/index.ts",
    composition: "@open-managed-agents/main-node",
  },
  "@open-managed-agents/main-vercel": {
    kind: "reuse",
    runner: "node",
    entry: "apps/main-vercel/src/production.ts",
    composition: "@open-managed-agents/main-node",
  },
  // Reaches session-runtime only transitively through http-routes, and its
  // entry serves the integrations gateway (buildIntegrationsGatewayRoutes),
  // never Session turns. The gate fails if it starts depending on a Session
  // host directly, so this exclusion cannot silently cover a real platform.
  "@open-managed-agents/integrations": {
    kind: "not-a-session-host",
    cause: "apps/integrations/src/index.ts imports only buildIntegrationsGatewayRoutes from @open-managed-agents/http-routes; it reaches session-runtime transitively and hosts no Session",
  },
};
