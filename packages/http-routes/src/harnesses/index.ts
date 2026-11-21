import { Hono } from "hono";
import type { HarnessCatalog } from "@open-managed-agents/api-types";

/** Shared route factory used by every supported control-plane composition. */
export function buildHarnessCatalogRoutes(catalog: () => HarnessCatalog) {
  const app = new Hono();
  app.get("/", (c) => c.json(catalog()));
  return app;
}
