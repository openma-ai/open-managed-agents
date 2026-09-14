#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  certificationExitCode,
  renderCertificationSummary,
  runCertification,
  writeCertificationReport,
} from "./live-certification.mjs";

const PROBE = "scripts/cost-attribution-live-probe.ts";

const LANES = [
  {
    provider: "cost-attribution-cloudflare",
    credentialRequirements: [
      { anyOf: ["CLOUDFLARE_API_TOKEN"] },
      { anyOf: ["CLOUDFLARE_ACCOUNT_ID"] },
    ],
    command: ["pnpm", "exec", "tsx", PROBE, "cloudflare"],
  },
  {
    provider: "cost-attribution-vercel",
    credentialRequirements: [
      { anyOf: ["VERCEL_TOKEN"] },
      { anyOf: ["VERCEL_TEAM_ID"] },
    ],
    command: ["pnpm", "exec", "tsx", PROBE, "vercel"],
  },
  {
    provider: "cost-attribution-blaxel",
    credentialRequirements: [
      { anyOf: ["BL_API_KEY"] },
      { anyOf: ["BL_ACCOUNT_ID"] },
    ],
    command: ["pnpm", "exec", "tsx", PROBE, "blaxel"],
  },
];

export function defaultCostAttributionCertificationLanes() {
  return structuredClone(LANES);
}

export function runCostAttributionCertification(options = {}) {
  return runCertification({
    ...options,
    lanes: options.lanes ?? defaultCostAttributionCertificationLanes(),
    kind: "openma.cost_attribution_certification",
  });
}

export function parseCostAttributionCertificationArguments(argv) {
  const options = {
    allowMissing: false,
    reportPath: resolve("artifacts/certification/cost-attribution-certification.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--allow-missing") options.allowMissing = true;
    else if (argument === "--report") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("--report requires a value");
      options.reportPath = resolve(value);
    } else {
      throw new Error(`unknown cost attribution certification option: ${argument}`);
    }
  }
  return options;
}

export async function runCostAttributionCertificationCli({
  argv = process.argv.slice(2),
  lanes = defaultCostAttributionCertificationLanes(),
  env = process.env,
  cwd = process.cwd(),
  commit,
  execute,
  stdout = process.stdout,
  writeReport = writeCertificationReport,
} = {}) {
  const options = parseCostAttributionCertificationArguments(argv);
  const report = await runCostAttributionCertification({ lanes, env, cwd, commit, execute });
  await writeReport(report, options.reportPath);
  stdout.write(renderCertificationSummary(report));
  stdout.write(`report: ${options.reportPath}\n`);
  return certificationExitCode(report, { allowMissing: options.allowMissing });
}

const invokedPath = resolve(process.argv[1]);
/* node:coverage ignore next 8 */
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCostAttributionCertificationCli().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
