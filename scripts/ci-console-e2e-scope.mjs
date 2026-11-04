#!/usr/bin/env node
/**
 * Domain-scoped PR verify selection: "self + one surrounding layer".
 *
 * Each domain is split into layers (frontend, backend, storage, cli, sdk).
 * A changed path maps to (domain, layer). We run that layer's suites plus the
 * suites of every adjacent layer in the SAME domain:
 *
 *   frontend ── backend ── storage
 *                 ├── cli
 *                 └── sdk
 *
 * So a Console Deployments page change runs the Deployments Console unit/e2e
 * plus the deployments backend tests; a deployments route/service change runs
 * the backend tests plus its direct consumers (Console, CLI, SDK) and its
 * direct dependency (storage/persistence). Nothing outside the domain runs.
 *
 * Shared plumbing (Console shell/api client, E2E harness, main-node host)
 * selects the frontend+backend layers of every domain. All suites use the
 * mock model only; none needs a real LLM.
 *
 * Usage:
 *   git diff --name-only BASE...HEAD | node scripts/ci-console-e2e-scope.mjs [--write-github-output]
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const NEIGHBORS = {
  frontend: ["backend"],
  backend: ["frontend", "storage", "cli", "sdk"],
  storage: ["backend"],
  cli: ["backend"],
  sdk: ["backend"],
};

const MAIN_NODE_ROUTE =
  "pnpm --filter @open-managed-agents/main-node exec vitest run --config vitest.config.ts test/managed-agents-route.test.ts";
const CONSOLE_UNIT = (files) => `pnpm --filter managed-agents-console exec vitest run ${files}`;

/**
 * layer → { paths: RegExp[], cmds?: string[], local?: string[], cert?: string[] }
 * `local` / `cert` are Playwright specs (frontend layer only).
 */
export const DOMAINS = {
  deployments: {
    frontend: {
      paths: [
        /^apps\/console\/src\/pages\/(Deployment|deployments\/)/,
        /^test\/e2e\/(deployed-)?console-deployments\.spec\.ts$/,
      ],
      cmds: [CONSOLE_UNIT("src/pages/Deployments.test.tsx src/lib/managed-api.contract.test.ts")],
      local: ["test/e2e/console-deployments.spec.ts"],
      cert: ["test/e2e/deployed-console-deployments.spec.ts"],
    },
    backend: {
      paths: [
        /^packages\/managed-agents-(api|app)\/(src|test)\/.*deployment/i,
        /^packages\/deployment-(store|run-store)\/(src|test)\//,
        /^apps\/main-node\/src\/.*deployment/i,
      ],
      cmds: [
        "pnpm exec vitest run --config vitest.config.ts packages/managed-agents-api/test/deployments.contract.test.ts packages/managed-agents-app/test/deployments-module.test.ts",
        MAIN_NODE_ROUTE,
      ],
    },
    storage: {
      paths: [
        /^packages\/deployment-(store|run-store)-(sql|memory)\//,
        /^packages\/managed-agents-adapters-sql\/(src|test)\/.*deployment/i,
      ],
      cmds: [
        "pnpm --filter @open-managed-agents/deployment-store-sql --filter @open-managed-agents/deployment-run-store-sql --filter @open-managed-agents/deployment-run-store-memory test",
        "pnpm --filter @open-managed-agents/managed-agents-adapters-sql exec vitest run --config vitest.config.ts test/deployments-sql-persistence.test.ts test/deployment-runs-sql-persistence.test.ts test/deployment-dependency-sql-sources.test.ts",
      ],
    },
    cli: {
      // Deployment commands live in the CLI entrypoint; no per-domain file split.
      paths: [/^packages\/cli\/src\/.*deployment/i],
      cmds: ["pnpm --filter @openma/cli test"],
    },
    sdk: {
      // The SDK has no deployments surface yet; nothing to select.
      paths: [/^packages\/sdk\/src\/.*deployment/i],
      cmds: [],
    },
  },
  agents: {
    frontend: {
      paths: [/^apps\/console\/src\/pages\/(Agent|agents\/)/],
      cmds: [CONSOLE_UNIT("src/pages/agents")],
      cert: ["test/e2e/deployed-console.spec.ts"],
    },
    backend: { paths: [/^packages\/managed-agents-(api|app)\/src\/.*agent/i], cmds: [MAIN_NODE_ROUTE] },
  },
  sessions: {
    frontend: {
      paths: [/^apps\/console\/src\/pages\/(Session|session-detail\/)/],
      cert: ["test/e2e/deployed-console.spec.ts"],
    },
    backend: { paths: [/^packages\/managed-agents-(api|app)\/src\/.*session/i], cmds: [MAIN_NODE_ROUTE] },
  },
  auth: {
    frontend: {
      paths: [/^apps\/console\/src\/pages\/(Login|Signup|Verify)/, /^test\/e2e\/console\.spec\.ts$/],
      local: ["test/e2e/console.spec.ts"],
      cert: ["test/e2e/deployed-console.spec.ts"],
    },
    backend: { paths: [/^packages\/auth\//], cmds: ["pnpm --filter @open-managed-agents/auth test"] },
  },
  settings: {
    // API keys, model cards, skills, dashboard, navigation smoke.
    frontend: {
      paths: [/^apps\/console\/src\/pages\/(ApiKeys|ModelCards|Skills|Dashboard)/, /^apps\/console\/src\/pages\//],
      local: ["test/e2e/console.spec.ts"],
    },
  },
};

const SHARED = [
  /^playwright\.config\.ts$/,
  /^scripts\/(local-release-certification|ci-console-e2e-scope)\.mjs$/,
  /^test\/e2e\/(start-local-backend\.sh|support\/)/,
  /^test\/e2e\/deployed-console\.spec\.ts$/,
  /^apps\/console\/(package\.json|vite\.config\.ts|index\.html)$/,
  /^apps\/console\/src\/(main|App)\.tsx$/,
  /^apps\/console\/src\/(components|lib|i18n|styles)/,
  /^apps\/main-node\/src\//,
];

/** @returns {Array<[string, string]>} [domain, layer] hits */
export function hitsForPath(p) {
  const path = p.trim();
  if (!path) return [];
  const hits = [];
  for (const [domain, layers] of Object.entries(DOMAINS)) {
    for (const [layer, def] of Object.entries(layers)) {
      if (def.paths.some((re) => re.test(path))) hits.push([domain, layer]);
    }
  }
  // First matching domain wins for console pages (settings is the catch-all).
  const specific = hits.filter(([d]) => d !== "settings");
  if (specific.length) return specific;
  if (hits.length) return hits;
  if (SHARED.some((re) => re.test(path))) {
    return Object.keys(DOMAINS).flatMap((d) =>
      ["frontend", "backend"].filter((l) => DOMAINS[d][l]).map((l) => [d, l, "shared"]));
  }
  return [];
}

/** @param {string[]} paths */
export function selectConsoleE2E(paths) {
  /** @type {Map<string, Set<string>>} */
  const selected = new Map();
  const add = (d, l) => {
    if (!DOMAINS[d][l]) return;
    if (!selected.has(d)) selected.set(d, new Set());
    selected.get(d).add(l);
  };
  for (const p of paths) {
    for (const [d, l, shared] of hitsForPath(String(p))) {
      add(d, l);
      // Shared plumbing already selects both sides; don't fan out further.
      if (!shared) for (const n of NEIGHBORS[l]) add(d, n);
    }
  }
  const local = new Set(), cert = new Set(), cmds = new Set();
  const layers = {};
  for (const [d, ls] of [...selected].sort()) {
    layers[d] = [...ls].sort();
    for (const l of ls) {
      const def = DOMAINS[d][l];
      (def.local ?? []).forEach((s) => local.add(s));
      (def.cert ?? []).forEach((s) => cert.add(s));
      (def.cmds ?? []).forEach((c) => cmds.add(c));
    }
  }
  return {
    domains: Object.keys(layers),
    layers,
    run: Object.keys(layers).length > 0,
    local: [...local].sort(),
    cert: [...cert].sort(),
    commands: [...cmds],
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function main() {
  const write = process.argv.includes("--write-github-output");
  const argPaths = process.argv.slice(2).filter((a) => a !== "--write-github-output");
  const paths = argPaths.length ? argPaths : await readStdin();
  const r = selectConsoleE2E(paths);
  console.log(JSON.stringify(r, null, 2));
  if (write) {
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("--write-github-output requires GITHUB_OUTPUT");
    writeFileSync(out, [
      `console_e2e=${r.run}`,
      `console_domains=${r.domains.join(",")}`,
      `console_local_specs=${r.local.join(" ")}`,
      `console_cert_specs=${r.cert.join(" ")}`,
      "domain_test_commands<<__OMA_EOF__",
      ...r.commands,
      "__OMA_EOF__",
    ].join("\n") + "\n", { flag: "a" });
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry && import.meta.url === entry) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
