import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import {
  createCloudflareCostAttributionPort,
  recentCostPeriod,
  DEFAULT_PRICING,
  mergeCfPricing,
  type CfPricing,
} from "@open-managed-agents/cost-attribution-cloudflare";

const PRICING_KV_KEY = "system:cf_pricing";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string; services: Services } }>();

app.use("*", async (c, next) => {
  const authorization = c.req.header("authorization") ?? "";
  const supplied = c.req.header("x-api-key")
    ?? (authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "");
  if (!c.env.API_KEY || supplied !== c.env.API_KEY) {
    return c.json(
      { error: "Operator API key required for account-scoped cost reports" },
      403,
    );
  }
  return next();
});

export interface ResolveCloudflareCostReportOptions {
  accountId: string;
  token: string;
  days: number;
  pricingJson: string | null;
  fetch?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
}

export async function resolveCloudflareCostReport(
  options: ResolveCloudflareCostReportOptions,
) {
  const now = options.now;
  const pricing = mergeCfPricing(
    DEFAULT_PRICING,
    options.pricingJson ? JSON.parse(options.pricingJson) : {},
  );
  const costAttribution = createCloudflareCostAttributionPort({
    accountId: options.accountId,
    token: options.token,
    pricing,
    fetch: options.fetch,
    now: now ? () => now : undefined,
  });
  return costAttribution.report({
    period: recentCostPeriod(options.days, now),
    scope: { type: "account", id: options.accountId },
    signal: options.signal,
  });
}

app.get("/", async (c) => {
  const token = c.env.CLOUDFLARE_API_TOKEN;
  const accountId = c.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) {
    return c.json({ error: "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" }, 501);
  }

  const days = Math.min(90, Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30));

  const report = await resolveCloudflareCostReport({
    accountId,
    token,
    days,
    pricingJson: await c.var.services.kv.get(PRICING_KV_KEY),
    signal: c.req.raw.signal,
  });
  return c.json(report);
});

app.get("/pricing", async (c) => {
  const stored = await c.var.services.kv.get(PRICING_KV_KEY);
  return c.json({
    source: stored ? "custom" : "default",
    pricing: mergeCfPricing(DEFAULT_PRICING, stored ? JSON.parse(stored) : {}),
  });
});

app.put("/pricing", async (c) => {
  const body = await c.req.json<unknown>();
  const stored = await c.var.services.kv.get(PRICING_KV_KEY);
  const current = mergeCfPricing(
    DEFAULT_PRICING,
    stored ? JSON.parse(stored) : {},
  );
  let pricing: CfPricing;
  try {
    pricing = mergeCfPricing(current, body);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "Invalid Cloudflare pricing",
    }, 400);
  }

  await c.var.services.kv.put(PRICING_KV_KEY, JSON.stringify(pricing));
  return c.json({ pricing });
});

app.delete("/pricing", async (c) => {
  await c.var.services.kv.delete(PRICING_KV_KEY);
  return c.json({ pricing: DEFAULT_PRICING, source: "default" });
});

export default app;
