import { createCostAttributionPort as createBlaxelPort } from "@open-managed-agents/cost-attribution-blaxel";
import { createCostAttributionPort as createCloudflarePort } from "@open-managed-agents/cost-attribution-cloudflare";
import { createCostAttributionPort as createVercelPort } from "@open-managed-agents/cost-attribution-vercel";
import type { CostAttributionPort, CostAttributionReport } from "@open-managed-agents/cost-attribution";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function lastCompleteUtcDay(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterday = new Date(today.getTime() - 86_400_000);
  return {
    period: { start: yesterday.toISOString().slice(0, 10), end: yesterday.toISOString().slice(0, 10), days: 1 },
  };
}

async function resolvePort(provider: string): Promise<CostAttributionPort> {
  if (provider === "cloudflare") {
    return createCloudflarePort({
      token: required("CLOUDFLARE_API_TOKEN"),
      accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    });
  }
  if (provider === "vercel") {
    return createVercelPort({
      token: required("VERCEL_TOKEN"),
      teamId: required("VERCEL_TEAM_ID"),
    });
  }
  if (provider === "blaxel") {
    return createBlaxelPort({
      token: required("BL_API_KEY"),
      accountId: required("BL_ACCOUNT_ID"),
    });
  }
  throw new Error(`Unsupported cost attribution provider: ${provider}`);
}

function scopeId(provider: string): string {
  if (provider === "cloudflare") return required("CLOUDFLARE_ACCOUNT_ID");
  if (provider === "vercel") return required("VERCEL_TEAM_ID");
  if (provider === "blaxel") return required("BL_ACCOUNT_ID");
  throw new Error(`Unsupported cost attribution provider: ${provider}`);
}

function rowCount(report: CostAttributionReport): number {
  const extended = report as CostAttributionReport & {
    focus?: { rows?: unknown[] };
    provider_usage?: { rows?: unknown[] };
    resources?: unknown[];
    items?: unknown[];
    records?: unknown[];
  };
  return extended.focus?.rows?.length
    ?? extended.provider_usage?.rows?.length
    ?? extended.resources?.length
    ?? extended.items?.length
    ?? extended.records?.length
    ?? 0;
}

async function main(): Promise<void> {
  const provider = process.argv[2];
  if (!provider) throw new Error("provider argument is required");
  const port = await resolvePort(provider);
  const { period } = lastCompleteUtcDay();
  const report = await port.report({
    period,
    scope: { type: "account", id: scopeId(provider) },
  });
  process.stdout.write([
    `provider=${provider}`,
    "status=PASS",
    `source=${report.attribution.source}`,
    `completeness=${report.attribution.data_completeness}`,
    `total_known=${String(report.total_cost !== null)}`,
    `rows=${rowCount(report)}`,
  ].join(" ") + "\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
